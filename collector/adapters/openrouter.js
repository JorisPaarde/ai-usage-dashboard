import { unknown } from "../lib/adapter-result.js";

/**
 * OpenRouter usage via its public API.
 *
 * Unlike the signed-in desktop tools (Codex, Cursor, Claude) there is no local
 * meter to read; OpenRouter is a credit account. The read-only API endpoints
 * below expose spend, which is the same figure the provider's billing page
 * shows:
 *
 *   GET /api/v1/credits  -> { data: { total_credits, total_usage } }
 *   GET /api/v1/auth/key -> { data: { usage, usage_daily, usage_weekly,
 *                                     usage_monthly, ... } }
 *
 * Both calls are GETs that cost no tokens — safe for a 15-minute schedule.
 *
 * OpenRouter is pay-per-token with no hard limit by default, so there is no
 * "capacity" percentage to derive: the source reports spend (usage) against the
 * credited balance (limit). That keeps it honest — a prepaid credit account is
 * measured by consumption against balance, not by a fake % of an unset limit.
 */

const API_BASE = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Read the current OpenRouter usage + balance.
 * Resolves null when the key is missing, the API is unreachable, or the
 * response is not the expected shape (in which case we must not guess).
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey]    e.g. from process.env.OPENROUTER_API_KEY
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object|null>} normalized reading or null
 */
export async function readOpenRouterUsage({
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!apiKey) return null;

  const headers = { Authorization: `Bearer ${apiKey}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [creditsRes, keyRes] = await Promise.all([
      fetchImpl(`${API_BASE}/credits`, {
        headers,
        signal: controller.signal,
      }),
      fetchImpl(`${API_BASE}/auth/key`, {
        headers,
        signal: controller.signal,
      }),
    ]);
    if (!creditsRes.ok || !keyRes.ok) return null;

    const [credits, key] = await Promise.all([
      creditsRes.json(),
      keyRes.json(),
    ]);
    const c = credits?.data;
    const k = key?.data;
    if (typeof c?.total_credits !== "number") return null;

    return {
      totalCredits: c.total_credits,
      totalUsage: typeof c.total_usage === "number" ? c.total_usage : null,
      usage: typeof k?.usage === "number" ? k.usage : null,
      usageDaily: typeof k?.usage_daily === "number" ? k.usage_daily : null,
      usageWeekly: typeof k?.usage_weekly === "number" ? k.usage_weekly : null,
      usageMonthly: typeof k?.usage_monthly === "number" ? k.usage_monthly : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect OpenRouter usage into an AdapterResult.
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function collect({ now = new Date(), ...rest } = {}) {
  const reading = await readOpenRouterUsage(rest);
  if (!reading) {
    return unknown(
      "openrouter",
      "No OPENROUTER_API_KEY, or the OpenRouter API did not return the expected usage payload. Unavailable rather than guessed.",
      { lastUpdate: now.toISOString() },
    );
  }

  const issue = (msg) =>
    unknown("openrouter", msg, { lastUpdate: now.toISOString() });

  // Total credits is our limit (balance); usage is the $ spent crediting that
  // balance. Both needed for a percentage; otherwise report spend-only.
  if (typeof reading.totalCredits !== "number" || reading.totalCredits <= 0) {
    return issue(
      "OpenRouter reported no credited balance — no limit to measure against.",
    );
  }

  const usage = reading.totalUsage;
  if (typeof usage !== "number" || usage < 0) {
    return issue(
      "OpenRouter reported usage but no valid $ figure — reporting unknown.",
    );
  }

  return {
    id: "openrouter",
    status: "measured",
    collectionMode: "automatic",
    reason: buildReason(reading),
    usage,
    limit: reading.totalCredits,
    unit: "$ spend vs credited balance",
    lastUpdate: now.toISOString(),
    resetDate: null, // rollover is continuous; no provider reset window
    // daily/weekly/monthly spend live in `breakdown`; normaliseSource zeroes
    // pace.daily/monthly by product convention, so don't set them here.
    history: [],
    coverageStart: null,
    breakdown: {
      totalCredits: reading.totalCredits,
      usage: reading.usage,
      usageDaily: reading.usageDaily,
      usageWeekly: reading.usageWeekly,
      usageMonthly: reading.usageMonthly,
    },
    usageUrl: "https://openrouter.ai/settings/usage",
  };
}

function buildReason(r) {
  const parts = ["OpenRouter credit account, read live from the API."];
  if (typeof r.usageMonthly === "number") {
    parts.push(`Monthly spend $${fmt(r.usageMonthly)}.`);
  }
  if (typeof r.totalUsage === "number") {
    parts.push(`Total $${fmt(r.totalUsage)} credited against $${fmt(r.totalCredits)} balance.`);
  }
  if (typeof r.usageDaily === "number") {
    parts.push(`Today $${fmt(r.usageDaily)}.`);
  }
  return parts.join(" ");
}

function fmt(n) {
  return Number.isFinite(n) && Math.round(n * 1000) / 1000 === n
    ? String(n)
    : Number(n.toFixed(3));
}