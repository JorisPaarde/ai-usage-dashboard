# Collection schedule (Europe/Amsterdam)

**Policy:** Cursor cloud agents may plan and implement. Steady-state
**collect + publish is ordinary automation only** (LaunchAgent / cron /
signed-in local CLIs / official APIs). No Grok Bot, cloud agent, or
browser-bot in the measurement loop. See [`PLAN.md`](../PLAN.md) and
[issue #12](https://github.com/JorisPaarde/ai-usage-dashboard/issues/12).

The local collector runs every **15 minutes**. Open dashboards soft-refresh
every **5 minutes**.

## What each scheduled run actually measures

A run is only worth scheduling if it re-measures something. Per source:

| Source | Route | Re-measured each run? |
| --- | --- | --- |
| OpenAI / Buzz | `account/rateLimits/read` on the local `codex app-server`, falling back to `~/.codex/sessions/**` | Yes — live from the account |
| Claude Code | Prefer `GET /api/oauth/usage` with the local Claude.ai OAuth token from `~/.claude/.credentials.json`; always also sum tokens from `~/.claude/projects/**/*.jsonl` | Yes when OAuth works; tokens always when transcripts exist |
| Ollama | timing counters in the local `ollama.log` | Yes |
| Cursor | `GetCurrentPeriodUsage` (+ optional `GetSandUsageStatus`) with the signed-in IDE Bearer token from `state.vscdb` | Yes — live from the account when Cursor is signed in locally |
| Enrich Labs / Helena | none verified — not enrich.so wallets | No — manual override until [issue #10](https://github.com/JorisPaarde/ai-usage-dashboard/issues/10) |

All routes read **numeric counters only**. Prompts, responses, credit balances
that are account-private beyond the published meter, plan tiers, and
account/installation identifiers are never parsed into the snapshot. The
publish step fails closed on secret- or email-looking values.

### The live Cursor read costs nothing

Cursor's IDE stores a session access token in its local `state.vscdb` (SQLite
`ItemTable` key `cursorAuth/accessToken`). The collector reads that token and
POSTs `{}` to `aiserver.v1.DashboardService/GetCurrentPeriodUsage` on
`api2.cursor.sh` (Connect protocol). That returns Included Cursor Models %,
Other Models %, and On-demand USD from `planUsage` / `spendLimitUsage`. An
optional `GetSandUsageStatus` call fills the separate Grok Bot weekly meter when
the account has one. No browser scrape — same local-login idea as Codex. The
token is never written into `data/latest.json`, logs, or reasons.

Override the state DB / storage JSON paths with `CURSOR_STATE_DB` and
`CURSOR_STORAGE_JSON`, or the API origin with `CURSOR_API_BASE`.

### The live OpenAI read costs nothing

`codex app-server` is a local JSON-RPC process that reuses the existing login.
`account/rateLimits/read` is read-only, starts no model, and consumes no
tokens — safe to call on a 15-minute schedule.

Override the search paths with `CODEX_SESSIONS_DIR`, `CLAUDE_PROJECTS_DIR`,
`CLAUDE_CREDENTIALS_PATH`, and `OLLAMA_LOG_PATH`.

### The live Claude plan read (local OAuth)

Claude Code keeps a Claude.ai OAuth access token in
`~/.claude/.credentials.json` (`claudeAiOauth.accessToken`). The collector
calls `GET https://api.anthropic.com/api/oauth/usage` with
`Authorization: Bearer` and `anthropic-beta: oauth-2025-04-20`. Mapping:

- `five_hour` → Session window %
- `seven_day` → Weekly (all models) %
- `extra_usage` → Usage credits (EUR when present)

The endpoint rate-limits aggressively; on HTTP 429 the adapter keeps transcript
token totals and retries next interval. Token never enters the snapshot.

Transcript token counters remain the fallback / supporting breakdown. They do
**not** invent plan percentages.

### Percentages expire with their window

A rate-limit percentage only describes the window it was recorded in. When the
recorded `resets_at` has passed and the provider has written nothing since, the
OpenAI source reports **unavailable with the reason**, rather than republishing
a spent number against an allowance the provider has already reset.

### What a local meter cannot reach yet

Helena / Enrich Labs workspace credits still have **no verified local meter or
documented read-only API** for this product (Starter 200 credits/mo). Do **not**
use enrich.so `/wallets/balance` — that is a different product. Until issue #10
lands, those values live in `~/.config/ai-usage-dashboard/local-overrides.json`
as hand-entered readings. Every scheduled run stamps them with **how old** they
are, and marks them `STALE:` past 12 hours.

An override never overwrites a source the collector measures directly. If it
carries a genuinely different metric it must say `"supplements": true`.

## Local / self-hosted collectors (the only live path)

GitHub-hosted runners **cannot** inspect authenticated desktop or browser apps.
Real figures appear only when the collector runs on a machine that can see them.

Run the LaunchAgent from a checkout dedicated to the scheduler. It refuses to
run against a dirty tree (other than a leftover `data/latest.json` from a prior
failed collect/check, which it discards so the schedule cannot lock itself
out).

```sh
./scripts/install-launch-agent.sh
# StartInterval 900s → collect every 15 minutes while the machine is awake
```

Optional cron equivalent:

```cron
CRON_TZ=Europe/Amsterdam
*/15 * * * * cd /path/to/ai-usage-dashboard-scheduler && ./scripts/local-snapshot.sh
```

## GitHub Actions

- **Pages** (`.github/workflows/pages.yml`): build + deploy the committed
  snapshot. Dumb host.
- **Validate** (`.github/workflows/collect.yml`): `workflow_dispatch` only —
  runs `npm run check` on the committed public snapshot. **Not a meter.**

Older docs mentioned Amsterdam-gated 09:00 / 16:00 UTC cron collect windows.
Those are retired: hosted collect cannot see desktop sessions and must not
claim to. The Amsterdam gate helper remains in-repo for optional local tooling.

## Where the seed lives

Override resolution order:

1. `$AI_USAGE_OVERRIDES_PATH`
2. `~/.config/ai-usage-dashboard/local-overrides.json` — **canonical seed**
3. `<repo>/data/local-overrides.json` — legacy per-checkout copy

## Local models: write time only

Local-first routing applies when *authoring*. It never applies at *run* time
inside the measurement or publish chain. That chain stays deterministic and
LLM-free.

## Privacy

Collectors must never write credentials, emails, prompts, customer data, or API
secrets into `data/latest.json`. The publish/build step fails closed on dishonest
source records and secret-looking payloads. `data/local-overrides.json` is never
copied into `dist/`.
