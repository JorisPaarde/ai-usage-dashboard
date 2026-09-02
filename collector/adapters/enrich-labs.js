/**
 * Enrich Labs / Helena — public Starter budget (200/mo) and operating pace
 * (max 50/wk) are known; live workspace credits require authenticated
 * Enrich Labs access. There is no public usage API for Helena credits
 * (do not confuse with enrich.so wallet endpoints — different product).
 * See GitHub issue #10 for the next experiment.
 */
import { unknown } from "../lib/adapter-result.js";
import {
  ENRICH_MONTHLY_BUDGET,
  ENRICH_WEEKLY_PACE_MAX,
} from "../lib/schema.js";
import { dailyCapFromWeekly } from "../lib/pace.js";

/**
 * Enrich Labs (Helena) — no local meter and no verified read-only API yet.
 * Returns unavailable with public budget constants only; never fabricates usage.
 */
export async function collect() {
  return unknown(
    "enrich-labs",
    "Enrich Labs / Helena has no verified local meter or public usage API for workspace credits. Live figures require a signed-in workspace reading (manual override) until issue #10 lands. No usage fabricated. Note: enrich.so wallet APIs are a different product and must not be used here.",
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
