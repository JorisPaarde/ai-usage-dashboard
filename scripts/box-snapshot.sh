#!/usr/bin/env bash
# Steady-state collect+publish on the Linux box: deterministic Node only.
# No LLM, cloud agent, or browser-bot belongs in this loop.
# See PLAN.md and docs/SCHEDULE.md.
#
# Auth: the box's existing `gh` login over HTTPS (credential helper).
# One-time on the box: `gh auth login` and `gh auth setup-git`.
# No token env vars for GitHub; never put credentials in a remote URL or log.
# Cron is set up by the server owner — this script does not install cron.
set -euo pipefail

# codex often lives in ~/.local/bin; cron PATH is otherwise minimal.
PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
export PATH

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCKFILE="$ROOT/.box-snapshot.lock"

# flock releases on exit (including SIGKILL of this process after reboot leaves
# no stale mkdir-lock directory).
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "Another box snapshot run is active; skipping."
  exit 0
fi

cd "$ROOT"

ENV_FILE="${AI_USAGE_ENV_FILE:-$HOME/.config/ai-usage-dashboard/env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Setup token for Claude (cron has no login profile). Never print the value.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$HOME/.claude-oauth-token" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(tr -d '\r\n' < "$HOME/.claude-oauth-token")
  export CLAUDE_CODE_OAUTH_TOKEN
fi

echo "=== box snapshot run $(date -u +%Y-%m-%dT%H:%M:%SZ) in $ROOT ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "box-snapshot.sh must run on main (checked out: ${CURRENT_BRANCH})." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH ($PATH)." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to commit and push." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required (HTTPS credential helper for git push)." >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for the snapshot lock." >&2
  exit 1
fi

# Fail clearly when the box is not logged in to GitHub.
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not logged in on this host. Run: gh auth login" >&2
  gh auth status >&2 || true
  exit 1
fi

# latest.json and routing.json are this job's paired outputs. A failed run may
# leave either dirty; discard only those generated paths before checking that
# no other work is present.
for output in data/latest.json data/routing.json; do
  if ! git diff --quiet -- "$output" || ! git diff --cached --quiet -- "$output"; then
    echo "Discarding leftover $output from a prior run."
    git restore --source=HEAD --staged --worktree -- "$output"
  fi
done

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has tracked changes; refusing scheduled update." >&2
  exit 1
fi

# Dedicated meter checkout: hard-reset to origin/main so a rejected push cannot
# leave the tree permanently ahead of / diverged from remote.
git fetch origin main
git reset --hard origin/main

if ! npm run collect || ! npm run routing; then
  echo "snapshot generation failed; restoring generated outputs." >&2
  git restore --source=HEAD --staged --worktree -- data/latest.json data/routing.json
  exit 1
fi
if ! npm run check; then
  echo "check failed; restoring generated outputs so the next interval can retry." >&2
  git restore --source=HEAD --staged --worktree -- data/latest.json data/routing.json
  exit 1
fi

git add data/latest.json data/routing.json

if git diff --cached --quiet; then
  echo "No snapshot change."
  exit 0
fi

git commit -m "chore: refresh box AI usage snapshot"
git push origin HEAD:main
echo "Pushed data/latest.json and data/routing.json to origin/main."
