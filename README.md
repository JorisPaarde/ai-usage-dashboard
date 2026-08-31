# AI Usage Dashboard

Calm static dashboard for **OpenAI/Buzz**, **Cursor Agent**, **Claude Code**, **Ollama**, and **Enrich Labs**. Vanilla HTML/CSS/JS front end; Node standard-library collector. No npm dependencies.

## Quick start

```bash
npm test
npm run build
npm run collect   # local adapters → data/latest.json
```

Serve `dist/` (or `site/` with `data/`) as static files. For GitHub Pages, push to `main`/`master` — see `.github/workflows/pages.yml`.

## What you see

Each source shows: **measured / estimated / unknown**, usage vs limit, reset date, last update, daily & monthly pace, weekly target (Enrich: max **50**/week), and compact daily history. Enrich monthly budget is **200** credits (public Starter operating target). Unavailable sources stay **Unknown** with a reason — never fabricated numbers.

## Collector

Isolated adapters in `collector/adapters/`. Output: `data/latest.json`. Ollama may report **measured** reachability on loopback; other sources stay Unknown until a public-safe export is wired. No credentials, emails, prompts, customer data, or secrets are written.

## Schedule

Target windows: **09:00** and **16:00** `Europe/Amsterdam`. GitHub Actions cron is UTC-only and does not track DST — details in [`docs/SCHEDULE.md`](docs/SCHEDULE.md).

## Privacy

Committed and published data is public-safe seed/structure only. Do not commit `.env`, API keys, or account exports.

## Version

`1.0.0`
