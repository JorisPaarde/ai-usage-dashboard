# AI Usage Dashboard

Operational static dashboard for **OpenAI/Buzz**, **Cursor Agent**, **Claude Code**,
**Ollama**, and **Enrich Labs / Helena**. Vanilla HTML/CSS/JS front end; Node
standard-library collector. No npm dependencies.

See [`PLAN.md`](PLAN.md) for the unattended-collect roadmap and backlog issues.

## Quick start

```bash
npm test
npm run build
npm run collect   # local adapters (+ optional overrides) → data/latest.json
```

Serve `dist/` as static files. For GitHub Pages, push to `main`/`master` — see
`.github/workflows/pages.yml`.

## Steady-state loop (no human, no AI agent)

1. Install once on the Mac that is signed in to the tools:
   `./scripts/install-launch-agent.sh`
2. Every **15 minutes** the LaunchAgent runs `scripts/local-snapshot.sh`:
   collect → check → commit `data/latest.json` → push `main`.
3. GitHub Pages rebuilds from that commit. Hosted runners **never** measure
   authenticated desktop usage.

Cursor cloud agents may plan and implement changes. They must **not** sit in
the scheduled collect/publish path.

## Why the page shows “unavailable”

Most vendors do not expose public usage meters. The seed snapshot and
GitHub-hosted validate keep those sources **unavailable** on purpose — never
fabricated. Claude plan % is read automatically from the local Claude.ai OAuth
token when present; Enrich Labs / Helena still needs a verified meter
([issue #10](https://github.com/JorisPaarde/ai-usage-dashboard/issues/10)).
Until then, optional `data/local-overrides.json` (gitignored) can hold a
hand reading. Only the sanitized aggregate in `data/latest.json` is published.

## What you see

Each source is distinctly **measured**, **estimated**, or **unavailable**,
plus a **live / handmatig** collection badge. Usage vs limit, Amsterdam reset
times, pace, and compact daily history. Enrich monthly budget is **200**
credits (public Starter operating target; weekly pace max **50**). A separate
**Local share** card stays unavailable until routing is runtime-proven.

## Collector

Isolated adapters in `collector/adapters/`. Output: `data/latest.json`. No LLM
calls. Cursor reads the signed-in IDE session token; Codex uses the local
app-server; Claude uses OAuth usage + local transcripts; Ollama reads logs.
Build and collect fail closed on dishonest records or secret-looking payloads.

## Schedule

Details in [`docs/SCHEDULE.md`](docs/SCHEDULE.md).

## Privacy

Committed and published data is public-safe only. Do not commit `.env`, API
keys, account exports, or `data/local-overrides.json`.

## Version

`1.4.1`
