/**
 * Sail Research — official Usage API, same numbers as app.sailresearch.com/usage.
 *
 *   SAIL_API_KEY
 *   GET https://api.sailresearch.com/v2/usage/summary?range=period
 *   GET https://api.sailresearch.com/v2/usage/breakdown?range=7d
 *
 * Monetary fields are fractional USD cents. Converted to USD for the dashboard.
 * No browser scrape. Key never enters the snapshot.
 */
import { unknown } from "../lib/adapter-result.js";
import { jsonGet, envKey } from "../lib/json-get.js";
import { compactHistory } from "../lib/pace.js";

export const SOURCE_ID = "sail";
export const DEFAULT_BASE = "https://api.sailresearch.com";
export const USAGE_URL = "https://app.sailresearch.com/usage";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Sail documents monetary fields as fractional USD cents (73795.09 ≈ $737.95).
 * @param {unknown} cents
 * @returns {number|null}
 */
export function centsToUsd(cents) {
  const n = finiteNumber(cents);
  if (n == null) return null;
  return Math.round(n) / 100;
}

/**
 * @param {unknown} payload GET /v2/usage/summary body
 * @returns {{
 *   spend: number,
 *   balance: number|null,
 *   limit: number|null,
 *   inference: number|null,
 *   sailboxes: number|null,
 * } | null}
 */
export function summaryMeter(payload) {
  if (!payload || typeof payload !== "object") return null;
  const spendCents = finiteNumber(payload.period_spend);
  if (spendCents == null) return null;
  const spend = centsToUsd(spendCents);
  const balanceCents =
    payload.balance_unavailable === true ? null : finiteNumber(payload.balance);
  const balance = centsToUsd(balanceCents);
  const inference = centsToUsd(payload.product_spend?.inference);
  const sailboxes = centsToUsd(payload.product_spend?.sailboxes);
  const limit =
    spendCents != null && balanceCents != null && balanceCents >= 0
      ? centsToUsd(spendCents + balanceCents)
      : null;
  return { spend, balance, limit, inference, sailboxes };
}

/**
 * Daily combined spend from /v2/usage/breakdown, in USD.
 * Model names stay out of the published snapshot.
 * @param {unknown} payload
 * @returns {Array<{date: string, usage: number}>}
 */
export function historyFromBreakdown(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  /** @type {Array<{date: string, usage: number}>} */
  const history = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const stamp = row.timestamp;
    const usd = centsToUsd(row.total);
    if (typeof stamp !== "string" || usd == null) continue;
    const date = stamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    history.push({ date, usage: usd });
  }
  return compactHistory(history);
}

/**
 * @param {{
 *   now?: Date,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   baseUrl?: string,
 * }} [opts]
 */
export async function collect({
  now = new Date(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  baseUrl = env.SAIL_API_BASE || DEFAULT_BASE,
} = {}) {
  const apiKey = envKey("SAIL_API_KEY", env);
  if (!apiKey) {
    return unknown(
      SOURCE_ID,
      "No Sail API key on this host (set SAIL_API_KEY in ~/.config/ai-usage-dashboard/env). Official GET /v2/usage/summary; no browser scrape. No usage fabricated.",
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  const origin = String(baseUrl).replace(/\/$/, "");
  const summaryRes = await jsonGet(`${origin}/v2/usage/summary?range=period`, {
    token: apiKey,
    fetchImpl,
  });

  if (summaryRes.status === 401) {
    return unknown(
      SOURCE_ID,
      "Sail rejected the local API key (HTTP 401). Key never published. No usage fabricated.",
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  if (summaryRes.status === 402) {
    return {
      id: SOURCE_ID,
      status: "measured",
      collectionMode: "automatic",
      reason:
        "Sail Usage API returned HTTP 402 credits_exhausted; remaining prepaid balance is treated as empty. Same signal as app.sailresearch.com/usage. No usage fabricated beyond the provider's exhausted flag.",
      usage: 100,
      limit: 100,
      unit: "% of prepaid credits",
      resetDate: null,
      lastUpdate: now.toISOString(),
      coverageStart: null,
      breakdown: null,
      components: [
        {
          id: "period",
          label: "Billing period",
          role: "capacity",
          usage: 100,
          limit: 100,
          unit: "% of prepaid credits",
          resetDate: null,
        },
      ],
      usageUrl: USAGE_URL,
      pace: { daily: null, monthly: null, weeklyTarget: null },
      history: [],
    };
  }

  if (!summaryRes.ok) {
    return unknown(
      SOURCE_ID,
      `Sail Usage API /v2/usage/summary was unreachable${summaryRes.status ? ` (HTTP ${summaryRes.status})` : ""}. No usage fabricated.`,
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  const meter = summaryMeter(summaryRes.json);
  if (!meter) {
    return unknown(
      SOURCE_ID,
      "Sail Usage API returned no numeric period_spend. No usage fabricated.",
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  const breakdownRes = await jsonGet(`${origin}/v2/usage/breakdown?range=7d`, {
    token: apiKey,
    fetchImpl,
  });
  const history = breakdownRes.ok ? historyFromBreakdown(breakdownRes.json) : [];

  /** @type {object[]} */
  const components = [
    {
      id: "period",
      label: "Billing period",
      role: "capacity",
      usage: meter.spend,
      limit: meter.limit,
      unit: "USD",
      resetDate: null,
    },
  ];
  if (meter.inference != null) {
    components.push({
      id: "inference",
      label: "Inference",
      usage: meter.inference,
      limit: null,
      unit: "USD",
      resetDate: null,
    });
  }
  if (meter.sailboxes != null) {
    components.push({
      id: "sailboxes",
      label: "Sailboxes",
      usage: meter.sailboxes,
      limit: null,
      unit: "USD",
      resetDate: null,
    });
  }

  const remainingNote =
    meter.balance != null
      ? `${meter.balance.toFixed(2)} USD remaining`
      : "remaining balance unavailable";
  const potNote =
    meter.limit != null ? ` of a ${meter.limit.toFixed(2)} USD pot` : "";

  return {
    id: SOURCE_ID,
    status: "measured",
    collectionMode: "automatic",
    reason:
      `Live from Sail Usage API (current billing period): ${meter.spend.toFixed(2)} USD spent, ${remainingNote}${potNote}. ` +
      "Read-only GET /v2/usage/summary (no model call). Same figures as app.sailresearch.com/usage.",
    usage: meter.spend,
    limit: meter.limit,
    unit: "USD",
    resetDate: null,
    lastUpdate: now.toISOString(),
    coverageStart: null,
    breakdown: null,
    components,
    usageUrl: USAGE_URL,
    pace: { daily: null, monthly: null, weeklyTarget: null },
    history,
  };
}
