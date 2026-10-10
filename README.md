# AI Usage Dashboard

Operational static dashboard for **OpenAI (ChatGPT/Codex)**, **Cursor Agent**,
**Grok Bot**, **Claude Code**, **OpenRouter**, and **Sail Research**. Vanilla
HTML/CSS/JS front end; Node standard-library collector. No npm dependencies.

See [`PLAN.md`](PLAN.md) for the unattended-collect roadmap and backlog issues.

## Quick start

```bash
npm test
npm run build
npm run collect      # box adapters + merge mac-sources → data/latest.json
npm run collect:mac  # Mac-only → data/mac-sources.json
```

Serve `dist/` as static files. For GitHub Pages, push to `main`/`master` — see
`.github/workflows/pages.yml`.

## “Alles updaten” button

On GitHub Pages the button re-fetches published `data/latest.json` (cache-bust)
and redraws. It does **not** re-measure vendors. Measurement runs on the box
cron and the Mac LaunchAgent.

Never uses Codex, Grok, cloud agents, or browser bots as the Update button path.

## Split meter (box + Mac)

1. **Linux box** — `scripts/box-snapshot.sh` every 15 minutes: collect box
   sources, merge `data/mac-sources.json` (Cursor + Grok Bot keep their own
   `measuredAt`; mark **stale** if older than 2 hours), push `data/latest.json`.
2. **Mac** — LaunchAgent runs `scripts/mac-snapshot.sh` every 15 minutes:
   collect Cursor Agent + Grok Bot only, push **only** `data/mac-sources.json`
   (never `latest.json`).

### Box install

```cron
CRON_TZ=Europe/Amsterdam
*/15 * * * * cd /path/to/ai-usage-dashboard && ./scripts/box-snapshot.sh
```

One-time: `gh auth login` && `gh auth setup-git`. Optional env file:
`cp docs/env.example ~/.config/ai-usage-dashboard/env && chmod 600 …`.

### Mac LaunchAgent install

Repo path on the owner Mac:

`/Users/jorispaardekooper/.buzz/REPOS/ai-usage-dashboard-scheduler`

Label: `nl.jpwebcreation.ai-usage-dashboard`

```bash
REPO="/Users/jorispaardekooper/.buzz/REPOS/ai-usage-dashboard-scheduler"
cd "$REPO"
git pull origin main

# Ensure node/npm resolve (Homebrew example)
eval "$(/opt/homebrew/bin/brew shellenv)"
NODE_PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p ~/Library/LaunchAgents ~/Library/Logs/AIUsageDashboard
sed -e "s|__REPO__|${REPO}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|${NODE_PATH}|g" \
    docs/nl.jpwebcreation.ai-usage-dashboard.plist.example \
  > ~/Library/LaunchAgents/nl.jpwebcreation.ai-usage-dashboard.plist

launchctl unload ~/Library/LaunchAgents/nl.jpwebcreation.ai-usage-dashboard.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/nl.jpwebcreation.ai-usage-dashboard.plist

# Smoke once
./scripts/mac-snapshot.sh
tail -n 50 ~/Library/Logs/AIUsageDashboard/stdout.log
```

Requires Cursor signed in on that Mac (token from local IDE state DB). The
access token is never logged or committed.

## Why the page shows “unavailable”

Most vendors do not expose public usage meters. Unavailable sources stay
unavailable — never fabricated. Cursor / Grok Bot need the Mac LaunchAgent.
Claude plan % uses local OAuth when present; OpenRouter and Sail Research use
official Usage APIs when keys are present in `~/.config/ai-usage-dashboard/env`.

## What you see

Each source is **measured**, **estimated**, or **unavailable**, plus a
**live / handmatig / verouderd** badge. Usage vs limit, Amsterdam reset times,
and compact daily history. Mac-merged meters show age; after 2 hours they are
marked stale. Local share stays unavailable until routing is runtime-proven.

## Collector

Isolated adapters in `collector/adapters/`. Box output: `data/latest.json`.
Mac output: `data/mac-sources.json`. No LLM calls in the Update button path.

## Schedule

Details in [`docs/SCHEDULE.md`](docs/SCHEDULE.md). Plist template:
[`docs/nl.jpwebcreation.ai-usage-dashboard.plist.example`](docs/nl.jpwebcreation.ai-usage-dashboard.plist.example).

## Privacy

Committed and published data is public-safe only. Do not commit `.env`, API
keys, account exports, or `data/local-overrides.json`. Cursor IDE tokens stay
on the Mac.

## Box online badge

The header badge is an honest signal from `generatedAt` only (box snapshot age).
**Box online** if the snapshot is within ~20 minutes; otherwise
**Box offline**. Tooltip shows last collect in Europe/Amsterdam.

## Version

`1.9.0`
