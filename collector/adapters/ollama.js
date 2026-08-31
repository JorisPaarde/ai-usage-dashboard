import { unknown } from "../lib/adapter-result.js";
import { dateKeyInZone } from "../lib/pace.js";

const OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags";

/**
 * Ollama — local loopback only. Reachability is measured; token/credit
 * quotas are not a vendor product feature, so usage stays null with reason.
 */
export async function collect(fetchImpl = fetch) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetchImpl(OLLAMA_TAGS, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return unknown(
        "ollama",
        `Ollama responded HTTP ${res.status}; usage quotas are not exposed by the local API.`,
      );
    }
    const body = await res.json();
    const models = Array.isArray(body?.models) ? body.models.length : 0;
    const now = new Date().toISOString();
    return {
      id: "ollama",
      status: "measured",
      reason: `Local Ollama reachable with ${models} model(s). No vendor usage/limit meter exists; usage remains null.`,
      usage: null,
      limit: null,
      unit: "tokens",
      resetDate: null,
      lastUpdate: now,
      pace: { daily: null, monthly: null, weeklyTarget: null },
      history: [{ date: dateKeyInZone(now), usage: null }],
    };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "timed out" : (err?.message || "unreachable");
    return unknown(
      "ollama",
      `Local Ollama at 127.0.0.1:11434 unavailable (${msg}). No usage fabricated.`,
    );
  }
}
