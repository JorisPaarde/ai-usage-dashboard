/**
 * Read-only JSON GET. Tokens stay in the Authorization header and never
 * appear in returned errors, reasons, or thrown messages.
 */

export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * @param {string} url
 * @param {{
 *   token?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   headers?: Record<string, string>,
 * }} [opts]
 * @returns {Promise<{ ok: true, status: number, json: unknown } | { ok: false, status?: number }>}
 */
export async function jsonGet(url, opts = {}) {
  const {
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
  } = opts;
  if (typeof fetchImpl !== "function") return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reqHeaders = {
      Accept: "application/json",
      "User-Agent": "ai-usage-dashboard",
      ...headers,
    };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: reqHeaders,
      signal: controller.signal,
    });
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
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Trim a process env value; empty string is treated as missing. */
export function envKey(name, env = process.env) {
  const raw = env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}
