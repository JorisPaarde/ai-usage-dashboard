/**
 * Cursor Agent spending meters via the signed-in local IDE session (Mac-only).
 * Bearer token from Cursor's local state DB → GetCurrentPeriodUsage
 * (Included / Other / On-demand). Grok Bot is a separate Mac source.
 */
import { unknown } from "../lib/adapter-result.js";
import {
  CURSOR_API_BASE,
  fetchCurrentPeriodUsage,
  fetchHardLimit,
  fetchUsageSummary,
  isNonEmptyToken,
  readCursorAccessToken,
} from "../lib/cursor-session.js";

export {
  readCursorAccessToken,
  resolveCursorStatePaths,
  fetchCurrentPeriodUsage,
  fetchHardLimit,
  fetchUsageSummary,
  fetchGrokBotUsage,
  cursorApiRequest,
} from "../lib/cursor-session.js";

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize billing-cycle timestamps (unix-ms string or RFC3339) to ISO date.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeCycleTimestamp(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && /^\d+$/.test(raw.trim())) {
    const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Prefer YYYY-MM-DD for billing-cycle reset labels when the time is midnight-ish. */
function cycleResetLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function centsToUsd(cents) {
  return Math.round(cents) / 100;
}

/**
 * Map GetCurrentPeriodUsage JSON to dashboard components.
 * Deliberately narrow: plan name, email, team ids, and display messages that
 * might carry account copy stay out of the published snapshot.
 *
 * @param {unknown} json
 * @returns {{
 *   components: object[],
 *   resetDate: string|null,
 *   billingCycleEnd: string|null,
 *   missing: string[],
 * }|null}
 */
export function parsePeriodUsage(json) {
  if (!isRecord(json)) return null;
  const planUsage = isRecord(json.planUsage) ? json.planUsage : null;
  if (!planUsage) return null;

  const autoPercent = num(planUsage.autoPercentUsed);
  const apiPercent = num(planUsage.apiPercentUsed);
  const auto = autoPercent ?? num(json.autoPercentUsed);
  const api = apiPercent ?? num(json.apiPercentUsed);

  const billingCycleEnd = normalizeCycleTimestamp(json.billingCycleEnd);
  const resetDate = cycleResetLabel(billingCycleEnd);
  /** @type {object[]} */
  const components = [];
  /** @type {string[]} */
  const missing = [];

  if (typeof auto === "number") {
    components.push({
      id: "included-cursor-models",
      label: "Included Cursor Models",
      role: "capacity",
      usage: auto,
      limit: 100,
      unit: "% of included allowance",
      resetDate,
    });
  } else {
    missing.push("Included Cursor Models %");
  }

  if (typeof api === "number") {
    components.push({
      id: "other-models",
      label: "Other Models",
      role: "capacity",
      usage: api,
      limit: 100,
      unit: "% of included allowance",
      resetDate,
    });
  } else {
    missing.push("Other Models %");
  }

  const onDemand = parseOnDemandFromPeriod(json);
  if (onDemand) {
    components.push(onDemand);
  } else {
    missing.push("On-demand USD");
  }

  if (!components.some((c) => c.role === "capacity")) return null;

  return { components, resetDate, billingCycleEnd, missing };
}

/**
 * @param {Record<string, unknown>} json
 * @returns {object|null}
 */
function parseOnDemandFromPeriod(json) {
  const sl = isRecord(json.spendLimitUsage) ? json.spendLimitUsage : null;
  if (!sl) return null;

  const individualLimit = num(sl.individualLimit);
  const pooledLimit = num(sl.pooledLimit);
  const individualUsed = num(sl.individualUsed);
  const pooledUsed = num(sl.pooledUsed);
  const individualRemaining = num(sl.individualRemaining);
  const pooledRemaining = num(sl.pooledRemaining);
  const totalSpend = num(sl.totalSpend);

  const preferIndividual =
    (individualLimit != null && individualLimit > 0) ||
    (individualUsed != null && individualUsed > 0) ||
    String(sl.limitType || "").toLowerCase() === "user";

  let limitCents = preferIndividual
    ? individualLimit
    : pooledLimit ?? individualLimit;
  let usedCents = preferIndividual
    ? individualUsed
    : pooledUsed ?? individualUsed;
  let remainingCents = preferIndividual
    ? individualRemaining
    : pooledRemaining ?? individualRemaining;

  if (limitCents == null || !(limitCents > 0)) {
    limitCents = pooledLimit ?? individualLimit;
  }
  if (usedCents == null || usedCents <= 0) {
    const reported = [individualUsed, pooledUsed, totalSpend].filter(
      (v) => typeof v === "number" && v > 0,
    );
    if (reported.length) usedCents = reported[0];
    else if (
      typeof limitCents === "number" &&
      typeof remainingCents === "number"
    ) {
      usedCents = Math.max(0, limitCents - remainingCents);
    } else {
      usedCents = totalSpend ?? 0;
    }
  }

  if (typeof limitCents === "number" && limitCents > 0) {
    const billingCycleEnd = normalizeCycleTimestamp(json.billingCycleEnd);
    return {
      id: "on-demand",
      label: "On-demand spend",
      role: "capped",
      usage: centsToUsd(usedCents ?? 0),
      limit: centsToUsd(limitCents),
      unit: "USD",
      resetDate: cycleResetLabel(billingCycleEnd),
    };
  }

  if (typeof usedCents === "number" && usedCents > 0) {
    const billingCycleEnd = normalizeCycleTimestamp(json.billingCycleEnd);
    return {
      id: "on-demand",
      label: "On-demand spend",
      role: "capped",
      usage: centsToUsd(usedCents),
      limit: null,
      unit: "USD",
      resetDate: cycleResetLabel(billingCycleEnd),
    };
  }

  return null;
}

/**
 * Map GetHardLimit when spendLimitUsage did not yield an on-demand meter.
 * @param {unknown} json
 * @param {string|null} resetDate
 * @returns {object|null}
 */
export function parseHardLimitOnDemand(json, resetDate = null) {
  if (!isRecord(json)) return null;
  if (json.noUsageBasedAllowed === true) return null;
  const hardLimit = num(json.hardLimit) ?? num(json.hardLimitDollars);
  if (hardLimit == null || !(hardLimit > 0)) return null;
  const limitUsd = hardLimit >= 1000 ? centsToUsd(hardLimit) : hardLimit;
  return {
    id: "on-demand",
    label: "On-demand spend",
    role: "capped",
    usage: 0,
    limit: limitUsd,
    unit: "USD",
    resetDate,
  };
}

/**
 * Best-effort on-demand from GET /api/usage/summary.
 * @param {unknown} json
 * @param {string|null} resetDate
 * @returns {object|null}
 */
export function parseUsageSummaryOnDemand(json, resetDate = null) {
  if (!isRecord(json)) return null;
  const teamOnDemand = isRecord(json.teamUsage)
    ? json.teamUsage.onDemand
    : null;
  const individualOnDemand = isRecord(json.individualUsage)
    ? json.individualUsage.onDemand
    : null;
  const bucket = isRecord(individualOnDemand)
    ? individualOnDemand
    : isRecord(teamOnDemand)
      ? teamOnDemand
      : null;
  if (bucket) {
    const used = num(bucket.used);
    const limit = num(bucket.limit);
    if (typeof used === "number" && typeof limit === "number" && limit > 0) {
      const asUsd = limit >= 1000 || used >= 1000;
      return {
        id: "on-demand",
        label: "On-demand spend",
        role: "capped",
        usage: asUsd ? centsToUsd(used) : used,
        limit: asUsd ? centsToUsd(limit) : limit,
        unit: "USD",
        resetDate,
      };
    }
  }

  const spent =
    num(json.onDemandSpend) ??
    num(json.onDemandSpent) ??
    num(json.totalSpend);
  const limit = num(json.onDemandLimit) ?? num(json.spendLimit);
  if (typeof spent === "number" && typeof limit === "number" && limit > 0) {
    const asUsd = limit >= 1000 || spent >= 1000;
    return {
      id: "on-demand",
      label: "On-demand spend",
      role: "capped",
      usage: asUsd ? centsToUsd(spent) : spent,
      limit: asUsd ? centsToUsd(limit) : limit,
      unit: "USD",
      resetDate,
    };
  }
  return null;
}

/**
 * Cursor Agent spending meters via the signed-in local IDE session.
 * Fail closed when the token or DB is missing — never fabricate percentages.
 */
export async function collect({
  now = new Date(),
  readToken = readCursorAccessToken,
  fetchPeriod = fetchCurrentPeriodUsage,
  fetchHard = fetchHardLimit,
  fetchSummary = fetchUsageSummary,
  baseUrl = process.env.CURSOR_API_BASE || CURSOR_API_BASE,
} = {}) {
  let token;
  try {
    token = await readToken();
  } catch {
    token = null;
  }

  if (!isNonEmptyToken(token)) {
    return unknown(
      "cursor-agent",
      "Cursor local state DB has no signed-in access token (state.vscdb / storage.json missing or unread). No spending figures fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  const period = await fetchPeriod({ token, baseUrl });

  if (!period.ok) {
    const authHint =
      period.status === 401 || period.status === 403
        ? " Cursor access token was rejected; re-sign-in to the Cursor app and retry."
        : "";
    token = "";
    return unknown(
      "cursor-agent",
      `GetCurrentPeriodUsage was unavailable${period.status ? ` (HTTP ${period.status})` : ""}.${authHint} No spending figures fabricated.`,
      { collectionMode: "unavailable" },
    );
  }

  const parsed = parsePeriodUsage(period.json);
  if (!parsed) {
    token = "";
    return unknown(
      "cursor-agent",
      "GetCurrentPeriodUsage returned no usable planUsage percentages. No spending figures fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  const components = [...parsed.components];
  /** @type {string[]} */
  const notes = [];

  if (!components.some((c) => c.id === "on-demand")) {
    const [hard, summary] = await Promise.all([
      fetchHard({ token, baseUrl }),
      fetchSummary({ token, baseUrl }),
    ]);
    let onDemand = null;
    if (hard.ok) {
      onDemand = parseHardLimitOnDemand(hard.json, parsed.resetDate);
      if (onDemand) notes.push("On-demand limit from GetHardLimit");
    }
    if (!onDemand && summary.ok) {
      onDemand = parseUsageSummaryOnDemand(summary.json, parsed.resetDate);
      if (onDemand) notes.push("On-demand from /api/usage/summary");
    }
    if (onDemand) {
      components.push(onDemand);
      parsed.missing = parsed.missing.filter((m) => m !== "On-demand USD");
    }
  }

  token = "";

  if (parsed.missing.length) {
    notes.push(`Missing from API response: ${parsed.missing.join(", ")}`);
  }

  const included = components.find((c) => c.id === "included-cursor-models");
  const other = components.find((c) => c.id === "other-models");
  const onDemand = components.find((c) => c.id === "on-demand");

  const parts = [];
  if (included) parts.push(`Included Cursor Models ${included.usage}%`);
  if (other) parts.push(`Other Models ${other.usage}%`);
  if (onDemand) {
    parts.push(
      onDemand.limit != null
        ? `On-demand $${onDemand.usage}/$${onDemand.limit}`
        : `On-demand $${onDemand.usage}`,
    );
  }

  const reason =
    `Live from the signed-in Cursor IDE session via GetCurrentPeriodUsage: ` +
    `${parts.join("; ") || "partial meters"}. ` +
    `Same local login pattern as Codex (no browser scrape).` +
    (notes.length ? ` ${notes.join(". ")}.` : "");

  return {
    id: "cursor-agent",
    status: "measured",
    collectionMode: "automatic",
    reason,
    usage: null,
    limit: null,
    unit: "mixed (see components)",
    resetDate: parsed.resetDate,
    lastUpdate: now.toISOString(),
    coverageStart: null,
    breakdown: null,
    components,
    usageUrl: "https://cursor.com/dashboard/spending",
    pace: { daily: null, monthly: null, weeklyTarget: null },
    history: [],
  };
}
