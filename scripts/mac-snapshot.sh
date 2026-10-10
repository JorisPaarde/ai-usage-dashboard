#!/bin/sh
# Steady-state Mac collect+publish for Cursor Agent + Grok Bot only.
# Writes data/mac-sources.json — never touches data/latest.json (box owns that).
# Intended for a macOS LaunchAgent every 15 minutes.
# See PLAN.md and docs/SCHEDULE.md.
set -eu

# launchd starts with a minimal PATH and does not inherit Homebrew's Node path.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/.mac-snapshot.lock"

# mkdir is the portable flock-equivalent on macOS (no flock(1) by default).
# shlock is an alternative when present; mkdir wins for simplicity + trap cleanup.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another mac snapshot run is active; skipping."
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

echo "=== mac snapshot run $(date -u +%Y-%m-%dT%H:%M:%SZ) in $ROOT ==="

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH ($PATH); reinstall the LaunchAgent." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to commit and push." >&2
  exit 1
fi

# Discard leftover Mac output only; never touch data/latest.json.
if ! git diff --quiet -- data/mac-sources.json || ! git diff --cached --quiet -- data/mac-sources.json; then
  echo "Discarding leftover data/mac-sources.json from a prior run."
  git restore --source=HEAD --staged --worktree -- data/mac-sources.json 2>/dev/null || true
fi

# Refuse if other tracked work is dirty (including latest.json edits).
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has tracked changes; refusing scheduled Mac update." >&2
  exit 1
fi

# Sync to origin/main so we do not race the box's latest.json / routing pushes.
git fetch origin main
git reset --hard origin/main

if ! npm run collect:mac; then
  echo "mac-sources generation failed; restoring." >&2
  git restore --source=HEAD --staged --worktree -- data/mac-sources.json 2>/dev/null || true
  exit 1
fi

# Hermetic unit tests + build against committed latest.json (must not read real
# Cursor DB / Codex / tokens). Fail closed and leave mac-sources uncommitted.
if ! npm run check; then
  echo "check failed; restoring data/mac-sources.json so the next interval can retry." >&2
  git restore --source=HEAD --staged --worktree -- data/mac-sources.json 2>/dev/null || true
  exit 1
fi

# Guarantee we never stage latest.json from this job.
git restore --source=HEAD --worktree -- data/latest.json 2>/dev/null || true
git add data/mac-sources.json

if git diff --cached --quiet; then
  echo "No mac-sources change."
  exit 0
fi

# Abort if anything other than mac-sources snuck into the index.
STAGED=$(git diff --cached --name-only)
case "$STAGED" in
  data/mac-sources.json) ;;
  *)
    echo "Refusing to commit unexpected paths from mac-snapshot: $STAGED" >&2
    git reset HEAD -- . >/dev/null 2>&1 || true
    exit 1
    ;;
esac

git commit -m "chore: refresh Mac AI usage sources"

# Push with rebase retry to absorb concurrent box pushes of latest.json.
PUSH_OK=0
i=1
while [ "$i" -le 4 ]; do
  if git push origin HEAD:main; then
    PUSH_OK=1
    break
  fi
  echo "push rejected (attempt $i); fetch + rebase onto origin/main and retry."
  git fetch origin main
  git rebase origin/main
  i=$((i + 1))
done

if [ "$PUSH_OK" -ne 1 ]; then
  echo "mac-snapshot push failed after retries." >&2
  exit 1
fi

echo "Pushed data/mac-sources.json to origin/main."
