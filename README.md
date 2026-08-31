# AI Usage Dashboard

Operational static dashboard for **OpenAI/Buzz**, **Cursor Agent**, **Claude Code**, **Ollama**, and **Enrich Labs**. Vanilla HTML/CSS/JS front end; Node standard-library collector. No npm dependencies.

## Quick start

```bash
npm test
npm run build
npm run collect   # local adapters (+ optional overrides) → data/latest.json
```

Serve `dist/` as static files. For GitHub Pages, push to `main`/`master` — see `.github/workflows/pages.yml`.

## Why the page shows “unavailable”

Most vendors do not expose public usage meters. The seed snapshot and
GitHub-hosted collect keep those sources **unavailable** on purpose — never
fabricated. To show numbers you read from an authenticated desktop or browser
UI, copy `data/local-overrides.example.json` to `data/local-overrides.json`
(gitignored), fill measured/estimated values, then `npm run collect`. Only the
sanitized aggregate in `data/latest.json` is published; the override file never
enters `dist/`.

## What you see

Each source is distinctly **measured**, **estimated**, or **unavailable**
(schema status `unknown`), with usage vs limit, reset date, last update, pace,
and compact daily history. Enrich monthly budget is **200** credits (public
Starter operating target; weekly pace max **50**).

## Collector

Isolated adapters in `collector/adapters/`. Output: `data/latest.json`. No LLM
calls. Ollama may report **measured** loopback reachability; other sources stay
unavailable until a public-safe export or local override is supplied. Build and
collect fail closed on dishonest records or secret-looking payloads.

## Schedule

Local LaunchAgent collects every **15 minutes** (LLM-free). Open dashboards
soft-refresh every **5 minutes**. GitHub Actions still gate CET/CEST UTC
candidates to **09:00** and **16:00** `Europe/Amsterdam` — details in
[`docs/SCHEDULE.md`](docs/SCHEDULE.md).

## Privacy

Committed and published data is public-safe only. Do not commit `.env`, API
keys, account exports, or `data/local-overrides.json`.

## Version

`1.3.0`
