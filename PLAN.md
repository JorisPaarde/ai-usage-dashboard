# Plan: unattended AI usage app

**Version:** 1.9.0 · **Collect hosts:** Linux box (`scripts/box-snapshot.sh`) + Mac LaunchAgent (`scripts/mac-snapshot.sh`)  
**Live host:** GitHub Pages (`data/latest.json` only)

## Product rule

Cursor cloud agents may **plan, backlog, and implement**. Once shipped, **collect + publish must be ordinary automation**: cron on the box / LaunchAgent on the Mac / signed-in local CLIs / official APIs. No Grok Bot, cloud agent, or browser-bot in the steady-state loop. No secrets on Pages.

## Architecture (confirmed)

| Layer | Role |
| --- | --- |
| Linux box cron (`scripts/box-snapshot.sh`) | Measures box sources + merges `data/mac-sources.json` into `data/latest.json` (existing `gh` HTTPS login) |
| Mac LaunchAgent (`scripts/mac-snapshot.sh`) | Measures Cursor Agent + Grok Bot → pushes **only** `data/mac-sources.json` (never `latest.json`) |
| GitHub Actions Pages | Dumb static host of committed snapshot (`assert-no-hosted-meter`) |
| GHA `collect.yml` | Validate committed snapshot only — **not** a meter |
| `local-overrides.json` | Temporary seed for sources that cannot be automated |

Push uses each host's existing `gh` / git credentials. Mac sources older than **2 hours** stay in `latest.json` but are marked **stale** (UI shows age).

## Sources

| Source | Host | Route |
| --- | --- | --- |
| OpenAI (ChatGPT/Codex) | Box | `codex app-server` → `account/rateLimits/read` (5 h + weekly bars) |
| Cursor Agent | Mac | Local Cursor IDE token → `GetCurrentPeriodUsage` (+ HardLimit / usage summary fallback) |
| Grok Bot | Mac | Same token → `GetSandUsageStatus` (included / on-demand capacity bars) |
| Claude Code | Box | `GET /api/oauth/usage`; on 403 only, Haiku `max_tokens=1` + unified rate-limit headers |
| OpenRouter | Box | Account balance from `GET /credits` (key cap secondary) |
| Sail Research | Box | Official usage API (unchanged) |

## Backlog status

| Issue | Status |
| --- | --- |
| #7 Claude OAuth meter | **Shipped** — oauth/usage when it works; Haiku header fallback on 403 |
| #8 Sole publisher | **Split meter** — box owns `latest.json`; Mac owns `mac-sources.json` |
| #9 UI live/stale | **Shipped** — Mac merge marks stale after 2 h |
| #10 Enrich/Helena | **Removed** from product |
| OpenRouter + Sail | **Shipped** — OpenRouter headline is account balance |
| Cursor + Grok Bot | **Shipped** — Mac LaunchAgent path |
| #11 Routing | **Held** — compact unavailable card until runtime evidence |
| #12 No agent in collect | **Shipped** — script comments + PLAN + SCHEDULE |

## Explicit non-goals

- Inventing usage figures  
- Committing tokens, emails, prompts, or overrides  
- Scheduling cloud agents or browser scrapers for meters  
- Publishing Ollama or Enrich Labs / Helena meters  
- Letting the Mac rewrite `data/latest.json`
