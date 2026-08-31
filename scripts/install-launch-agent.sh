#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="nl.jpwebcreation.ai-usage-dashboard"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/AIUsageDashboard"
PLIST="$AGENT_DIR/$LABEL.plist"

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH; install Node 20+ before installing the agent." >&2
  exit 1
fi

# launchd does not inherit the login shell's PATH. Pin the directory that owns
# the Node we just resolved, then the usual system locations.
AGENT_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$AGENT_DIR" "$LOG_DIR"
sed "s|__REPO__|$ROOT|g; s|__HOME__|$HOME|g; s|__PATH__|$AGENT_PATH|g" \
  "$ROOT/docs/$LABEL.plist.example" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "Installed $PLIST (every 15 minutes)."
echo "Repo:  $ROOT"
echo "PATH:  $AGENT_PATH"
echo "Logs:  $LOG_DIR"
