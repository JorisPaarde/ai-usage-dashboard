# Collection schedule (Europe/Amsterdam)

Intended windows: **09:00** and **16:00** `Europe/Amsterdam`.

## Local / self-hosted collectors (preferred for real usage)

GitHub-hosted runners **cannot** inspect authenticated desktop or browser apps
(Cursor, Claude Code, Enrich Labs, OpenAI account pages). Those figures only
appear when you run the collector on a machine that can see them, usually via
`data/local-overrides.json` (gitignored; see README).

Prefer a host that understands `Europe/Amsterdam`:

```cron
CRON_TZ=Europe/Amsterdam
0 9 * * *  cd /path/to/ai-usage-dashboard && npm run collect && npm run build
0 16 * * * cd /path/to/ai-usage-dashboard && npm run collect && npm run build
```

## GitHub Actions cron limits

GitHub Actions `schedule` triggers use **UTC only**. They do **not** honor
`Europe/Amsterdam` and they **do not adjust for DST**.

| Amsterdam local | CET (UTC+1, ~late Oct–late Mar) | CEST (UTC+2, ~late Mar–late Oct) |
| --- | --- | --- |
| 09:00 | 08:00 UTC | 07:00 UTC |
| 16:00 | 15:00 UTC | 14:00 UTC |

`.github/workflows/collect.yml` schedules **all four** UTC candidates. The
Amsterdam gate (`scripts/amsterdam-gate.js`) allows a scheduled run only when
local Amsterdam time is near 09:00 or 16:00 (90-minute window) and skips the
off-season misfire. `workflow_dispatch` always runs.

Expect GitHub cron drift of several minutes and occasional missed runs under
load. For exact Amsterdam times and real desktop/browser numbers, use a local
collector host.

## Privacy

Collectors must never write credentials, emails, prompts, customer data, or API
secrets into `data/latest.json`. The publish/build step fails closed on dishonest
source records and secret-looking payloads. `data/local-overrides.json` is never
copied into `dist/`.
