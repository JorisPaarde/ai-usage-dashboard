# Collection schedule (Europe/Amsterdam)

**Policy:** Cursor cloud agents may plan and implement. Steady-state
**collect + publish is ordinary automation only** (box cron / signed-in local
CLIs / official APIs). No Grok Bot, cloud agent, or browser-bot in the
measurement loop. See [`PLAN.md`](../PLAN.md) and
[issue #12](https://github.com/JorisPaarde/ai-usage-dashboard/issues/12).

The box collector runs on a cron interval set by the server owner (typically
every **15 minutes**). Open dashboards soft-refresh every **5 minutes**.

## What each scheduled run actually measures

A run is only worth scheduling if it re-measures something. Per source:

| Source | Route | Re-measured each run? |
| --- | --- | --- |
| OpenAI (ChatGPT/Codex) | `account/rateLimits/read` on the local `codex app-server` (5 h + weekly bars); session-log fallback when app-server is down | Yes — live from the account when Codex is signed in |
| Claude Code | Prefer `GET /api/oauth/usage` with the local Claude.ai OAuth token; on HTTP 401/403 only, one Haiku `max_tokens=1` Messages call and read `anthropic-ratelimit-unified-5h/7d-*` headers; always also sum tokens from `~/.claude/projects/**/*.jsonl` | Yes when OAuth or header probe works; tokens always when transcripts exist |
| OpenRouter | Official `GET /api/v1/credits` (account balance = total_credits − total_usage as headline) + `/api/v1/key` secondary; optional `/activity` history | Yes when keys are present in `~/.config/ai-usage-dashboard/env` |
| Sail Research | Official `GET /v2/usage/summary?range=period` (+ `/breakdown` history) with `SAIL_API_KEY` | Yes when the key is present in `~/.config/ai-usage-dashboard/env` |

Removed from the product (formerly Mac-only): Cursor Agent, Ollama, Enrich Labs / Helena.

All routes read **numeric counters only**. Prompts, responses, credit balances
that are account-private beyond the published meter, plan tiers, and
account/installation identifiers are never parsed into the snapshot. The
publish step fails closed on secret- or email-looking values.

### The live OpenAI read costs nothing

`codex app-server` is a local JSON-RPC process that reuses the existing login.
`account/rateLimits/read` is read-only, starts no model, and consumes no
tokens — safe to call on a schedule. Publishes two capacity bars (5-hour and
weekly) with reset times for the existing dashboard layout.

Override the search paths with `CODEX_SESSIONS_DIR` and `CLAUDE_PROJECTS_DIR` /
`CLAUDE_CREDENTIALS_PATH`.

### The live Claude plan read (local OAuth)

Claude Code keeps a Claude.ai OAuth access token in
`~/.claude/.credentials.json` (`claudeAiOauth.accessToken`). The collector
calls `GET https://api.anthropic.com/api/oauth/usage` with
`Authorization: Bearer` and `anthropic-beta: oauth-2025-04-20`. Mapping:

- `five_hour` → Session window %
- `seven_day` → Weekly (all models) %
- `extra_usage` → Usage credits (EUR when present)

When that endpoint returns **401/403** (e.g. a setup token with only
`user:inference`), the adapter falls back once: `POST /v1/messages` with
`max_tokens: 1` to a Haiku model, then reads:

- `anthropic-ratelimit-unified-5h-utilization` / `-5h-reset`
- `anthropic-ratelimit-unified-7d-utilization` / `-7d-reset`

Utilization is a 0–1 fraction (×100 for %). Shown as the same two capacity
bars. Other failures keep the previous behaviour (transcripts / cache / unknown).

The oauth/usage endpoint rate-limits aggressively; on HTTP 429 the adapter keeps
transcript token totals and retries next interval. Token never enters the
snapshot.

### Percentages expire with their window

A rate-limit percentage only describes the window it was recorded in. When the
recorded `resets_at` has passed and the provider has written nothing since, the
OpenAI source reports **unavailable with the reason**, rather than republishing
a spent number against an allowance the provider has already reset.

### Prepaid meters

OpenRouter and Sail Research have documented Usage APIs. Put the keys in
`~/.config/ai-usage-dashboard/env` (see [`docs/env.example`](env.example) and
[`docs/PREPAID.md`](PREPAID.md)). OpenRouter's headline is the **account
balance** from `/credits`; a per-key spending cap stays secondary when present.

An override never overwrites a source the collector measures directly. If it
carries a genuinely different metric it must say `"supplements": true`.

## Box collector (the only live path)

GitHub-hosted runners **cannot** inspect authenticated desktop or CLI sessions.
Real figures appear only when the collector runs on the box that can see them.

`scripts/box-snapshot.sh`:

1. Checks `gh auth status` (fails clearly if not logged in)
2. Runs `npm run collect` → `data/latest.json`
3. Commits only when the snapshot changed
4. `git push` via the existing `gh` HTTPS credential helper

No separate GitHub token env var. The server owner installs cron; this repo
does not write crontab entries.

Example cron (owner-managed):

```cron
CRON_TZ=Europe/Amsterdam
*/15 * * * * cd /path/to/ai-usage-dashboard && ./scripts/box-snapshot.sh
```

## GitHub Actions

- **Pages** (`.github/workflows/pages.yml`): build + deploy the committed
  snapshot. Dumb host.
- **Validate** (`.github/workflows/collect.yml`): `workflow_dispatch` only —
  runs `npm run check` on the committed public snapshot. **Not a meter.**

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
