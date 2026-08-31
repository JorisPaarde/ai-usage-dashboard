#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="nl.jpwebcreation.ai-usage-dashboard"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/AIUsageDashboard"
PLIST="$AGENT_DIR/$LABEL.plist"

mkdir -p "$AGENT_DIR" "$LOG_DIR"
sed "s|__REPO__|$ROOT|g; s|__HOME__|$HOME|g" \
  "$ROOT/docs/$LABEL.plist.example" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "Installed $PLIST (09:00 and 16:00 local time)."
