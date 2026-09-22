#!/usr/bin/env bash
# Release the plugin: verify, bump, commit, push both branches, reinstall.
#
#   npm run deploy -- <message-file>
#
# Every release is the next patch. Stops at the first failure and leaves the
# tree as it was found, so a failed build or suite never half-releases. Run it
# from anywhere; it works on the repository it lives in.
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

BRANCH=$(git rev-parse --abbrev-ref HEAD)
# codex-director is what the marketplace serves. Fast-forward only: a diverged
# branch means someone released from elsewhere, and overwriting that is not
# this script's call.
git fetch -q origin
if ! git merge-base --is-ancestor origin/codex-director HEAD; then
  echo "codex-director has diverged from $BRANCH; reconcile it by hand" >&2
  exit 1
fi

# Build first: it is the only place the hooks are type-checked, and it is cheap
# next to the suite.
echo "── build"
$RUN npm run --silent build

echo "── test"
$RUN npm test

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

echo
echo "$(git log --oneline -1)"
echo "Restart Claude Code to pick up $VERSION."
