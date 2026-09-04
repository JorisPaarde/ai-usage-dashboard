# AI Usage Dashboard

Operational static dashboard for **OpenAI/Buzz**, **Cursor Agent**, **Claude Code**,
**Ollama**, **Enrich Labs / Helena**, **OpenRouter**, and **Sail Research**. Vanilla
HTML/CSS/JS front end; Node standard-library collector. No npm dependencies.

See [`PLAN.md`](PLAN.md) for the unattended-collect roadmap and backlog issues.

## Quick start

```bash
npm test
npm run build
npm run collect   # local adapters (+ optional overrides) → data/latest.json
npm run app       # optional: http://127.0.0.1:8787/ with on-demand collect button
```

Serve `dist/` as static files. For GitHub Pages, push to `main`/`master` — see
`.github/workflows/pages.yml`.

## “Alles updaten” button

| Where | What it does |
| --- | --- |
| **GitHub Pages** | Re-fetches published `data/latest.json` (cache-bust) and redraws. Does **not** re-measure vendors. |
| **Local app** (`npm run app` / `install-local-app.sh`) | Same refresh, plus `POST /api/collect` → LaunchAgent kickstart or `local-snapshot.sh`. |

Never uses Codex, Grok, cloud agents, or browser bots. Pages cannot reach the Mac localhost API over HTTPS.

## Steady-state loop (no human, no AI agent)

1. Install once on the Mac that is signed in to the tools:
   `./scripts/install-launch-agent.sh`
2. Every **15 minutes** the LaunchAgent runs `scripts/local-snapshot.sh`:
   collect → check → commit `data/latest.json` → push `main`.
3. GitHub Pages rebuilds from that commit. Hosted runners **never** measure
   authenticated desktop usage.

Optional on-demand UI: `./scripts/install-local-app.sh` → open
`http://127.0.0.1:8787/`.

## Why the page shows “unavailable”

Most vendors do not expose public usage meters. Unavailable sources stay
unavailable — never fabricated. Claude plan % uses local OAuth when present;
OpenRouter and Sail Research use official Usage APIs when
`OPENROUTER_API_KEY` / `SAIL_API_KEY` are present in
`~/.config/ai-usage-dashboard/env`; Enrich Labs / Helena is a documented hard
stop (`docs/ENRICH.md`) unless a manual override is supplied.

## What you see

Each source is **measured**, **estimated**, or **unavailable**, plus a
**live / handmatig** badge. Usage vs limit, Amsterdam reset times, and compact
daily history. No dagtempo/maandtempo. Enrich budget **200**/maand (max
**50**/week). Local share stays unavailable until routing is runtime-proven.

## Collector

Isolated adapters in `collector/adapters/`. Output: `data/latest.json`. No LLM
calls. Cursor/Codex/Claude/Ollama use local signed-in meters. OpenRouter and
Sail Research use official Usage APIs when keys are present (see
[`docs/PREPAID.md`](docs/PREPAID.md)). Codex `app-server` is read-only for
OpenAI rate limits (no model, no tokens) — it is **not** in the Update button
path.

## Schedule

Details in [`docs/SCHEDULE.md`](docs/SCHEDULE.md).

## Privacy

Committed and published data is public-safe only. Do not commit `.env`, API
keys, account exports, or `data/local-overrides.json`.

## Mac online badge

The header badge is an honest signal from `generatedAt` only (LaunchAgent
snapshot age). **Mac online** if the snapshot is within ~20 minutes; otherwise
**Mac offline / in slaap**. Tooltip shows last collect in Europe/Amsterdam.
No ping endpoint and no secrets on the page.

## Version

`1.7.0`
