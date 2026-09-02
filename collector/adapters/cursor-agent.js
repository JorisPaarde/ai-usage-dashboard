import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unknown } from "../lib/adapter-result.js";

const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const API_BASE = "https://api2.cursor.sh";
const PERIOD_USAGE_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const GROK_BOT_PATH = "/aiserver.v1.DashboardService/GetSandUsageStatus";
const HARD_LIMIT_PATH = "/aiserver.v1.DashboardService/GetHardLimit";
const USAGE_SUMMARY_PATH = "/api/usage/summary";
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Platform paths for Cursor's signed-in IDE state (same session the app uses).
 * Token lives in ItemTable under cursorAuth/accessToken; storage.json is a
 * secondary fallback some installs still keep.
 * @param {string} [home]
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveCursorStatePaths(
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
) {
  let base;
  if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support", "Cursor");
  } else if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    base = path.join(appData, "Cursor");
  } else {
    base = path.join(home, ".config", "Cursor");
  }
  const globalStorage = path.join(base, "User", "globalStorage");
  return {
    stateDb: path.join(globalStorage, "state.vscdb"),
    storageJson: path.join(globalStorage, "storage.json"),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read a single ItemTable value via node:sqlite when available (Node 22+).
 * @param {string} dbPath
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function readViaNodeSqlite(dbPath, key) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
    const value = row?.value;
    if (isNonEmptyString(value)) return value.trim();
    if (value instanceof Uint8Array) {
      const text = Buffer.from(value).toString("utf8").trim();
      return text || null;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Read via the sqlite3 CLI (common on macOS hosts that run Cursor).
 * @param {string} dbPath
 * @param {string} key
 * @param {typeof spawn} spawnImpl
 * @returns {Promise<string|null>}
 */
function readViaSqliteCli(dbPath, key, spawnImpl) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        "sqlite3",
        ["-readonly", dbPath, `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';`],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let stdout = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    child.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const text = stdout.trim();
      finish(text || null);
    });
  });
}

/**
 * Best-effort read of cursorAuth/accessToken from storage.json.
 * @param {string} storagePath
 * @param {(p: string, enc: string) => Promise<string>} readText
 */
async function readTokenFromStorageJson(storagePath, readText) {
  let raw;
  try {
    raw = await readText(storagePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const direct = parsed[ACCESS_TOKEN_KEY];
  if (isNonEmptyString(direct)) return direct.trim();
  return null;
}

/**
 * Read the signed-in Cursor access token from local IDE state.
 * Never logs or returns structured error text that could embed the token.
 *
 * @param {{
 *   stateDb?: string,
 *   storageJson?: string,
 *   spawnImpl?: typeof spawn,
 *   readText?: typeof readFile,
 *   exists?: (p: string) => Promise<boolean>,
 * }} [opts]
 * @returns {Promise<string|null>}
 */
export async function readCursorAccessToken({
  stateDb,
  storageJson,
  spawnImpl = spawn,
  readText = readFile,
  exists = async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  const defaults = resolveCursorStatePaths();
  const dbPath = stateDb || process.env.CURSOR_STATE_DB || defaults.stateDb;
  const jsonPath =
    storageJson || process.env.CURSOR_STORAGE_JSON || defaults.storageJson;

  if (await exists(dbPath)) {
    const fromNode = await readViaNodeSqlite(dbPath, ACCESS_TOKEN_KEY);
    if (fromNode) return fromNode;
    const fromCli = await readViaSqliteCli(dbPath, ACCESS_TOKEN_KEY, spawnImpl);
    if (fromCli) return fromCli;
  }

  if (await exists(jsonPath)) {
    return readTokenFromStorageJson(jsonPath, readText);
  }
  return null;
}

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
  // Spending page shows a calendar day for the plan cycle.
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
  // Some responses nest the percentages; others lift them to the root.
  const auto =
    autoPercent ?? num(json.autoPercentUsed);
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

  // Need at least one capacity meter to treat the response as usable.
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

  // Prefer the personal cap (matches the Spending page for Pro/Pro+).
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

  // Spent without a configured hard limit — still publish the dollars used.
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
  // hardLimit is dollars on some shapes, cents on others — Spending page uses
  // whole dollars (e.g. 75). Values >= 1000 are almost certainly cents.
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
      // Summary values are typically cents for on-demand pools.
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
 * Map GetSandUsageStatus → Grok Bot weekly component, or null when ineligible.
 * @param {unknown} json
 * @returns {object|null}
 */
export function parseGrokBotUsage(json) {
  if (!isRecord(json)) return null;
  if (json.usesPooledEnterpriseAllowance === true) return null;
  if (json.hasNonZeroIncludedLimit === false) return null;
  if (json.includedLimitZero === true) return null;

  const percent = num(json.usagePercent);
  if (percent == null || percent < 0) return null;

  const reset =
    normalizeCycleTimestamp(json.nextResetTimestampUtc) ||
    (typeof json.nextResetTimestampUtc === "string"
      ? json.nextResetTimestampUtc
      : null);

  return {
    id: "grok-bot",
    label: "Grok Bot (weekly)",
    role: "capped",
    usage: Math.min(percent, 100),
    limit: 100,
    unit: "% of weekly allowance",
    resetDate: reset,
  };
}

/**
 * POST/GET helper. Token is used only in the Authorization header and never
 * written into returned error objects.
 * @param {{
 *   url: string,
 *   method?: string,
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ ok: true, json: unknown } | { ok: false, status?: number }>}
 */
export async function cursorApiRequest({
  url,
  method = "POST",
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "ai-usage-dashboard",
    };
    /** @type {RequestInit} */
    const init = { method, headers, signal: controller.signal };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Connect-Protocol-Version"] = "1";
      init.body = "{}";
    }
    const res = await fetchImpl(url, init);
    if (!res || typeof res.status !== "number") return { ok: false };
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, status: res.status };
    }
    return { ok: true, json };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ token: string, baseUrl?: string, fetchImpl?: typeof fetch }} opts
 */
export function fetchCurrentPeriodUsage({
  token,
  baseUrl = API_BASE,
  fetchImpl = globalThis.fetch,
}) {
  return cursorApiRequest({
    url: `${baseUrl.replace(/\/$/, "")}${PERIOD_USAGE_PATH}`,
    method: "POST",
    token,
    fetchImpl,
  });
}

/**
 * @param {{ token: string, baseUrl?: string, fetchImpl?: typeof fetch }} opts
 */
export function fetchGrokBotUsage({
  token,
  baseUrl = API_BASE,
  fetchImpl = globalThis.fetch,
}) {
  return cursorApiRequest({
    url: `${baseUrl.replace(/\/$/, "")}${GROK_BOT_PATH}`,
    method: "POST",
    token,
    fetchImpl,
  });
}

/**
 * @param {{ token: string, baseUrl?: string, fetchImpl?: typeof fetch }} opts
 */
export function fetchHardLimit({
  token,
  baseUrl = API_BASE,
  fetchImpl = globalThis.fetch,
}) {
  return cursorApiRequest({
    url: `${baseUrl.replace(/\/$/, "")}${HARD_LIMIT_PATH}`,
    method: "POST",
    token,
    fetchImpl,
  });
}

/**
 * @param {{ token: string, baseUrl?: string, fetchImpl?: typeof fetch }} opts
 */
export function fetchUsageSummary({
  token,
  baseUrl = API_BASE,
  fetchImpl = globalThis.fetch,
}) {
  return cursorApiRequest({
    url: `${baseUrl.replace(/\/$/, "")}${USAGE_SUMMARY_PATH}`,
    method: "GET",
    token,
    fetchImpl,
  });
}

/**
 * Cursor Agent spending meters via the signed-in local IDE session.
 *
 * Preferred route: Bearer token from Cursor's local state DB → Connect RPC
 * GetCurrentPeriodUsage (Included / Other / On-demand). Optional
 * GetSandUsageStatus for the separate Grok Bot weekly meter.
 *
 * Fail closed when the token or DB is missing — never fabricate percentages.
 */
export async function collect({
  now = new Date(),
  readToken = readCursorAccessToken,
  fetchPeriod = fetchCurrentPeriodUsage,
  fetchGrok = fetchGrokBotUsage,
  fetchHard = fetchHardLimit,
  fetchSummary = fetchUsageSummary,
  baseUrl = process.env.CURSOR_API_BASE || API_BASE,
} = {}) {
  let token;
  try {
    token = await readToken();
  } catch {
    token = null;
  }

  if (!isNonEmptyString(token)) {
    return unknown(
      "cursor-agent",
      "Cursor local state DB has no signed-in access token (state.vscdb / storage.json missing or unread). No spending figures fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  const period = await fetchPeriod({ token, baseUrl });
  // Drop the token reference as soon as requests are issued from helpers that
  // already captured it; avoid leaving it on the collect stack for longer than
  // needed in reason construction.
  token = /** @type {string} */ (token);

  if (!period.ok) {
    const authHint =
      period.status === 401 || period.status === 403
        ? " Cursor access token was rejected; re-sign-in to the Cursor app and retry."
        : "";
    return unknown(
      "cursor-agent",
      `GetCurrentPeriodUsage was unavailable${period.status ? ` (HTTP ${period.status})` : ""}.${authHint} No spending figures fabricated.`,
      { collectionMode: "unavailable" },
    );
  }

  const parsed = parsePeriodUsage(period.json);
  if (!parsed) {
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

  const grok = await fetchGrok({ token, baseUrl });
  // Clear local binding; do not retain token beyond this point.
  token = "";
  if (grok.ok) {
    const grokComponent = parseGrokBotUsage(grok.json);
    if (grokComponent) {
      components.push(grokComponent);
    } else {
      notes.push(
        "Grok Bot weekly % omitted: GetSandUsageStatus returned no personal weekly meter for this account",
      );
    }
  } else {
    notes.push(
      "Grok Bot weekly % omitted: GetSandUsageStatus unavailable (not present on GetCurrentPeriodUsage)",
    );
  }

  if (parsed.missing.length) {
    notes.push(`Missing from API response: ${parsed.missing.join(", ")}`);
  }

  const included = components.find((c) => c.id === "included-cursor-models");
  const other = components.find((c) => c.id === "other-models");
  const onDemand = components.find((c) => c.id === "on-demand");
  const grokBot = components.find((c) => c.id === "grok-bot");

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
  if (grokBot) parts.push(`Grok Bot weekly ${grokBot.usage}%`);

  const reason =
    `Live from the signed-in Cursor IDE session via GetCurrentPeriodUsage` +
    `${grokBot ? " + GetSandUsageStatus" : ""}: ${parts.join("; ") || "partial meters"}. ` +
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
