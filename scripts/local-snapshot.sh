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

ENV_FILE="${AI_USAGE_ENV_FILE:-$HOME/.config/ai-usage-dashboard/env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

echo "=== local snapshot run $(date -u +%Y-%m-%dT%H:%M:%SZ) in $ROOT ==="

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH ($PATH); reinstall the launch agent." >&2
  exit 1
fi

# latest.json and routing.json are this job's paired outputs. A failed run may
# leave either dirty; discard only those generated paths before checking that
# no agent work is present.
for output in data/latest.json data/routing.json; do
  if ! git diff --quiet -- "$output" || ! git diff --cached --quiet -- "$output"; then
    echo "Discarding leftover $output from a prior run."
    git restore --source=HEAD --staged --worktree -- "$output"
  fi
done

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has tracked changes; refusing scheduled update."
  exit 1
fi

git fetch origin main
git merge --ff-only origin/main
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

git commit -m "chore: refresh local AI usage snapshot"
git push origin HEAD:main
