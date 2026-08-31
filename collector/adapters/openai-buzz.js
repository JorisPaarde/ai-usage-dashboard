import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unknown } from "../lib/adapter-result.js";

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

/** Only scan the newest rollout files; older ones cannot hold a fresher reading. */
const MAX_FILES_SCANNED = 12;

/**
 * The Codex CLI records the server's own rate-limit state next to each
 * `token_count` event. Those percentages are the provider's numbers, so they
 * are a real measurement rather than a local estimate.
 *
 * Only the numeric window fields are read. Prompts, responses, credit balance,
 * and account identifiers in the same file are never parsed or published.
 *
 * @param {string} text raw rollout JSONL
 * @returns {{ observedAt: string, primary: object, secondary: object|null }|null}
 */
export function parseRateLimits(text) {
  let newest = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"rate_limits"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = event?.payload?.rate_limits;
    const primary = limits?.primary;
    if (typeof primary?.used_percent !== "number") continue;
    const observedAt = event.timestamp;
    if (typeof observedAt !== "string") continue;
    if (newest && observedAt <= newest.observedAt) continue;

    const secondary = limits.secondary;
    newest = {
      observedAt,
      primary: {
        usedPercent: primary.used_percent,
        windowMinutes:
          typeof primary.window_minutes === "number" ? primary.window_minutes : null,
        resetsAt: typeof primary.resets_at === "number" ? primary.resets_at : null,
      },
      secondary:
        typeof secondary?.used_percent === "number"
          ? {
              usedPercent: secondary.used_percent,
              windowMinutes:
                typeof secondary.window_minutes === "number"
                  ? secondary.window_minutes
                  : null,
              resetsAt:
                typeof secondary.resets_at === "number" ? secondary.resets_at : null,
            }
          : null,
    };
  }
  return newest;
}

/** Human label for a rate-limit window length. */
export function windowLabel(minutes) {
  if (minutes == null) return "current";
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "weekly" : `${weeks}-week`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "daily" : `${days}-day`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** Newest-first rollout files, capped so a large session archive stays cheap. */
async function newestRolloutFiles(dir, limit = MAX_FILES_SCANNED) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^rollout-.*\.jsonl$/.test(entry.name)) continue;
    const full = path.join(entry.parentPath || entry.path || dir, entry.name);
    files.push(full);
  }
  const stamped = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, mtimeMs: (await stat(file)).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return stamped
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

/**
 * OpenAI / Buzz (Codex) — percentages come from the provider's own rate-limit
 * payload written to the local Codex session log. No credentials, no network
 * call, and no prompt text.
 */
export async function collect({
  sessionsDir = process.env.CODEX_SESSIONS_DIR || DEFAULT_SESSIONS_DIR,
  listFiles = newestRolloutFiles,
  readSession = readFile,
  now = new Date(),
} = {}) {
  let files;
  try {
    files = await listFiles(sessionsDir);
  } catch (err) {
    return unknown(
      "openai-buzz",
      `Codex session log directory unavailable (${err?.message || "unreadable"}). No usage fabricated.`,
      { collectionMode: "unavailable" },
    );
  }

  if (files.length === 0) {
    return unknown(
      "openai-buzz",
      "No Codex session logs found locally, so the provider rate-limit state cannot be read. No usage fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  let newest = null;
  for (const file of files) {
    let reading;
    try {
      reading = parseRateLimits(await readSession(file, "utf8"));
    } catch {
      continue;
    }
    if (reading && (!newest || reading.observedAt > newest.observedAt)) {
      newest = reading;
    }
  }

  if (!newest) {
    return unknown(
      "openai-buzz",
      "Codex session logs contain no rate-limit reading yet. No usage fabricated.",
      { collectionMode: "unavailable" },
    );
  }

  const primaryWindow = windowLabel(newest.primary.windowMinutes);
  const ageMinutes = Math.max(
    0,
    Math.round((now.getTime() - new Date(newest.observedAt).getTime()) / 60000),
  );
  const secondaryNote = newest.secondary
    ? ` The ${windowLabel(newest.secondary.windowMinutes)} window is ${newest.secondary.usedPercent}% used.`
    : "";

  // A percentage only describes the window it was recorded in. Once that
  // window's reset time has passed the figure is spent, and Codex has written
  // nothing since — so the new window has no reading yet. Publishing the old
  // number here is exactly how a dashboard ends up showing a full bar against
  // an allowance the provider has already reset.
  const resetsAtMs = newest.primary.resetsAt ? newest.primary.resetsAt * 1000 : null;
  if (resetsAtMs != null && resetsAtMs <= now.getTime()) {
    return unknown(
      "openai-buzz",
      `The last recorded ${primaryWindow} window ended ${new Date(resetsAtMs).toISOString()} at ` +
        `${newest.primary.usedPercent}% used, and Codex has not run since, so the current window has no reading yet. ` +
        `The next Codex request refreshes this automatically.${secondaryNote}`,
      { collectionMode: "automatic", limit: 100, unit: `% of ${primaryWindow} Codex limit` },
    );
  }

  return {
    id: "openai-buzz",
    status: "measured",
    collectionMode: "automatic",
    reason:
      `Provider rate-limit state read from the local Codex session log: ` +
      `${newest.primary.usedPercent}% of the ${primaryWindow} limit used.${secondaryNote} ` +
      `Reported by the provider ${ageMinutes} minute(s) before this collect; it only advances when Codex is used.`,
    usage: newest.primary.usedPercent,
    limit: 100,
    unit: `% of ${primaryWindow} Codex limit`,
    resetDate: newest.primary.resetsAt
      ? new Date(newest.primary.resetsAt * 1000).toISOString()
      : null,
    lastUpdate: newest.observedAt,
    coverageStart: null,
    breakdown: null,
    pace: { daily: null, monthly: null, weeklyTarget: null },
    history: [],
  };
}
