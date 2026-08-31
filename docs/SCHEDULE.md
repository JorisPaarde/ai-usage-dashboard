# Collection schedule (Europe/Amsterdam)

Intended windows: **09:00** and **16:00** `Europe/Amsterdam`.

## Local / self-hosted runners

Prefer a machine that understands `Europe/Amsterdam` (cron with `CRON_TZ=Europe/Amsterdam`, launchd, or systemd timers). That keeps both morning and afternoon slots correct across DST.

Example crontab:

```cron
CRON_TZ=Europe/Amsterdam
0 9 * * *  cd /path/to/ai-usage-dashboard && node collector/index.js
0 16 * * * cd /path/to/ai-usage-dashboard && node collector/index.js
```

## GitHub Actions cron limits

GitHub Actions `schedule` triggers use **UTC only**. They do **not** honor `Europe/Amsterdam` and they **do not adjust for DST**.

| Amsterdam local | CET (UTC+1, ~late Oct–late Mar) | CEST (UTC+2, ~late Mar–late Oct) |
| --- | --- | --- |
| 09:00 | 08:00 UTC | 07:00 UTC |
| 16:00 | 15:00 UTC | 14:00 UTC |

A single fixed UTC cron cannot hit both winter and summer Amsterdam times. The workflow in `.github/workflows/collect.yml` therefore:

1. Schedules approximate UTC times for the **current season’s** Amsterdam slots (documented in the workflow comments).
2. Runs a small gate that skips the job when the Amsterdam clock is not near 09:00 or 16:00 (within a few minutes), so off-season UTC misfires are no-ops when possible.

Expect GitHub cron drift of several minutes and occasional missed runs under load. For exact Amsterdam times, use a local collector host.

## Privacy

Collectors must never write credentials, emails, prompts, customer data, or API secrets into `data/latest.json`.
