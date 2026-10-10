/**
 * Grok Bot weekly meters via Cursor GetSandUsageStatus (Mac-only).
 * Same local IDE access token as Cursor Agent; token never logged.
 */
import { unknown } from "../lib/adapter-result.js";
import {
  CURSOR_API_BASE,
  fetchGrokBotUsage,
  isNonEmptyToken,
  readCursorAccessToken,
} from "../lib/cursor-session.js";
import { normalizeCycleTimestamp } from "./cursor-agent.js";

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
 * First finite number among named fields on a record (and optional nested bags).
 * @param {Record<string, unknown>} json
 * @param {string[]} keys
 * @returns {number|null}
 */
function firstNum(json, keys) {
  for (const key of keys) {
    const v = num(json[key]);
    if (v != null) return v;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function resetFromSand(raw) {
  if (!isRecord(raw)) return null;
  return (
    normalizeCycleTimestamp(raw.nextResetTimestampUtc) ||
    normalizeCycleTimestamp(raw.nextResetAt) ||
    normalizeCycleTimestamp(raw.resetAt) ||
    normalizeCycleTimestamp(raw.resetDate) ||
    (typeof raw.nextResetTimestampUtc === "string" &&
    raw.nextResetTimestampUtc.trim()
      ? raw.nextResetTimestampUtc.trim()
      : null)
  );
}

/**
 * True when GetSandUsageStatus says this account has no personal Grok meter.
 * @param {Record<string, unknown>} json
 */
export function grokBotIneligible(json) {
  if (json.usesPooledEnterpriseAllowance === true) return true;
  if (json.hasNonZeroIncludedLimit === false) return true;
  if (json.includedLimitZero === true) return true;
  if (json.grokBotNotIncluded === true) return true;
  return false;
}

/**
 * Map GetSandUsageStatus → included / on-demand capacity bars.
 * Fields are read defensively; absent meters are omitted (never fabricated).
 *
 * Mapped when present:
 * - included: usagePercent | includedPercentUsed | includedUsagePercent |
 *   percentUsed | includedUsed+includedLimit
 * - on-demand: onDemandPercentUsed | onDemandUsagePercent |
 *   onDemandUsed+onDemandLimit | onDemandSpend/onDemandLimit
 * - reset: nextResetTimestampUtc | nextResetAt | resetAt | resetDate
 *
 * @param {unknown} json
 * @returns {{
 *   components: object[],
 *   resetDate: string|null,
 *   missing: string[],
 * }|null}
 */
export function parseGrokBotUsage(json) {
  if (!isRecord(json)) return null;
  if (grokBotIneligible(json)) return null;

  const resetDate = resetFromSand(json);
  /** @type {object[]} */
  const components = [];
  /** @type {string[]} */
  const missing = [];

  const includedPercent =
    firstNum(json, [
      "usagePercent",
      "includedPercentUsed",
      "includedUsagePercent",
      "percentUsed",
      "includedPercent",
    ]) ??
    (() => {
      const used = firstNum(json, ["includedUsed", "includedSpend"]);
      const limit = firstNum(json, ["includedLimit", "includedAllowance"]);
      if (used != null && limit != null && limit > 0) {
        return Math.min(100, Math.max(0, (used / limit) * 100));
      }
      return null;
    })();

  if (typeof includedPercent === "number" && includedPercent >= 0) {
    components.push({
      id: "included",
      label: "Included",
      role: "capacity",
      usage: Math.min(includedPercent, 100),
      limit: 100,
      unit: "% of weekly allowance",
      resetDate,
    });
  } else {
    missing.push("Included %");
  }

  const onDemandPercent = firstNum(json, [
    "onDemandPercentUsed",
    "onDemandUsagePercent",
    "ondemandPercentUsed",
  ]);
  const onDemandUsed = firstNum(json, [
    "onDemandUsed",
    "onDemandSpend",
    "onDemandSpent",
  ]);
  const onDemandLimit = firstNum(json, ["onDemandLimit", "ondemandLimit"]);

  if (typeof onDemandPercent === "number" && onDemandPercent >= 0) {
    components.push({
      id: "on-demand",
      label: "On-demand",
      role: "capacity",
      usage: Math.min(onDemandPercent, 100),
      limit: 100,
      unit: "% of on-demand allowance",
      resetDate,
    });
  } else if (
    typeof onDemandUsed === "number" &&
    typeof onDemandLimit === "number" &&
    onDemandLimit > 0
  ) {
    const asUsd = onDemandLimit >= 1000 || onDemandUsed >= 1000;
    const usage = asUsd ? Math.round(onDemandUsed) / 100 : onDemandUsed;
    const limit = asUsd ? Math.round(onDemandLimit) / 100 : onDemandLimit;
    components.push({
      id: "on-demand",
      label: "On-demand",
      role: "capacity",
      usage,
      limit,
      unit: asUsd || onDemandLimit >= 10 ? "USD" : "% of on-demand allowance",
      resetDate,
    });
  } else {
    missing.push("On-demand");
  }

  if (!components.length) return null;
  return { components, resetDate, missing };
}

/**
 * Legacy single-component shape used by older callers/tests.
 * Prefer parseGrokBotUsage for the full capacity-bar mapping.
 * @param {unknown} json
 * @returns {object|null}
 */
export function parseGrokBotComponent(json) {
  const parsed = parseGrokBotUsage(json);
  if (!parsed) return null;
  const included = parsed.components.find((c) => c.id === "included");
  if (!included) return null;
  return {
    id: "grok-bot",
    label: "Grok Bot (weekly)",
    role: "capacity",
    usage: included.usage,
    limit: included.limit,
    unit: included.unit,
    resetDate: included.resetDate,
  };
}

/**
 * Grok Bot via GetSandUsageStatus using the signed-in Cursor IDE token.
 */
export async function collect({
  now = new Date(),
  readToken = readCursorAccessToken,
  fetchGrok = fetchGrokBotUsage,
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
      "grok-bot",
      "Cursor local state DB has no signed-in access token (state.vscdb / storage.json missing or unread). No Grok Bot figures fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  const grok = await fetchGrok({ token, baseUrl });
  token = "";

  if (!grok.ok) {
    const authHint =
      grok.status === 401 || grok.status === 403
        ? " Cursor access token was rejected; re-sign-in to the Cursor app and retry."
        : "";
    return unknown(
      "grok-bot",
      `GetSandUsageStatus was unavailable${grok.status ? ` (HTTP ${grok.status})` : ""}.${authHint} No Grok Bot figures fabricated.`,
      { collectionMode: "unavailable" },
    );
  }

  const parsed = parseGrokBotUsage(grok.json);
  if (!parsed) {
    return unknown(
      "grok-bot",
      "GetSandUsageStatus returned no personal included/on-demand Grok Bot meter for this account. No figures fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  const included = parsed.components.find((c) => c.id === "included");
  const onDemand = parsed.components.find((c) => c.id === "on-demand");
  const parts = [];
  if (included) parts.push(`Included ${included.usage}%`);
  if (onDemand) {
    parts.push(
      onDemand.unit === "USD" && onDemand.limit != null
        ? `On-demand $${onDemand.usage}/$${onDemand.limit}`
        : `On-demand ${onDemand.usage}${onDemand.limit != null ? `/${onDemand.limit}` : ""}`,
    );
  }

  const notes = parsed.missing.length
    ? ` Missing from API response: ${parsed.missing.join(", ")}.`
    : "";

  return {
    id: "grok-bot",
    status: "measured",
    collectionMode: "automatic",
    reason:
      `Live from the signed-in Cursor IDE session via GetSandUsageStatus: ` +
      `${parts.join("; ") || "partial meters"}. ` +
      `Same local login pattern as Cursor Agent (no browser scrape).${notes}`,
    usage: null,
    limit: null,
    unit: "mixed (see components)",
    resetDate: parsed.resetDate,
    lastUpdate: now.toISOString(),
    coverageStart: null,
    breakdown: null,
    components: parsed.components,
    usageUrl: "https://cursor.com/dashboard",
    pace: { daily: null, monthly: null, weeklyTarget: null },
    history: [],
  };
}
