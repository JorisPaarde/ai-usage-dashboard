/**
 * Shared Cursor IDE session helpers for Mac-only adapters.
 * Reads the signed-in access token from local state; never logs the token.
 */
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
export const CURSOR_API_BASE = "https://api2.cursor.sh";
export const PERIOD_USAGE_PATH =
  "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
export const GROK_BOT_PATH =
  "/aiserver.v1.DashboardService/GetSandUsageStatus";
export const HARD_LIMIT_PATH = "/aiserver.v1.DashboardService/GetHardLimit";
export const USAGE_SUMMARY_PATH = "/api/usage/summary";
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
        [
          "-readonly",
          dbPath,
          `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';`,
        ],
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
  baseUrl = CURSOR_API_BASE,
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
  baseUrl = CURSOR_API_BASE,
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
  baseUrl = CURSOR_API_BASE,
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
  baseUrl = CURSOR_API_BASE,
  fetchImpl = globalThis.fetch,
}) {
  return cursorApiRequest({
    url: `${baseUrl.replace(/\/$/, "")}${USAGE_SUMMARY_PATH}`,
    method: "GET",
    token,
    fetchImpl,
  });
}

export function isNonEmptyToken(value) {
  return isNonEmptyString(value);
}
