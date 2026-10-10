# AI Usage Dashboard

Operational static dashboard for **OpenAI (ChatGPT/Codex)**, **Claude Code**,
**OpenRouter**, and **Sail Research**. Vanilla HTML/CSS/JS front end; Node
standard-library collector. No npm dependencies.

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
| **Local app** (`npm run app`) | Same refresh, plus `POST /api/collect` when a local collect helper is available. |

Never uses Codex, Grok, cloud agents, or browser bots as the Update button path.

## Steady-state loop (no human, no AI agent)

1. On the Linux box (signed in to Codex/Claude/`gh`): clone this repo and ensure
   `gh auth status` succeeds.
2. Owner-managed cron runs `scripts/box-snapshot.sh`: collect → commit
   `data/latest.json` only when it changed → `git push` via existing `gh` login.
3. GitHub Pages rebuilds from that commit. Hosted runners **never** measure
   authenticated usage.

## Why the page shows “unavailable”

Most vendors do not expose public usage meters. Unavailable sources stay
unavailable — never fabricated. Claude plan % uses local OAuth when present
(Haiku header probe only on 403); OpenRouter and Sail Research use official
Usage APIs when `OPENROUTER_API_KEY` / `SAIL_API_KEY` are present in
`~/.config/ai-usage-dashboard/env`.

## What you see

Each source is **measured**, **estimated**, or **unavailable**, plus a
**live / handmatig** badge. Usage vs limit, Amsterdam reset times, and compact
daily history. No dagtempo/maandtempo. Local share stays unavailable until
routing is runtime-proven.

## Collector

Isolated adapters in `collector/adapters/`. Output: `data/latest.json`. No LLM
calls in the Update button path. Codex `app-server` is read-only for OpenAI
rate limits (no model, no tokens). OpenRouter headline is account balance from
`/credits`. Sail uses the official Usage API (see
[`docs/PREPAID.md`](docs/PREPAID.md)).

## Schedule

Details in [`docs/SCHEDULE.md`](docs/SCHEDULE.md).

## Privacy

Committed and published data is public-safe only. Do not commit `.env`, API
keys, account exports, or `data/local-overrides.json`.

## Box online badge

The header badge is an honest signal from `generatedAt` only (box snapshot age).
**Box online** if the snapshot is within ~20 minutes; otherwise
**Box offline**. Tooltip shows last collect in Europe/Amsterdam.
No ping endpoint and no secrets on the page.

## Version

`1.8.0`
