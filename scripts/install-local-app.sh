#!/bin/sh
set -eu

# Optional local HTTP app (127.0.0.1:8787) so "Alles updaten" can trigger
# LaunchAgent / local-snapshot without a terminal — NEVER Codex/Grok/agent.
# Does not replace the 15-minute collector agent.
# GitHub Pages cannot call this server (HTTPS mixed-content block).

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="nl.jpwebcreation.ai-usage-dashboard-app"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/AIUsageDashboard"
PLIST="$AGENT_DIR/$LABEL.plist"

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH; install Node 20+ first." >&2
  exit 1
fi

AGENT_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$AGENT_DIR" "$LOG_DIR" "$ROOT/dist"
# Ensure dist exists so the app server has something to serve.
(cd "$ROOT" && "$NODE_BIN" scripts/build.js) || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/scripts/local-app-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$AGENT_PATH</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/app-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/app-stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "Installed $PLIST (local app on http://127.0.0.1:8787/)."
echo "Open that URL for on-demand Alles updaten (LaunchAgent collect)."
echo "Pages (github.io) only re-fetches latest.json — it cannot reach this server."
