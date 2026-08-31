import { unknown } from "../lib/adapter-result.js";
import {
  ENRICH_MONTHLY_BUDGET,
  ENRICH_WEEKLY_PACE_MAX,
} from "../lib/schema.js";
import { dailyCapFromWeekly } from "../lib/pace.js";

/**
 * Enrich Labs — public Starter budget (200/mo) and operating pace (max 50/wk)
 * are known; live usage requires authenticated browser access (no public API).
 */
export async function collect() {
  return unknown(
    "enrich-labs",
    "Enrich Labs has no public usage API. Live credits require authenticated workspace access; not collected here.",
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
      // Public policy constants only — not fabricated usage history.
      history: [],
      collectionMode: "unavailable",
    },
  );
}

export { ENRICH_MONTHLY_BUDGET, ENRICH_WEEKLY_PACE_MAX, dailyCapFromWeekly };
