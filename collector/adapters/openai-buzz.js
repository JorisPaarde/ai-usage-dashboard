import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unknown } from "../lib/adapter-result.js";

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

/** Only scan the newest rollout files; older ones cannot hold a fresher reading. */
const MAX_FILES_SCANNED = 12;

/** The session log only advances when Codex runs, so ask the account directly. */
const APP_SERVER_TIMEOUT_MS = 20000;

/**
 * Normalize one `rate_limits`-shaped payload. The live app-server uses
 * camelCase and the session log uses snake_case; everything else matches.
 *
 * Deliberately narrow: `credits.balance`, `planType`, and the installation and
 * host identifiers that travel in the same response are account details and
 * must never reach the published snapshot.
 * @param {object} limits
 * @param {string} observedAt
 */
function normalizeLimits(limits, observedAt) {
  const primary = limits?.primary;
  const usedPercent = primary?.usedPercent ?? primary?.used_percent;
  if (typeof usedPercent !== "number") return null;

  const window = (bucket) => {
    const minutes = bucket?.windowDurationMins ?? bucket?.window_minutes;
    const resets = bucket?.resetsAt ?? bucket?.resets_at;
    return {
      usedPercent: bucket?.usedPercent ?? bucket?.used_percent,
      windowMinutes: typeof minutes === "number" ? minutes : null,
      resetsAt: typeof resets === "number" ? resets : null,
    };
  };

  const secondary = limits.secondary;
  const secondaryPercent = secondary?.usedPercent ?? secondary?.used_percent;
  return {
    observedAt,
    primary: window(primary),
    secondary: typeof secondaryPercent === "number" ? window(secondary) : null,
  };
}

/**
 * Ask the signed-in Codex account for its current rate-limit state.
 *
 * `codex app-server` is a local JSON-RPC process that reuses the existing
 * login. `account/rateLimits/read` is read-only, runs no model, and therefore
 * costs no tokens — it is safe on a 15-minute schedule.
 *
 * @param {{ spawnImpl?: Function, timeoutMs?: number, now?: Date }} [opts]
 * @returns {Promise<object|null>} normalized reading, or null if unavailable
 */
export function queryLiveRateLimits({
  spawnImpl = spawn,
  timeoutMs = APP_SERVER_TIMEOUT_MS,
  now = new Date(),
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl("codex", ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let buffer = "";
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

    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        const limits = message.result?.rateLimits;
        finish(limits ? normalizeLimits(limits, now.toISOString()) : null);
        return;
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "ai-usage-dashboard", version: "1.0.0" },
        },
      })}\n${JSON.stringify({ method: "initialized", params: {} })}\n${JSON.stringify(
        { id: 2, method: "account/rateLimits/read", params: {} },
      )}\n`,
    );
  });
}

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
    const observedAt = event.timestamp;
    if (typeof observedAt !== "string") continue;
    if (newest && observedAt <= newest.observedAt) continue;

    const reading = normalizeLimits(event?.payload?.rate_limits, observedAt);
    if (reading) newest = reading;
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
 * OpenAI / Buzz (Codex).
 *
 * Preferred route: ask the signed-in account for its live rate-limit state via
 * the local `codex app-server`. Read-only, no model call, no token cost.
 *
 * Fallback: the last state Codex wrote to its own session log. That figure
 * only advances when Codex runs, so it is treated as expired once its window's
 * reset time has passed.
 */
export async function collect({
  sessionsDir = process.env.CODEX_SESSIONS_DIR || DEFAULT_SESSIONS_DIR,
  listFiles = newestRolloutFiles,
  readSession = readFile,
  queryLive = queryLiveRateLimits,
  now = new Date(),
} = {}) {
  const live = await queryLive({ now });
  if (live) {
    const liveWindow = windowLabel(live.primary.windowMinutes);
    const liveSecondary = live.secondary
      ? ` The ${windowLabel(live.secondary.windowMinutes)} window is ${live.secondary.usedPercent}% used.`
      : "";
    return {
      id: "openai-buzz",
      status: "measured",
      collectionMode: "automatic",
      reason:
        `Live from the signed-in Codex account: ${live.primary.usedPercent}% of the ` +
        `${liveWindow} limit used.${liveSecondary} Read read-only via the local codex app-server ` +
        "(no model call, no token cost); this is the same figure the provider shows.",
      usage: live.primary.usedPercent,
      limit: 100,
      unit: `% of ${liveWindow} Codex limit`,
      resetDate: live.primary.resetsAt
        ? new Date(live.primary.resetsAt * 1000).toISOString()
        : null,
      lastUpdate: live.observedAt,
      coverageStart: null,
      breakdown: null,
      pace: { daily: null, monthly: null, weeklyTarget: null },
      history: [],
    };
  }

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
      `Live account read unavailable, so this is the last state Codex wrote to its own session log: ` +
      `${newest.primary.usedPercent}% of the ${primaryWindow} limit used.${secondaryNote} ` +
      `Recorded ${ageMinutes} minute(s) before this collect; it only advances when Codex is used.`,
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
