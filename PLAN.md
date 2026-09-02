# Plan: unattended AI usage app

**Version target:** 1.4.x · **Branch:** `cursor/unattended-usage-app-46b4`  
**Live host:** GitHub Pages (`data/latest.json` only) · **Collect host:** Mac LaunchAgent

## Product rule

Cursor cloud agents may **plan, backlog, and implement**. Once shipped, **collect + publish must be ordinary automation**: LaunchAgent / cron / signed-in local CLIs / official APIs. No Grok Bot, cloud agent, or browser-bot in the steady-state loop. No secrets on Pages.

## Architecture (confirmed)

| Layer | Role |
| --- | --- |
| Mac LaunchAgent (`*/15`) | Sole live meter + `git push` of `data/latest.json` |
| GitHub Actions Pages | Dumb static host of committed snapshot |
| GHA `collect.yml` | Validate committed snapshot only — **not** a meter |
| `local-overrides.json` | Temporary seed for sources that cannot be automated |

Hosted runners cannot see authenticated desktop sessions. Do not reintroduce GHA-as-collector for Cursor/Codex/Claude.

## Source status

| Source | Today | Target |
| --- | --- | --- |
| OpenAI / Buzz | Automatic (`codex app-server`) | Keep |
| Cursor Agent | Automatic (IDE token → DashboardService) | Keep |
| Ollama | Automatic (local log) | Keep |
| Claude Code | Tokens automatic; plan % **manual** | [#7](https://github.com/JorisPaarde/ai-usage-dashboard/issues/7) OAuth usage API |
| Enrich Labs / Helena | Manual only | [#10](https://github.com/JorisPaarde/ai-usage-dashboard/issues/10) experiment or hard-stop doc |
| Local share | Held (unproven labels) | [#11](https://github.com/JorisPaarde/ai-usage-dashboard/issues/11) |

## Backlog (one issue per slice)

1. **[#7](https://github.com/JorisPaarde/ai-usage-dashboard/issues/7) P0** — Claude automatic plan % via local OAuth  
2. **[#8](https://github.com/JorisPaarde/ai-usage-dashboard/issues/8) P0** — LaunchAgent sole publisher; docs match reality  
3. **[#9](https://github.com/JorisPaarde/ai-usage-dashboard/issues/9) P1** — UI: live vs stale, Amsterdam resets, less jargon  
4. **[#10](https://github.com/JorisPaarde/ai-usage-dashboard/issues/10) P1** — Enrich/Helena real meter or documented hard stop  
5. **[#11](https://github.com/JorisPaarde/ai-usage-dashboard/issues/11) P2** — Routing only with runtime evidence  
6. **[#12](https://github.com/JorisPaarde/ai-usage-dashboard/issues/12) P2** — Policy: no agent in collect/publish  

## This PR ships

- PLAN + backlog issues above  
- Claude OAuth local meter (automatic session/weekly/extra-usage when credentials exist)  
- UI clarity pass (live/stale, Amsterdam resets, hide empty facts)  
- Docs aligned with local-only collect (#8 / #12)  
- Enrich remains honest unavailable/manual until #10 lands — **no fake numbers**

## Explicit non-goals

- Inventing usage figures  
- Committing tokens, emails, prompts, or overrides  
- Scheduling cloud agents or browser scrapers for meters  
- Using enrich.so wallet API for Helena workspace credits (wrong product)
