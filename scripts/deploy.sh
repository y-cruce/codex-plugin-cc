#!/usr/bin/env bash
# Release the plugin: build, bump, commit, push the working branch and main, reinstall.
#
#   npm run deploy -- <message-file>
#
# Every release is the next patch. Stops at the first failure and leaves the
# tree as it was found, so a failed build never half-releases. The suite is not
# run here: it runs once after a change is finished, and a slow process spawn
# on this machine should not hold a release. Run it from anywhere; it works on
# the repository it lives in.
set -euo pipefail

MESSAGE=${1:-}
if [ -z "$MESSAGE" ]; then
  echo "usage: npm run deploy -- <message-file>" >&2
  exit 1
fi
[ -f "$MESSAGE" ] || { echo "no such message file: $MESSAGE" >&2; exit 1; }

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO"

VERSION=$(node -p "const [a,b,c]=require('./package.json').version.split('.'); [a,b,Number(c)+1].join('.')")

# The session injects these, and the state-directory tests misread them.
RUN="env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH -u CLAUDECODE"

# `npm run deploy` exports the user's npm config to this script as npm_config_*
# variables. An `allow-scripts` entry is fine in ~/.npmrc -- a global install of
# Claude Code needs it -- but coming in through the environment it reads as the
# command-line flag, which npm refuses in a project-scoped install with
# EALLOWSCRIPTS. The `npm ci` that `claude plugin update` runs in the plugin's
# cache inherited it, failed, and was swallowed as a debug warning, so every
# release made through this script landed with no node_modules.
unset npm_config_allow_scripts

BRANCH=$(git rev-parse --abbrev-ref HEAD)
# main is what the marketplace serves. Fast-forward only: a diverged
# branch means someone released from elsewhere, and overwriting that is not
# this script's call.
git fetch -q origin
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "main has diverged from $BRANCH; reconcile it by hand" >&2
  exit 1
fi

# The build is the only place the hooks are type-checked.
echo "── build"
$RUN npm run --silent build

echo "── version $VERSION"
$RUN npm run --silent bump-version -- "$VERSION"

# .claude/ is Claude Code's own generated types and docs/ is session notes;
# neither belongs to the repository.
echo "── commit"
git add -A ':!.claude' ':!docs'
git commit -q -F "$MESSAGE"

echo "── push"
git push -q origin "$BRANCH"
if [ "$BRANCH" != "main" ]; then
  git push -q origin HEAD:main
fi

echo "── install"
claude plugin update codex@y-cruce-codex

# Claude Code runs `npm ci --ignore-scripts` for the plugin's dependencies and
# downgrades a failure to a debug warning, so an update that reports success can
# still leave a cache with no node_modules. The ACP driver imports its SDK at the
# top, so the next qoder dispatch dies on a missing package while the release
# looks clean. Check the copy it just installed, repair it, and prove it loads.
CACHE="${CLAUDE_HOME:-$HOME/.claude}/plugins/cache/y-cruce-codex/codex/$VERSION"
if [ ! -d "$CACHE" ]; then
  echo "no installed copy at $CACHE" >&2
  exit 1
fi
if [ ! -f "$CACHE/node_modules/.package-lock.json" ]; then
  echo "   dependencies missing; installing them into $CACHE"
  (cd "$CACHE" && npm ci --ignore-scripts)
fi
node --input-type=module -e "await import('file://$CACHE/scripts/lib/executors/acp-driver.mjs')"

# The build and the tests run the hooks in plain Node, which takes anything.
# Claude Code scans the hooks module before loading it and refuses the whole
# module on the first rule it breaks; 1.4.67 to 1.4.69 lost every Codex hook
# and tool that way while build and tests passed. One headless session against
# the copy just installed says whether it loads.
echo "── hooks load check"
CHECK=$(mktemp -d)
LIMIT=$(command -v timeout >/dev/null && echo "timeout 180" || true)
(cd "$CHECK" && $LIMIT claude -p "reply ok" --debug-file "$CHECK/debug.log" >/dev/null 2>&1) || true
if ! grep -q "cache/y-cruce-codex/codex/$VERSION/hooks/hooks.json" "$CHECK/debug.log" 2>/dev/null \
  || ! grep -q "hooks module codex@y-cruce-codex loaded" "$CHECK/debug.log"; then
  grep -E "hooks module codex@y-cruce-codex failed to load" "$CHECK/debug.log" >&2 \
    || echo "   no load of $VERSION in $CHECK/debug.log" >&2
  echo "the installed $VERSION hooks module does not load: fix it and release again" >&2
  exit 1
fi
rm -rf "$CHECK"

echo
echo "$(git log --oneline -1)"
echo "Restart Claude Code to pick up $VERSION."
