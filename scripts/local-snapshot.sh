#!/bin/sh
set -eu

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

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has tracked changes; refusing scheduled update."
  exit 1
fi

git fetch origin main
git merge --ff-only origin/main
npm run collect
npm run check
git add data/latest.json

if git diff --cached --quiet; then
  echo "No snapshot change."
  exit 0
fi

git commit -m "chore: refresh local AI usage snapshot"
git push origin HEAD:main
