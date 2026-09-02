# Enrich Labs / Helena — automation hard stop

**Status:** cannot automate without a human or an unverified scrape.  
**Issue:** [#10](https://github.com/JorisPaarde/ai-usage-dashboard/issues/10)

## Product under measurement

Helena by **Enrich Labs** (`enrichlabs.ai`) — workspace credits (Starter **200**/mo,
operating pace max **50**/wk). Social posts / chat tasks consume credits.

## Experiments (2026-09-02)

| Candidate | Result |
| --- | --- |
| Public REST usage API on enrichlabs.ai | None found in public docs |
| enrich.so `GET /api/v3/wallets/balance` | **Wrong product** (lead-enrichment SaaS). Must not be wired |
| Local desktop/app cache under `~/Library` | No verified meter file for Helena credits |
| Helena MCP | Interactive agent tool only — **forbidden** in the scheduled LaunchAgent loop |
| Browser dashboard scrape on a cron | Forbidden (no browser-bot in steady-state) |

## Steady-state rule

- Adapter always returns `status: unknown` / `collectionMode: unavailable` with
  public budget constants only.
- Optional hand reading may live in
  `~/.config/ai-usage-dashboard/local-overrides.json` and is stamped stale after
  12 hours. Never invent credits.
- Re-open automation only when a **read-only** official endpoint or local cache
  is verified on a signed-in Mac host.
