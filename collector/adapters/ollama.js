import { readFile } from "node:fs/promises";

import { unknown } from "../lib/adapter-result.js";

const OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags";
const DEFAULT_LOG = "/opt/homebrew/var/log/ollama.log";

function monthKeyInAmsterdam(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}/${value.month}`;
}

export function parseOllamaLog(text, now = new Date()) {
  const monthKey = monthKeyInAmsterdam(now);
  let coverageStart = null;
  let promptTokens = 0;
  let outputTokens = 0;
  let generations = 0;
  let pendingPrompt = null;
  let pendingOutput = null;
  let pendingDate = null;
  const daily = new Map();

  function addGeneration(day) {
    const promptCount = pendingPrompt ?? 0;
    const outputCount = pendingOutput ?? 0;
    promptTokens += promptCount;
    outputTokens += outputCount;
    generations += 1;
    daily.set(day, (daily.get(day) || 0) + promptCount + outputCount);
    pendingPrompt = null;
    pendingOutput = null;
    pendingDate = null;
  }

  for (const line of text.split(/\r?\n/)) {
    const stamped = line.match(/time=(\d{4}-\d{2}-\d{2}T[^ ]+)/);
    if (stamped && (!coverageStart || stamped[1] < coverageStart)) {
      coverageStart = stamped[1];
    }
    if (stamped) pendingDate = stamped[1].slice(0, 10);

    const prompt = line.match(/prompt eval time\s*=.*?\/\s*(\d+) tokens/);
    if (prompt) pendingPrompt = Number(prompt[1]);

    const output = line.match(/(?<!prompt )eval time\s*=.*?\/\s*(\d+) tokens/);
    if (output) pendingOutput = Number(output[1]);

    const request = line.match(
      /\[GIN\]\s+(\d{4}\/\d{2}\/\d{2})\s+-[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s+POST\s+"\/(?:api\/(?:generate|chat)|v1\/chat\/completions)"/,
    );
    if (!request || !request[1].startsWith(monthKey)) continue;
    if (pendingPrompt == null && pendingOutput == null) continue;

    addGeneration(request[1].replaceAll("/", "-"));
  }

  // A completed timing pair can be flushed before the request access line.
  // Count it using the nearest server timestamp, without reading prompt text.
  if (
    pendingDate?.replaceAll("-", "/").startsWith(monthKey) &&
    (pendingPrompt != null || pendingOutput != null)
  ) {
    addGeneration(pendingDate);
  }

  return {
    promptTokens,
    outputTokens,
    generations,
    totalTokens: promptTokens + outputTokens,
    coverageStart,
    history: [...daily.entries()].map(([date, usage]) => ({ date, usage })),
  };
}

/**
 * Ollama exposes reachability through loopback. Token totals come only from
 * timing counters in the local server log; prompts and raw log lines never
 * leave this adapter.
 */
export async function collect(
  fetchImpl = fetch,
  { logPath = process.env.OLLAMA_LOG_PATH || DEFAULT_LOG, readLog = readFile } = {},
) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetchImpl(OLLAMA_TAGS, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return unknown("ollama", `Ollama responded HTTP ${res.status}.`, {
        collectionMode: "automatic",
      });
    }
    const body = await res.json();
    const models = Array.isArray(body?.models) ? body.models.length : 0;
    const now = new Date();
    let totals = null;
    try {
      totals = parseOllamaLog(await readLog(logPath, "utf8"), now);
    } catch {
      // Reachability remains measured even if the optional log is unavailable.
    }

    const coverage = totals?.coverageStart
      ? ` Log coverage starts ${totals.coverageStart}; the month may be partial after rotation.`
      : " Token log unavailable, so no monthly token total is published.";
    const summary = totals
      ? `${totals.totalTokens} tokens this month (${totals.promptTokens} prompt + ${totals.outputTokens} output) across ${totals.generations} generations.`
      : `Local Ollama reachable with ${models} model(s).`;

    return {
      id: "ollama",
      status: "measured",
      collectionMode: "automatic",
      reason: `${summary}${coverage} No vendor quota exists.`,
      usage: totals?.totalTokens ?? null,
      limit: null,
      unit: "tokens",
      resetDate: null,
      lastUpdate: now.toISOString(),
      coverageStart: totals?.coverageStart ?? null,
      breakdown: totals
        ? {
            promptTokens: totals.promptTokens,
            outputTokens: totals.outputTokens,
            generations: totals.generations,
          }
        : null,
      pace: { daily: null, monthly: null, weeklyTarget: null },
      history: totals?.history ?? [],
    };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "timed out" : (err?.message || "unreachable");
    return unknown(
      "ollama",
      `Local Ollama at 127.0.0.1:11434 unavailable (${msg}). No usage fabricated.`,
      { collectionMode: "automatic" },
    );
  }
}
