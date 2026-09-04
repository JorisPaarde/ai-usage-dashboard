/**
 * OpenRouter — official usage APIs, no browser scrape.
 *
 * Keys (never published):
 *   OPENROUTER_API_KEY          inference or management key
 *   OPENROUTER_MANAGEMENT_KEY   optional; preferred for /credits and /activity
 *
 * Routes (all GET, read-only, no model call):
 *   /api/v1/key        any key — lifetime usage and optional per-key cap
 *   /api/v1/credits    management key — total purchased vs used (USD)
 *   /api/v1/activity   management key — daily USD history (last 30 UTC days)
 *
 * Ground-truth page: https://openrouter.ai/workspaces/default
 */
import { unknown } from "../lib/adapter-result.js";
import { jsonGet, envKey } from "../lib/json-get.js";
import { compactHistory } from "../lib/pace.js";

export const SOURCE_ID = "openrouter";
export const DEFAULT_BASE = "https://openrouter.ai/api/v1";
export const USAGE_URL = "https://openrouter.ai/workspaces/default";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Sum activity rows into YYYY-MM-DD → USD. Model names, endpoint ids,
 * providers, and workspace ids stay out of the published snapshot.
 * @param {unknown} payload
 * @returns {Array<{date: string, usage: number}>}
 */
export function historyFromActivity(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  /** @type {Map<string, number>} */
  const byDate = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const date = row.date;
    const usage = finiteNumber(row.usage);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (usage == null) continue;
    byDate.set(date, (byDate.get(date) || 0) + usage);
  }
  return compactHistory(
    [...byDate.entries()].map(([date, usage]) => ({ date, usage })),
  );
}

/**
 * @param {unknown} payload GET /credits body
 * @returns {{ usage: number, limit: number } | null}
 */
export function creditsMeter(payload) {
  const data = payload && typeof payload === "object" ? payload.data : null;
  if (!data || typeof data !== "object") return null;
  const usage = finiteNumber(data.total_usage);
  const limit = finiteNumber(data.total_credits);
  if (usage == null || limit == null || limit <= 0) return null;
  return { usage, limit };
}

/**
 * Per-key spending cap. `usage` on the key is lifetime spend, not the cap
 * window, so the cap itself is `limit - limit_remaining`.
 * @param {unknown} payload GET /key body
 * @returns {{ usage: number, limit: number, reset: string|null } | null}
 */
export function keyLimitMeter(payload) {
  const data = payload && typeof payload === "object" ? payload.data : null;
  if (!data || typeof data !== "object") return null;
  const limit = finiteNumber(data.limit);
  const remaining = finiteNumber(data.limit_remaining);
  if (limit == null || limit <= 0 || remaining == null) return null;
  return {
    usage: Math.max(0, limit - remaining),
    limit,
    reset: typeof data.limit_reset === "string" ? data.limit_reset : null,
  };
}

function resolveKeys(env) {
  return {
    apiKey: envKey("OPENROUTER_API_KEY", env),
    managementKey:
      envKey("OPENROUTER_MANAGEMENT_KEY", env) || envKey("OPENROUTER_API_KEY", env),
  };
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
  baseUrl = env.OPENROUTER_API_BASE || DEFAULT_BASE,
} = {}) {
  const { apiKey, managementKey } = resolveKeys(env);
  if (!apiKey && !managementKey) {
    return unknown(
      SOURCE_ID,
      "No OpenRouter API key on this host (set OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_KEY in ~/.config/ai-usage-dashboard/env). Official GET /api/v1/credits + /api/v1/key; no browser scrape. No usage fabricated.",
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  const origin = String(baseUrl).replace(/\/$/, "");
  const get = (path, token) => jsonGet(`${origin}${path}`, { token, fetchImpl });

  const creditsRes = managementKey ? await get("/credits", managementKey) : { ok: false };
  const keyRes = apiKey ? await get("/key", apiKey) : { ok: false };
  const credits = creditsRes.ok ? creditsMeter(creditsRes.json) : null;
  const keyLimit = keyRes.ok ? keyLimitMeter(keyRes.json) : null;

  if (creditsRes.status === 401 || keyRes.status === 401) {
    return unknown(
      SOURCE_ID,
      "OpenRouter rejected the local API key (HTTP 401). Key never published. No usage fabricated.",
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  /** @type {object[]} */
  const components = [];
  if (credits) {
    components.push({
      id: "credits",
      label: "Account credits",
      role: "capacity",
      usage: credits.usage,
      limit: credits.limit,
      unit: "USD",
      resetDate: null,
    });
  }
  if (keyLimit) {
    components.push({
      id: "key-limit",
      label: "Key spending cap",
      role: "capped",
      usage: keyLimit.usage,
      limit: keyLimit.limit,
      unit: "USD",
      resetDate: keyLimit.reset,
    });
  }

  const headline = keyLimit || credits;
  if (!headline) {
    const keyFailed = !keyRes.ok;
    const creditsDenied = creditsRes.status === 403;
    const why = keyFailed
      ? "OpenRouter /api/v1/key was unreachable or returned no numeric usage."
      : creditsDenied
        ? "This key cannot read /api/v1/credits (management key required) and the inference key has no spending cap, so there is no usage/limit pair."
        : "OpenRouter returned no usage/limit pair (no account credits and no per-key cap).";
    return unknown(
      SOURCE_ID,
      `${why} No usage fabricated.`,
      { collectionMode: "unavailable", unit: "USD" },
    );
  }

  let history = [];
  if (managementKey && creditsRes.ok) {
    const activityRes = await get("/activity", managementKey);
    if (activityRes.ok) history = historyFromActivity(activityRes.json);
  }

  const remaining = headline.limit - headline.usage;
  const creditsNote = credits
    ? `account ${credits.usage} / ${credits.limit} USD used`
    : "";
  const capNote = keyLimit
    ? `key cap ${keyLimit.usage} / ${keyLimit.limit} USD used`
    : "";
  const parts = [creditsNote, capNote].filter(Boolean);

  return {
    id: SOURCE_ID,
    status: "measured",
    collectionMode: "automatic",
    reason:
      `Live from OpenRouter ${parts.join("; ")} (${remaining.toFixed(2)} USD remaining on the headline meter). ` +
      "Read-only GET /api/v1/credits and/or /api/v1/key (no model call). Same figures as openrouter.ai/workspaces/default.",
    usage: headline.usage,
    limit: headline.limit,
    unit: "USD",
    resetDate: keyLimit?.reset ?? null,
    lastUpdate: now.toISOString(),
    coverageStart: null,
    breakdown: null,
    components: components.length ? components : null,
    usageUrl: USAGE_URL,
    pace: { daily: null, monthly: null, weeklyTarget: null },
    history,
  };
}
