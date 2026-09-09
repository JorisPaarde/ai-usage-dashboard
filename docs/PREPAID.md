# OpenRouter and Sail Research — prepaid meters

**Status:** automated from official Usage APIs on the Mac LaunchAgent.  
No browser scrape. Keys never enter `data/latest.json`.

## OpenRouter

Ground-truth page: [openrouter.ai/workspaces/default](https://openrouter.ai/workspaces/default)

| Route | Key | What it measures |
| --- | --- | --- |
| `GET /api/v1/credits` | Management key | Lifetime `total_usage` / `total_credits` (USD) |
| `GET /api/v1/key` | Inference or management key | Optional per-key spending cap |
| `GET /api/v1/activity` | Management key | Daily USD history (last 30 completed UTC days) |

Set `OPENROUTER_API_KEY` and, if the inference key cannot read `/credits`, also
`OPENROUTER_MANAGEMENT_KEY`. A key with no cap and no management access stays
**unavailable** (consumption without a limit is not room).

## Sail Research

Ground-truth page: [app.sailresearch.com/usage](https://app.sailresearch.com/usage)

| Route | Key | What it measures |
| --- | --- | --- |
| `GET /v2/usage/summary?range=period` | `SAIL_API_KEY` | Billing-period spend vs remaining credit balance |
| `GET /v2/usage/breakdown?range=7d` | same | Daily combined spend history |

Sail documents monetary fields as **fractional USD cents**. The adapter converts
them to USD before publishing. HTTP 402 `credits_exhausted` is published as
100% used — the provider said the pot is empty.

## Where the keys live

```sh
# ~/.config/ai-usage-dashboard/env  (gitignored, never published)
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MANAGEMENT_KEY=sk-or-...   # optional
SAIL_API_KEY=...
```

`scripts/local-snapshot.sh` sources that file on every 15-minute tick. Hosted
GitHub Actions runners never see it and must not collect.

Until a run produces a usage/limit pair, routing keeps both pools as **paid
last-resort** (`paidFallback`) so an unmeasured prepaid lane is never treated
as room.
