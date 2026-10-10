# Collection schedule (Europe/Amsterdam)

**Policy:** Cursor cloud agents may plan and implement. Steady-state
**collect + publish is ordinary automation only** (box cron + Mac LaunchAgent /
signed-in local CLIs / official APIs). No cloud agent or browser-bot in the
measurement loop. See [`PLAN.md`](../PLAN.md) and
[issue #12](https://github.com/JorisPaarde/ai-usage-dashboard/issues/12).

The box collector runs on a cron interval set by the server owner (typically
every **15 minutes**). The Mac LaunchAgent runs on the same cadence. Open
dashboards soft-refresh every **5 minutes**.

## What each scheduled run actually measures

### Box (`scripts/box-snapshot.sh`)

| Source | Route | Re-measured each run? |
| --- | --- | --- |
| OpenAI (ChatGPT/Codex) | `account/rateLimits/read` on the local `codex app-server` (5 h + weekly bars); session-log fallback when app-server is down | Yes — live from the account when Codex is signed in |
| Claude Code | Prefer `GET /api/oauth/usage` with `CLAUDE_CODE_OAUTH_TOKEN` (or `~/.claude/.credentials.json`); on HTTP **403** only, one Haiku `max_tokens=1` Messages call and read `anthropic-ratelimit-unified-5h/7d-*` headers from a **2xx** response; always also sum tokens from `~/.claude/projects/**/*.jsonl` when present | Yes when OAuth or header probe works; tokens when transcripts exist |
| OpenRouter | Official `GET /api/v1/credits` (account balance = total_credits − total_usage as headline) + `/api/v1/key` secondary; optional `/activity` history | Yes when keys are present in `~/.config/ai-usage-dashboard/env` |
| Sail Research | Official `GET /v2/usage/summary?range=period` (+ `/breakdown` history) with `SAIL_API_KEY` | Yes when the key is present in `~/.config/ai-usage-dashboard/env` |
| Cursor Agent + Grok Bot | **Merged** from `data/mac-sources.json` (not re-measured on the box) | Age preserved; **stale** if older than 2 hours |

### Mac (`scripts/mac-snapshot.sh`)

| Source | Route | Re-measured each run? |
| --- | --- | --- |
| Cursor Agent | Bearer token from Cursor IDE `state.vscdb` / `storage.json` → `GetCurrentPeriodUsage` (Included / Other / On-demand); HardLimit + `/api/usage/summary` fallback for on-demand | Yes when Cursor is signed in on this Mac |
| Grok Bot | Same token → `GetSandUsageStatus` → included / on-demand **capacity** bars (defensive field mapping; unknown if absent) | Yes when the account exposes a personal Grok meter |

Mac writes **only** `data/mac-sources.json` (`sources` + `measuredAt`). It must
**not** touch `data/latest.json`.

All routes read **numeric counters only**. Prompts, responses, plan tiers, and
account/installation identifiers are never parsed into the snapshot. The
publish step fails closed on secret- or email-looking values. The Cursor access
token is used only in the Authorization header and is never logged or written
into reasons.

### Prepaid meters and the env file

Put `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MANAGEMENT_KEY` /
`SAIL_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) in
`~/.config/ai-usage-dashboard/env` with mode **600**. See
[`docs/env.example`](env.example) and [`docs/PREPAID.md`](PREPAID.md).

`scripts/box-snapshot.sh` sources that file when it exists before collect.

## Box collector

`scripts/box-snapshot.sh` (must run on a clean `main` checkout):

1. Prepends `$HOME/.local/bin` to `PATH`
2. Takes an exclusive `flock -n` on `.box-snapshot.lock`
3. Sources `~/.config/ai-usage-dashboard/env` when present
4. Checks `gh auth status`
5. `git fetch origin main && git reset --hard origin/main`
6. Runs `npm run collect` (box adapters + merge of `data/mac-sources.json`) + `npm run routing`, then `npm run check`
7. Commits `data/latest.json` + `data/routing.json` only when they changed
8. `git push` via the existing `gh` HTTPS credential helper

Example cron (owner-managed):

```cron
CRON_TZ=Europe/Amsterdam
*/15 * * * * cd /path/to/ai-usage-dashboard && ./scripts/box-snapshot.sh
```

## Mac LaunchAgent

Template: [`docs/nl.jpwebcreation.ai-usage-dashboard.plist.example`](nl.jpwebcreation.ai-usage-dashboard.plist.example).

`scripts/mac-snapshot.sh`:

1. `mkdir` lock (`.mac-snapshot.lock`) — flock-equivalent on macOS
2. Sources `~/.config/ai-usage-dashboard/env` when present
3. `git fetch origin main && git reset --hard origin/main`
4. `npm run collect:mac` → `data/mac-sources.json`
5. `npm run check` (hermetic — must not read real Cursor DB / Codex / tokens)
6. Commits **only** `data/mac-sources.json` when changed; push with rebase retry

Label: `nl.jpwebcreation.ai-usage-dashboard`. Interval: 900 seconds.

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

## Privacy

Collectors must never write credentials, emails, prompts, customer data, or API
secrets into `data/latest.json` or `data/mac-sources.json`. The publish/build
step fails closed on dishonest source records and secret-looking payloads.
`data/local-overrides.json` is never copied into `dist/`.
