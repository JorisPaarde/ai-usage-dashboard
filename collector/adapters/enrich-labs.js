/**
 * Enrich Labs / Helena — public Starter budget (200/mo) and operating pace
 * (max 50/wk) are known; live workspace credits require authenticated
 * Enrich Labs access. Hard stop: no verified local meter or public usage API
 * for Helena credits (do not use enrich.so wallet endpoints — different product).
 * See docs/ENRICH.md and GitHub issue #10.
 */
import { unknown } from "../lib/adapter-result.js";
import {
  ENRICH_MONTHLY_BUDGET,
  ENRICH_WEEKLY_PACE_MAX,
} from "../lib/schema.js";
import { dailyCapFromWeekly } from "../lib/pace.js";

/**
 * Enrich Labs (Helena) — hard-stop: unavailable without a verified meter.
 * Never fabricates usage. Optional manual overrides remain the only path.
 */
export async function collect() {
  return unknown(
    "enrich-labs",
    "Hard stop: Enrich Labs / Helena has no verified local meter or public usage API for workspace credits (issue #10 / docs/ENRICH.md). Manual override only. enrich.so wallet APIs are a different product and must not be used. No usage fabricated.",
    {
      limit: ENRICH_MONTHLY_BUDGET,
      unit: "credits",
      budget: {
        monthly: ENRICH_MONTHLY_BUDGET,
        weeklyPaceMax: ENRICH_WEEKLY_PACE_MAX,
      },
      pace: {
        daily: null,
        monthly: null,
        weeklyTarget: ENRICH_WEEKLY_PACE_MAX,
      },
      history: [],
      collectionMode: "unavailable",
    },
  );
}

export { ENRICH_MONTHLY_BUDGET, ENRICH_WEEKLY_PACE_MAX, dailyCapFromWeekly };
