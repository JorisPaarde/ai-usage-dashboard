# Collection schedule (Europe/Amsterdam)

The local collector runs every **15 minutes**. The dashboard refreshes its
snapshot every **5 minutes** while it is open.

## What each scheduled run actually measures

A run is only worth scheduling if it re-measures something. Per source:

| Source | Route | Re-measured each run? |
| --- | --- | --- |
| OpenAI / Buzz | `account/rateLimits/read` on the local `codex app-server`, falling back to `~/.codex/sessions/**` | Yes — live from the account |
| Claude Code | token counters in `~/.claude/projects/**/*.jsonl` | Yes (tokens). Plan/credit percentages: **no**, see below |
| Ollama | timing counters in the local `ollama.log` | Yes |
| Cursor | `GetCurrentPeriodUsage` (+ optional `GetSandUsageStatus`) with the signed-in IDE Bearer token from `state.vscdb` | Yes — live from the account when Cursor is signed in locally |
| Enrich Labs | none — no local meter exists | No, manual only |

All routes read **numeric counters only**. Prompts, responses, credit balances,
plan tiers, and account/installation identifiers are never parsed into the
snapshot, and the publish step fails closed on secret- or email-looking values.

### The live Cursor read costs nothing

Cursor's IDE stores a session access token in its local `state.vscdb` (SQLite
`ItemTable` key `cursorAuth/accessToken`). The collector reads that token and
POSTs `{}` to `aiserver.v1.DashboardService/GetCurrentPeriodUsage` on
`api2.cursor.sh` (Connect protocol). That returns Included Cursor Models %,
Other Models %, and On-demand USD from `planUsage` / `spendLimitUsage`. An
optional `GetSandUsageStatus` call fills the separate Grok Bot weekly meter when
the account has one. No browser scrape, no cookies from a website session —
same local-login idea as Codex. The token is never written into
`data/latest.json`, logs, or reasons.

Override the state DB / storage JSON paths with `CURSOR_STATE_DB` and
`CURSOR_STORAGE_JSON`, or the API origin with `CURSOR_API_BASE`.

### The live OpenAI read costs nothing

`codex app-server` is a local JSON-RPC process that reuses the existing login.
`account/rateLimits/read` is read-only, starts no model, and consumes no
tokens — safe to call on a 15-minute schedule. It returns the same percentages
the provider shows, so it tracks a mid-window reset that the session log cannot
see. The log remains the fallback when the app-server is unavailable.

Override the search paths with `CODEX_SESSIONS_DIR`, `CLAUDE_PROJECTS_DIR`, and
`OLLAMA_LOG_PATH`.

### Percentages expire with their window

A rate-limit percentage only describes the window it was recorded in. When the
recorded `resets_at` has passed and the provider has written nothing since, the
OpenAI source reports **unavailable with the reason**, rather than republishing
a spent number against an allowance the provider has already reset.

### What a local meter cannot reach

`claude.ai/settings/usage` and `chatgpt.com/#settings/Usage` are the human
ground truth for plan/session/weekly percentages. Those values are served by
authenticated account APIs and are **not** cached to disk by either CLI —
verified by scanning `~/.claude.json`, `~/.claude/**`, and the transcripts for
rate-limit state. Matching them exactly needs authenticated collection, which is
an escalation, not a config change.

Until that decision is made, such values live in `data/local-overrides.json` as
hand-entered readings. Every scheduled run stamps them with **how old** they
are, and marks them `STALE:` past 12 hours, so a fresh `generatedAt` can never
make an old hand-typed number look re-measured.

An override never overwrites a source the collector measures directly. If it
carries a genuinely different metric (Claude's EUR credits vs. locally counted
tokens) it must say `"supplements": true`; the automatic reading is then kept
alongside it as supporting detail.

## Local / self-hosted collectors (preferred for real usage)

GitHub-hosted runners **cannot** inspect authenticated desktop or browser apps
(Cursor, Claude Code, Enrich Labs, OpenAI account pages). Those figures only
appear when you run the collector on a machine that can see them, usually via
`data/local-overrides.json` (gitignored; see README).

Run the LaunchAgent from a checkout dedicated to the scheduler. It refuses to
run against a dirty tree (other than a leftover `data/latest.json` from a prior
failed collect/check, which it discards so the schedule cannot lock itself
out). Pointing it at a checkout an agent is editing still means the 15-minute
run does nothing.

Primary local schedule (macOS LaunchAgent):

```sh
./scripts/install-launch-agent.sh
# StartInterval 900s → collect every 15 minutes while the machine is awake
```

Optional cron equivalent on a host that understands `Europe/Amsterdam`:

```cron
CRON_TZ=Europe/Amsterdam
*/15 * * * * cd /path/to/ai-usage-dashboard-scheduler && ./scripts/local-snapshot.sh
```

GitHub Actions still keep the **09:00** / **16:00** Amsterdam checkpoints below.

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

## Where the seed lives

`data/local-overrides.json` is gitignored, so every checkout keeps its own copy
and they drift apart. A collect run from a checkout holding an older copy
republishes those older readings into the tracked snapshot — the seed regresses
even though nobody edited it. This has happened once already.

The collector therefore resolves the overrides file in this order:

1. `$AI_USAGE_OVERRIDES_PATH`
2. `~/.config/ai-usage-dashboard/local-overrides.json` — **the canonical seed**
3. `<repo>/data/local-overrides.json` — legacy per-checkout copy

Edit the shared file. Every checkout and the scheduler then read the same seed.

## Local models: write time only

Local-first routing applies when *authoring* — summarising, drafting, mapping a
provider's field names to ours. It never applies at *run* time inside the
measurement or publish chain. That chain stays deterministic and LLM-free:
schema validation and `assertPublishableSnapshot` are the honesty guarantee of
this dashboard, and a model in that path would make it nondeterministic. Where
routing preference and the LLM-free rule conflict, LLM-free wins.

## Privacy

Collectors must never write credentials, emails, prompts, customer data, or API
secrets into `data/latest.json`. The publish/build step fails closed on dishonest
source records and secret-looking payloads. `data/local-overrides.json` is never
copied into `dist/`.
