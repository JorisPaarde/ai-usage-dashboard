# Plan: unattended AI usage app

**Version:** 1.8.0 · **Collect host:** Linux box (`scripts/box-snapshot.sh`)  
**Live host:** GitHub Pages (`data/latest.json` only)

## Product rule

Cursor cloud agents may **plan, backlog, and implement**. Once shipped, **collect + publish must be ordinary automation**: cron on the box / signed-in local CLIs / official APIs. No Grok Bot, cloud agent, or browser-bot in the steady-state loop. No secrets on Pages.

## Architecture (confirmed)

| Layer | Role |
| --- | --- |
| Linux box cron (`scripts/box-snapshot.sh`) | Sole live meter + `git push` of `data/latest.json` (existing `gh` HTTPS login) |
| GitHub Actions Pages | Dumb static host of committed snapshot (`assert-no-hosted-meter`) |
| GHA `collect.yml` | Validate committed snapshot only — **not** a meter |
| `local-overrides.json` | Temporary seed for sources that cannot be automated |

The former Mac LaunchAgent / `local-snapshot.sh` schedule is retired as the live meter path. The box owns measurement. Push uses the box's existing `gh auth` — no separate token env var.

## Sources (box)

| Source | Route |
| --- | --- |
| OpenAI (ChatGPT/Codex) | `codex app-server` → `account/rateLimits/read` (5 h + weekly bars) |
| Claude Code | `GET /api/oauth/usage`; on 403 only, Haiku `max_tokens=1` + unified rate-limit headers |
| OpenRouter | Account balance from `GET /credits` (key cap secondary) |
| Sail Research | Official usage API (unchanged) |

Removed (Mac-only / retired): Cursor Agent, Ollama, Enrich Labs / Helena.

## Backlog status

| Issue | Status |
| --- | --- |
| #7 Claude OAuth meter | **Shipped** — oauth/usage when it works; Haiku header fallback on 403 |
| #8 Sole publisher | **Box cron** — docs + workflow guard |
| #9 UI live/stale | **Shipped** |
| #10 Enrich/Helena | **Removed** from product |
| OpenRouter + Sail | **Shipped** — OpenRouter headline is account balance |
| #11 Routing | **Held** — compact unavailable card until runtime evidence |
| #12 No agent in collect | **Shipped** — script comments + PLAN + SCHEDULE |

## Explicit non-goals

- Inventing usage figures  
- Committing tokens, emails, prompts, or overrides  
- Scheduling cloud agents or browser scrapers for meters  
- Publishing Cursor Agent, Ollama, or Enrich Labs / Helena meters
