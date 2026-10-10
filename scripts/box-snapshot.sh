#!/usr/bin/env bash
# Steady-state collect+publish on the Linux box: deterministic Node only.
# No LLM, cloud agent, or browser-bot belongs in this loop.
# See PLAN.md and docs/SCHEDULE.md.
#
# Auth: the box's existing `gh` login over HTTPS (credential helper).
# No token env vars; never put credentials in a remote URL or log output.
# Cron is set up by the server owner — this script does not install cron.
set -euo pipefail

PATH="/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
export PATH

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/.box-snapshot.lock"
BRANCH="${AI_USAGE_GH_BRANCH:-main}"
SNAPSHOT_PATH="data/latest.json"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another box snapshot run is active; skipping."
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

cd "$ROOT"

ENV_FILE="${AI_USAGE_ENV_FILE:-$HOME/.config/ai-usage-dashboard/env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

echo "=== box snapshot run $(date -u +%Y-%m-%dT%H:%M:%SZ) in $ROOT ==="

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH ($PATH)." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to commit and push ${SNAPSHOT_PATH}." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required (HTTPS credential helper for git push)." >&2
  exit 1
fi

# Fail clearly when the box is not logged in to GitHub.
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not logged in on this host. Run: gh auth login" >&2
  gh auth status >&2 || true
  exit 1
fi

# Ensure git HTTPS uses the existing gh login (no tokens handled here).
gh auth setup-git >/dev/null 2>&1 || true

# A failed prior run may leave latest.json dirty; discard only that generated
# path before checking that no other agent work is present.
if ! git diff --quiet -- "$SNAPSHOT_PATH" || ! git diff --cached --quiet -- "$SNAPSHOT_PATH"; then
  echo "Discarding leftover ${SNAPSHOT_PATH} from a prior run."
  git restore --source=HEAD --staged --worktree -- "$SNAPSHOT_PATH"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has tracked changes; refusing scheduled update." >&2
  exit 1
fi

if ! npm run collect; then
  echo "snapshot generation failed; restoring generated output." >&2
  git restore --source=HEAD --staged --worktree -- "$SNAPSHOT_PATH" 2>/dev/null || true
  exit 1
fi

if [ ! -f "$ROOT/$SNAPSHOT_PATH" ]; then
  echo "Expected ${SNAPSHOT_PATH} after collect; refusing to push." >&2
  exit 1
fi

git add -- "$SNAPSHOT_PATH"

if git diff --cached --quiet -- "$SNAPSHOT_PATH"; then
  echo "No snapshot change."
  exit 0
fi

git commit -m "chore: refresh box AI usage snapshot"
git push origin "HEAD:${BRANCH}"
echo "Pushed ${SNAPSHOT_PATH} to origin/${BRANCH}."
