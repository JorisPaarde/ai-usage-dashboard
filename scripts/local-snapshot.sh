#!/bin/sh
set -eu

# Steady-state collect+publish: deterministic Node only.
# No LLM, cloud agent, Grok Bot, or browser-bot belongs in this loop.
# See PLAN.md and docs/SCHEDULE.md.

# launchd starts with a minimal PATH and does not inherit Homebrew's Node path.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/.local-snapshot.lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another local snapshot run is active; skipping."
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT INT TERM

cd "$ROOT"

echo "=== local snapshot run $(date -u +%Y-%m-%dT%H:%M:%SZ) in $ROOT ==="

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH ($PATH); reinstall the launch agent." >&2
  exit 1
fi

# data/latest.json is this job's output. A prior collect that failed check
# leaves it dirty; refusing forever then freezes live generatedAt. Discard
# that path first. Any other dirty tracked file still means "agent worktree
# — do not schedule".
if ! git diff --quiet -- data/latest.json || ! git diff --cached --quiet -- data/latest.json; then
  echo "Discarding leftover data/latest.json from a prior run."
  git restore --source=HEAD --staged --worktree -- data/latest.json
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has tracked changes; refusing scheduled update."
  exit 1
fi

git fetch origin main
git merge --ff-only origin/main
npm run collect
if ! npm run check; then
  echo "check failed; restoring data/latest.json so the next interval can retry." >&2
  git restore --source=HEAD --staged --worktree -- data/latest.json
  exit 1
fi
git add data/latest.json

if git diff --cached --quiet; then
  echo "No snapshot change."
  exit 0
fi

git commit -m "chore: refresh local AI usage snapshot"
git push origin HEAD:main
