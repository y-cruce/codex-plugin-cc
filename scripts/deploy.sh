#!/usr/bin/env bash
# Release the plugin: build, bump, commit, push both branches, reinstall.
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
# codex-director is what the marketplace serves. Fast-forward only: a diverged
# branch means someone released from elsewhere, and overwriting that is not
# this script's call.
git fetch -q origin
if ! git merge-base --is-ancestor origin/codex-director HEAD; then
  echo "codex-director has diverged from $BRANCH; reconcile it by hand" >&2
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
git branch -f codex-director HEAD
git push -q origin codex-director

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

echo
echo "$(git log --oneline -1)"
echo "Restart Claude Code to pick up $VERSION."
