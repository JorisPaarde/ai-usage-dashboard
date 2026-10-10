import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unknown } from "../lib/adapter-result.js";
import { dateKeyInZone } from "../lib/pace.js";

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_CREDENTIALS_FILE = path.join(
  os.homedir(),
  ".claude",
  ".credentials.json",
);
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OAUTH_BETA = "oauth-2025-04-20";
/** Claude Code OAuth Messages surface (required with setup / claude.ai tokens). */
const CLAUDE_CODE_BETA = "claude-code-20250219,oauth-2025-04-20";
const OAUTH_TIMEOUT_MS = 15000;
/** Hard-coded Haiku probe when /api/oauth/usage returns 403. */
const HAIKU_PROBE_MODEL = "claude-haiku-4-5-20251001";
/** Claude Code identity string required for OAuth Messages (Haiku is often exempt; send anyway). */
const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const DEFAULT_OAUTH_CACHE_TTL_MINUTES = 60;
export const DEFAULT_OAUTH_CACHE_FILE = path.join(
  os.homedir(),
  ".config",
  "ai-usage-dashboard",
  "claude-oauth-usage.json",
);

const HEADER_5H_UTIL = "anthropic-ratelimit-unified-5h-utilization";
const HEADER_5H_RESET = "anthropic-ratelimit-unified-5h-reset";
const HEADER_7D_UTIL = "anthropic-ratelimit-unified-7d-utilization";
const HEADER_7D_RESET = "anthropic-ratelimit-unified-7d-reset";

const READING_SOURCES = new Set(["oauth", "haiku"]);

function monthKeyInAmsterdam(now) {
  return dateKeyInZone(now).slice(0, 7);
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundPct(value) {
  return Math.round(value * 1000) / 1000;
}

function validIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function configuredCacheTtlMinutes(raw = process.env.CLAUDE_OAUTH_CACHE_TTL_MINUTES) {
  if (raw == null || raw === "") return DEFAULT_OAUTH_CACHE_TTL_MINUTES;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_OAUTH_CACHE_TTL_MINUTES;
}

/**
 * Retry-After is either delta-seconds or an HTTP date.
 * @param {unknown} raw
 * @param {Date} now
 */
export function retryAfterTimestamp(raw, now = new Date()) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return new Date(now.getTime() + Number(value) * 1000).toISOString();
  }
  return validIso(value);
}

/**
 * Normalize reset timestamps from OAuth usage (unix seconds or ISO).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeOauthReset(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    if (/^\d+$/.test(raw.trim())) {
      return normalizeOauthReset(Number(raw.trim()));
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Calendar-day label when the reset is midnight-ish UTC.
 * @param {string|null} iso
 */
function monthResetLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0
  ) {
    return iso.slice(0, 10);
  }
  return iso;
}

/**
 * Read Claude.ai OAuth access token.
 * Prefer `CLAUDE_CODE_OAUTH_TOKEN` (box setup token), then
 * `~/.claude/.credentials.json`. Token is for Authorization only — never log it.
 *
 * @param {{
 *   credentialsPath?: string,
 *   readText?: typeof readFile,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {Promise<string|null>}
 */
export async function readClaudeOauthToken({
  credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_FILE,
  readText = readFile,
  env = process.env,
} = {}) {
  const fromEnv =
    typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string"
      ? env.CLAUDE_CODE_OAUTH_TOKEN.trim()
      : "";
  if (fromEnv) return fromEnv;

  let raw;
  try {
    raw = await readText(credentialsPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  const token = oauth?.accessToken;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

/**
 * Map Anthropic OAuth usage JSON → dashboard components.
 * Deliberately narrow: never copies account ids, emails, or plan names.
 *
 * @param {unknown} json
 * @returns {{
 *   components: object[],
 *   resetDate: string|null,
 *   missing: string[],
 * }|null}
 */
export function parseOauthUsage(json) {
  if (!isRecord(json)) return null;

  /** @type {object[]} */
  const components = [];
  /** @type {string[]} */
  const missing = [];

  const fiveHour = isRecord(json.five_hour) ? json.five_hour : null;
  const sessionPct =
    num(fiveHour?.utilization) ??
    num(fiveHour?.used_percentage) ??
    num(fiveHour?.usedPercent);
  if (typeof sessionPct === "number") {
    components.push({
      id: "session",
      label: "Session window",
      role: "capacity",
      usage: roundPct(sessionPct),
      limit: 100,
      unit: "% of session limit",
      resetDate: normalizeOauthReset(fiveHour?.resets_at ?? fiveHour?.resetsAt),
    });
  } else {
    missing.push("session %");
  }

  const sevenDay = isRecord(json.seven_day) ? json.seven_day : null;
  const weeklyPct =
    num(sevenDay?.utilization) ??
    num(sevenDay?.used_percentage) ??
    num(sevenDay?.usedPercent);
  if (typeof weeklyPct === "number") {
    components.push({
      id: "weekly-all-models",
      label: "Weekly (all models)",
      role: "capacity",
      usage: roundPct(weeklyPct),
      limit: 100,
      unit: "% of weekly limit",
      resetDate: normalizeOauthReset(sevenDay?.resets_at ?? sevenDay?.resetsAt),
    });
  } else {
    missing.push("weekly %");
  }

  const extra = isRecord(json.extra_usage) ? json.extra_usage : null;
  if (extra) {
    const used = num(extra.used) ?? num(extra.usage) ?? num(extra.spent);
    const limit = num(extra.limit) ?? num(extra.allowance);
    const currency =
      typeof extra.currency === "string" && extra.currency.trim()
        ? extra.currency.trim().toUpperCase()
        : "EUR";
    if (typeof used === "number" && typeof limit === "number" && limit > 0) {
      components.push({
        id: "usage-credits",
        label: "Usage credits",
        role: "capped",
        usage: used,
        limit,
        unit: currency,
        resetDate: monthResetLabel(
          normalizeOauthReset(extra.resets_at ?? extra.resetsAt),
        ),
      });
    } else if (typeof used === "number") {
      components.push({
        id: "usage-credits",
        label: "Usage credits",
        role: "capped",
        usage: used,
        limit: null,
        unit: currency,
        resetDate: monthResetLabel(
          normalizeOauthReset(extra.resets_at ?? extra.resetsAt),
        ),
      });
    } else {
      missing.push("usage credits");
    }
  }

  if (!components.length) return null;

  const resetDate =
    components.find((c) => c.id === "usage-credits")?.resetDate ||
    components.find((c) => c.id === "weekly-all-models")?.resetDate ||
    components.find((c) => c.id === "session")?.resetDate ||
    null;

  return { components, resetDate, missing, source: "oauth" };
}

function sanitizeCachedOauth(value) {
  if (!isRecord(value) || !Array.isArray(value.components)) return null;
  const allowedIds = new Set(["session", "weekly-all-models", "usage-credits"]);
  const components = [];
  for (const component of value.components) {
    if (!isRecord(component) || !allowedIds.has(component.id)) return null;
    if (typeof component.usage !== "number" || !Number.isFinite(component.usage)) {
      return null;
    }
    if (
      component.limit != null &&
      (typeof component.limit !== "number" || !Number.isFinite(component.limit))
    ) {
      return null;
    }
    if (
      typeof component.label !== "string" ||
      typeof component.unit !== "string" ||
      !["capacity", "capped"].includes(component.role)
    ) {
      return null;
    }
    const resetDate =
      component.resetDate == null
        ? null
        : /^\d{4}-\d{2}-\d{2}$/.test(component.resetDate)
          ? component.resetDate
          : validIso(component.resetDate);
    if (component.resetDate != null && !resetDate) return null;
    components.push({
      id: component.id,
      label: component.label,
      role: component.role,
      usage: component.usage,
      limit: component.limit ?? null,
      unit: component.unit,
      resetDate,
    });
  }
  if (!components.length) return null;
  const resetDate =
    value.resetDate == null
      ? null
      : /^\d{4}-\d{2}-\d{2}$/.test(value.resetDate)
        ? value.resetDate
        : validIso(value.resetDate);
  if (value.resetDate != null && !resetDate) return null;
  const missing = Array.isArray(value.missing)
    ? value.missing.filter((item) => typeof item === "string").slice(0, 3)
    : [];
  const source = READING_SOURCES.has(value.source) ? value.source : "oauth";
  return { components, resetDate, missing, source };
}

function sanitizeOauthCache(value) {
  if (!isRecord(value)) return null;
  const oauth = sanitizeCachedOauth(value.oauth);
  const measuredAt = oauth ? validIso(value.measuredAt) : null;
  if (oauth && !measuredAt) return null;
  return {
    version: 1,
    measuredAt,
    lastAttemptAt: validIso(value.lastAttemptAt),
    retryAfter: validIso(value.retryAfter),
    oauth,
  };
}

/** Read the narrow, secret-free OAuth cache. Corruption is a cache miss. */
export async function readOauthUsageCache(
  cachePath = process.env.CLAUDE_OAUTH_CACHE_PATH || DEFAULT_OAUTH_CACHE_FILE,
  readText = readFile,
) {
  try {
    return sanitizeOauthCache(JSON.parse(await readText(cachePath, "utf8")));
  } catch {
    return null;
  }
}

/** Write atomically so a stopped collect cannot leave a half-written cache. */
export async function writeOauthUsageCache(
  value,
  cachePath = process.env.CLAUDE_OAUTH_CACHE_PATH || DEFAULT_OAUTH_CACHE_FILE,
) {
  const safe = sanitizeOauthCache(value);
  if (!safe) throw new Error("Refusing to write an invalid Claude OAuth cache");
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(safe, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, cachePath);
}

function nextOauthAttempt(cache, ttlMinutes) {
  if (!cache) return null;
  const base = cache.lastAttemptAt || cache.measuredAt;
  const ttlAt = base
    ? new Date(new Date(base).getTime() + ttlMinutes * 60000)
    : null;
  const retryAt = cache.retryAfter ? new Date(cache.retryAfter) : null;
  if (ttlAt && retryAt) return ttlAt > retryAt ? ttlAt : retryAt;
  return ttlAt || retryAt;
}

/**
 * GET /api/oauth/usage with the local Claude.ai OAuth token.
 * Token stays in the Authorization header only.
 *
 * @param {{
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   url?: string,
 * }} opts
 * @returns {Promise<
 *   { ok: true, json: unknown } |
 *   { ok: false, status?: number, retryAfter?: string|null }
 * >}
 */
export async function fetchOauthUsage({
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = OAUTH_TIMEOUT_MS,
  url = process.env.CLAUDE_OAUTH_USAGE_URL || OAUTH_USAGE_URL,
}) {
  if (typeof fetchImpl !== "function") return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": "ai-usage-dashboard",
      },
      signal: controller.signal,
    });
    if (!res || typeof res.status !== "number") return { ok: false };
    if (res.status < 200 || res.status >= 300) {
      const retryAfter =
        typeof res.headers?.get === "function"
          ? res.headers.get("retry-after")
          : null;
      return { ok: false, status: res.status, retryAfter };
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
 * Parse Anthropic unified rate-limit response headers into the same component
 * shape as /api/oauth/usage (session + weekly-all-models).
 *
 * Utilization headers are a 0–1 fraction (multiply by 100 for %). Reset is
 * unix epoch seconds. Assumed from observed Claude Code / Messages traffic and
 * third-party dumps of anthropic-ratelimit-unified-*.
 *
 * @param {{ get?: (name: string) => string|null }|null|undefined} headers
 * @returns {{
 *   components: object[],
 *   resetDate: string|null,
 *   missing: string[],
 * }|null}
 */
export function parseUnifiedRateLimitHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return null;

  const utilPct = (name) => {
    const raw = headers.get(name);
    if (raw == null || String(raw).trim() === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    // Unified headers are always a 0–1 fraction.
    return roundPct(n * 100);
  };

  /** @type {object[]} */
  const components = [];
  /** @type {string[]} */
  const missing = [];

  const sessionPct = utilPct(HEADER_5H_UTIL);
  if (typeof sessionPct === "number") {
    components.push({
      id: "session",
      label: "Session window",
      role: "capacity",
      usage: sessionPct,
      limit: 100,
      unit: "% of session limit",
      resetDate: normalizeOauthReset(headers.get(HEADER_5H_RESET)),
    });
  } else {
    missing.push("session %");
  }

  const weeklyPct = utilPct(HEADER_7D_UTIL);
  if (typeof weeklyPct === "number") {
    components.push({
      id: "weekly-all-models",
      label: "Weekly (all models)",
      role: "capacity",
      usage: weeklyPct,
      limit: 100,
      unit: "% of weekly limit",
      resetDate: normalizeOauthReset(headers.get(HEADER_7D_RESET)),
    });
  } else {
    missing.push("weekly %");
  }

  if (!components.length) return null;

  const resetDate =
    components.find((c) => c.id === "weekly-all-models")?.resetDate ||
    components.find((c) => c.id === "session")?.resetDate ||
    null;

  return { components, resetDate, missing, source: "haiku" };
}

/**
 * One max_tokens=1 Haiku Messages call to read unified rate-limit headers.
 * Used only when /api/oauth/usage returns 403 (setup token / wrong scope).
 * Sends Claude Code OAuth identity headers + system prompt; only 2xx responses
 * are accepted (rate-limit headers on errors are ignored).
 *
 * @param {{
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<
 *   { ok: true, oauth: object } |
 *   { ok: false, status?: number }
 * >}
 */
export async function fetchHaikuRateLimitHeaders({
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = OAUTH_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": CLAUDE_CODE_BETA,
        "User-Agent": "claude-cli/1.0.0 (external, cli)",
        "x-app": "cli",
      },
      body: JSON.stringify({
        model: HAIKU_PROBE_MODEL,
        max_tokens: 1,
        system: CLAUDE_CODE_SYSTEM,
        messages: [{ role: "user", content: "." }],
      }),
      signal: controller.signal,
    });
    if (!res || typeof res.status !== "number") return { ok: false };
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status };
    }
    const parsed = parseUnifiedRateLimitHeaders(res.headers);
    if (parsed) return { ok: true, oauth: parsed };
    return { ok: false, status: res.status };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sum this month's Claude Code token usage from local transcripts.
 *
 * Transcripts repeat the same assistant message while it streams, so results
 * are de-duplicated on the provider message id. Only the numeric `usage`
 * counters are read — message content, tool results, and file paths are never
 * touched.
 *
 * @param {string} text raw transcript JSONL
 * @param {{ now?: Date, seen?: Set<string> }} [opts]
 */
export function parseTranscript(text, { now = new Date(), seen = new Set() } = {}) {
  const monthKey = monthKeyInAmsterdam(now);
  let promptTokens = 0;
  let outputTokens = 0;
  let generations = 0;
  let firstSeenAt = null;
  let lastSeenAt = null;
  const daily = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;

    const message = entry.message;
    const usage = message?.usage;
    const messageId = message?.id;
    const timestamp = entry.timestamp;
    if (!usage || typeof messageId !== "string" || typeof timestamp !== "string") {
      continue;
    }
    if (seen.has(messageId)) continue;

    const day = dateKeyInZone(timestamp);
    if (!day.startsWith(monthKey)) continue;
    seen.add(messageId);

    const prompt =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    const output = usage.output_tokens || 0;

    promptTokens += prompt;
    outputTokens += output;
    generations += 1;
    daily.set(day, (daily.get(day) || 0) + prompt + output);

    if (!firstSeenAt || timestamp < firstSeenAt) firstSeenAt = timestamp;
    if (!lastSeenAt || timestamp > lastSeenAt) lastSeenAt = timestamp;
  }

  return {
    promptTokens,
    outputTokens,
    generations,
    totalTokens: promptTokens + outputTokens,
    firstSeenAt,
    lastSeenAt,
    history: [...daily.entries()].map(([date, usage]) => ({ date, usage })),
  };
}

/** Merge per-file totals, keeping the shared de-duplication set authoritative. */
function mergeTotals(target, next) {
  target.promptTokens += next.promptTokens;
  target.outputTokens += next.outputTokens;
  target.generations += next.generations;
  target.totalTokens += next.totalTokens;
  if (next.firstSeenAt && (!target.firstSeenAt || next.firstSeenAt < target.firstSeenAt)) {
    target.firstSeenAt = next.firstSeenAt;
  }
  if (next.lastSeenAt && (!target.lastSeenAt || next.lastSeenAt > target.lastSeenAt)) {
    target.lastSeenAt = next.lastSeenAt;
  }
  for (const { date, usage } of next.history) {
    target.daily.set(date, (target.daily.get(date) || 0) + usage);
  }
  return target;
}

async function listTranscripts(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath || entry.path || dir, entry.name));
}

/**
 * @param {{
 *   projectsDir?: string,
 *   listFiles?: typeof listTranscripts,
 *   readTranscript?: typeof readFile,
 *   now?: Date,
 * }} [opts]
 */
async function collectTranscriptTotals({
  projectsDir = process.env.CLAUDE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR,
  listFiles = listTranscripts,
  readTranscript = readFile,
  now = new Date(),
} = {}) {
  let files;
  try {
    files = await listFiles(projectsDir);
  } catch (err) {
    return {
      ok: false,
      reason: `Claude Code transcript directory unavailable (${err?.message || "unreadable"}).`,
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      reason: "No Claude Code transcripts found locally, so token usage cannot be measured.",
    };
  }

  const seen = new Set();
  const totals = {
    promptTokens: 0,
    outputTokens: 0,
    generations: 0,
    totalTokens: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    daily: new Map(),
  };

  for (const file of files) {
    let parsed;
    try {
      parsed = parseTranscript(await readTranscript(file, "utf8"), { now, seen });
    } catch {
      continue;
    }
    mergeTotals(totals, parsed);
  }

  return {
    ok: true,
    totals,
    history: [...totals.daily.entries()].map(([date, usage]) => ({ date, usage })),
  };
}

function tokenReason(totals) {
  const coverage = totals.firstSeenAt
    ? ` Transcript coverage this month starts ${totals.firstSeenAt}.`
    : "";
  return (
    `${totals.totalTokens} tokens this month (${totals.promptTokens} prompt/cache + ` +
    `${totals.outputTokens} output) across ${totals.generations} assistant messages, ` +
    `measured from local Claude Code transcripts.${coverage}`
  );
}

/**
 * Claude Code.
 *
 * Preferred: `CLAUDE_CODE_OAUTH_TOKEN` or `~/.claude/.credentials.json`
 * → `GET /api/oauth/usage` for session / weekly / extra-usage meters.
 * Token never enters the snapshot.
 *
 * Fallback only on HTTP 403 from that usage endpoint (e.g. setup token with
 * `user:inference` only): one max_tokens=1 Haiku Messages request with Claude
 * Code OAuth headers/system prompt, then read unified 5h/7d rate-limit headers
 * from a successful (2xx) response as two bars.
 *
 * Always: local transcript token totals as breakdown / fallback when OAuth is
 * unavailable. Plan percentages are never invented.
 */
export async function collect({
  projectsDir = process.env.CLAUDE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR,
  listFiles = listTranscripts,
  readTranscript = readFile,
  credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_FILE,
  readCredentials = readFile,
  readToken = readClaudeOauthToken,
  queryOauth = fetchOauthUsage,
  queryHaikuHeaders = fetchHaikuRateLimitHeaders,
  fetchImpl = globalThis.fetch,
  oauthCachePath = process.env.CLAUDE_OAUTH_CACHE_PATH || DEFAULT_OAUTH_CACHE_FILE,
  cacheTtlMinutes = configuredCacheTtlMinutes(),
  readOauthCache = readOauthUsageCache,
  writeOauthCache = writeOauthUsageCache,
  now = new Date(),
  env = process.env,
} = {}) {
  const transcript = await collectTranscriptTotals({
    projectsDir,
    listFiles,
    readTranscript,
    now,
  });

  const token = await readToken({
    credentialsPath,
    readText: readCredentials,
    env,
  });

  let oauth = null;
  let oauthMeasuredAt = null;
  let oauthFromCache = false;
  let oauthFailure = null;
  if (token) {
    const cache = await readOauthCache(oauthCachePath);
    const nextAttempt = nextOauthAttempt(cache, cacheTtlMinutes);
    if (nextAttempt && nextAttempt > now) {
      if (cache?.oauth) {
        oauth = cache.oauth;
        oauthMeasuredAt = cache.measuredAt;
        oauthFromCache = true;
      } else {
        oauthFailure =
          `Claude OAuth usage backoff is active until ${nextAttempt.toISOString()}, ` +
          "but no successful cached reading exists.";
      }
    } else {
      const res = await queryOauth({ token, fetchImpl });
      const attemptAt = now.toISOString();
      let parsed = res.ok ? parseOauthUsage(res.json) : null;

      // Setup tokens (scope user:inference) get 403 on /api/oauth/usage.
      // Only then: one max_tokens=1 Haiku call and read unified rate-limit headers.
      if (!parsed && !res.ok && res.status === 403) {
        const probe = await queryHaikuHeaders({ token, fetchImpl });
        if (probe.ok) {
          parsed = probe.oauth;
        }
      }

      const retryAfter =
        !res.ok && res.status === 429
          ? retryAfterTimestamp(res.retryAfter, now)
          : null;
      const retained = cache?.oauth
        ? { oauth: cache.oauth, measuredAt: cache.measuredAt }
        : { oauth: null, measuredAt: null };
      const nextCache = parsed
        ? {
            version: 1,
            oauth: parsed,
            measuredAt: attemptAt,
            lastAttemptAt: attemptAt,
            retryAfter: null,
          }
        : {
            version: 1,
            ...retained,
            lastAttemptAt: attemptAt,
            retryAfter,
          };
      try {
        await writeOauthCache(nextCache, oauthCachePath);
      } catch {
        oauthFailure =
          "Claude OAuth cache could not be written; no fresh value was published.";
      }

      if (parsed && !oauthFailure) {
        oauth = parsed;
        oauthMeasuredAt = attemptAt;
      } else if (cache?.oauth) {
        oauth = cache.oauth;
        oauthMeasuredAt = cache.measuredAt;
        oauthFromCache = true;
      }

      if (!parsed && !oauthFailure) {
        if (res.ok) {
          oauthFailure = "OAuth usage response had no usable meters.";
        } else if (res.status === 429) {
          oauthFailure = retryAfter
            ? `Anthropic OAuth usage API rate-limited this collect (HTTP 429); retry after ${retryAfter}.`
            : "Anthropic OAuth usage API rate-limited this collect (HTTP 429); the one-hour cache interval applies.";
        } else if (res.status === 403) {
          oauthFailure =
            "Claude OAuth usage API returned HTTP 403 and the Haiku rate-limit header probe also failed.";
        } else if (res.status === 401) {
          oauthFailure =
            "Claude OAuth token rejected by the usage API (HTTP 401); re-auth or refresh CLAUDE_CODE_OAUTH_TOKEN, then collect again.";
        } else {
          oauthFailure = "Claude OAuth usage API unavailable this collect.";
        }
      }
    }
  } else {
    oauthFailure =
      "No Claude OAuth token (set CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/.credentials.json).";
  }

  if (oauth) {
    const session = oauth.components.find((c) => c.id === "session");
    const weekly = oauth.components.find((c) => c.id === "weekly-all-models");
    const credits = oauth.components.find((c) => c.id === "usage-credits");
    const parts = [];
    if (session) {
      parts.push(
        `session ${session.usage}%` +
          (session.resetDate ? ` (resets ${session.resetDate})` : ""),
      );
    }
    if (weekly) {
      parts.push(
        `weekly all-models ${weekly.usage}%` +
          (weekly.resetDate ? ` (resets ${weekly.resetDate})` : ""),
      );
    }
    if (credits) {
      const lim = credits.limit == null ? "—" : credits.limit;
      parts.push(
        `usage credits ${credits.usage} of ${lim} ${credits.unit}` +
          (credits.resetDate ? ` (resets ${credits.resetDate})` : ""),
      );
    }
    const missingNote = oauth.missing.length
      ? ` Missing from API: ${oauth.missing.join(", ")}.`
      : "";
    const tokenNote = transcript.ok
      ? ` Local transcript detail: ${tokenReason(transcript.totals)}`
      : ` ${transcript.reason} No usage fabricated for tokens.`;
    const readingSource = oauth.source === "haiku" ? "haiku" : "oauth";
    const sourceNote =
      readingSource === "haiku"
        ? "via Haiku Messages rate-limit headers (oauth/usage 403 fallback)"
        : "via /api/oauth/usage";

    return {
      id: "claude-code",
      status: "measured",
      collectionMode: "automatic",
      reason:
        `${oauthFromCache ? "Cached" : "Live"} signed-in Claude.ai OAuth usage ` +
        `(measured ${oauthMeasuredAt}, source=${readingSource}) ${sourceNote}: ${parts.join("; ")}.` +
        `${oauthFailure ? ` ${oauthFailure}` : ""}` +
        `${missingNote} Same local-login pattern as Codex (no browser scrape).` +
        tokenNote,
      usage: null,
      limit: null,
      unit: "mixed (see components)",
      resetDate: oauth.resetDate,
      lastUpdate: oauthMeasuredAt,
      coverageStart: transcript.ok ? transcript.totals.firstSeenAt : null,
      breakdown: transcript.ok
        ? {
            promptTokens: transcript.totals.promptTokens,
            outputTokens: transcript.totals.outputTokens,
            generations: transcript.totals.generations,
          }
        : null,
      components: oauth.components,
      pace: { daily: null, monthly: null, weeklyTarget: null },
      history: transcript.ok ? transcript.history : [],
    };
  }

  if (transcript.ok) {
    return {
      id: "claude-code",
      status: "measured",
      collectionMode: "automatic",
      reason:
        `${tokenReason(transcript.totals)} ${oauthFailure}` +
        " Anthropic plan/credit percentages need a working local OAuth read and are not published here.",
      usage: transcript.totals.totalTokens,
      limit: null,
      unit: "tokens",
      resetDate: null,
      lastUpdate: transcript.totals.lastSeenAt || now.toISOString(),
      coverageStart: transcript.totals.firstSeenAt,
      breakdown: {
        promptTokens: transcript.totals.promptTokens,
        outputTokens: transcript.totals.outputTokens,
        generations: transcript.totals.generations,
      },
      pace: { daily: null, monthly: null, weeklyTarget: null },
      history: transcript.history,
    };
  }

  return unknown(
    "claude-code",
    `${transcript.reason} ${oauthFailure} No usage fabricated.`,
    { collectionMode: "unavailable" },
  );
}
