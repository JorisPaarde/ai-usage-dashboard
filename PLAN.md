# Plan: unattended AI usage app

**Version:** 1.4.1 · **Branch/PR:** `cursor/unattended-usage-app-46b4` / #13  
**Live host:** GitHub Pages (`data/latest.json` only) · **Collect host:** Mac LaunchAgent

## Product rule

Cursor cloud agents may **plan, backlog, and implement**. Once shipped, **collect + publish must be ordinary automation**: LaunchAgent / cron / signed-in local CLIs / official APIs. No Grok Bot, cloud agent, or browser-bot in the steady-state loop. No secrets on Pages.

## Architecture (confirmed)

| Layer | Role |
| --- | --- |
| Mac LaunchAgent (`*/15`) | Sole live meter + `git push` of `data/latest.json` |
| GitHub Actions Pages | Dumb static host of committed snapshot (`assert-no-hosted-meter`) |
| GHA `collect.yml` | Validate committed snapshot only — **not** a meter |
| `local-overrides.json` | Temporary seed for sources that cannot be automated |

## Backlog status

| Issue | Status |
| --- | --- |
| #7 Claude OAuth meter | **Shipped in code** — next Mac LaunchAgent tick with Claude signed in flips to live (do not fake) |
| #8 LaunchAgent sole publisher | **Shipped** — docs + workflow guard |
| #9 UI live/stale | **Shipped** |
| #10 Enrich/Helena | **Hard stop documented** (`docs/ENRICH.md`) — manual override only |
| #11 Routing | **Held** — compact unavailable card until runtime evidence |
| #12 No agent in collect | **Shipped** — script comments + PLAN + SCHEDULE |

## Explicit non-goals

- Inventing usage figures  
- Committing tokens, emails, prompts, or overrides  
- Scheduling cloud agents or browser scrapers for meters  
- Using enrich.so wallet API for Helena workspace credits
