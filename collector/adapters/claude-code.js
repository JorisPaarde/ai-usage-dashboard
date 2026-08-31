import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unknown } from "../lib/adapter-result.js";
import { dateKeyInZone } from "../lib/pace.js";

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function monthKeyInAmsterdam(now) {
  return dateKeyInZone(now).slice(0, 7);
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
 * Claude Code — token usage is measured from local transcripts. Anthropic's
 * plan/credit percentages stay account-authenticated and are not derivable
 * here, so no limit is published rather than a guessed one.
 */
export async function collect({
  projectsDir = process.env.CLAUDE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR,
  listFiles = listTranscripts,
  readTranscript = readFile,
  now = new Date(),
} = {}) {
  let files;
  try {
    files = await listFiles(projectsDir);
  } catch (err) {
    return unknown(
      "claude-code",
      `Claude Code transcript directory unavailable (${err?.message || "unreadable"}). No usage fabricated.`,
      { collectionMode: "unavailable" },
    );
  }

  if (files.length === 0) {
    return unknown(
      "claude-code",
      "No Claude Code transcripts found locally, so token usage cannot be measured. No usage fabricated.",
      { collectionMode: "unavailable" },
    );
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

  const coverage = totals.firstSeenAt
    ? ` Transcript coverage this month starts ${totals.firstSeenAt}.`
    : "";

  return {
    id: "claude-code",
    status: "measured",
    collectionMode: "automatic",
    reason:
      `${totals.totalTokens} tokens this month (${totals.promptTokens} prompt/cache + ` +
      `${totals.outputTokens} output) across ${totals.generations} assistant messages, ` +
      `measured from local Claude Code transcripts.${coverage} ` +
      "Anthropic's plan and usage-credit percentages need account access and are not published here.",
    usage: totals.totalTokens,
    limit: null,
    unit: "tokens",
    resetDate: null,
    lastUpdate: totals.lastSeenAt || now.toISOString(),
    coverageStart: totals.firstSeenAt,
    breakdown: {
      promptTokens: totals.promptTokens,
      outputTokens: totals.outputTokens,
      generations: totals.generations,
    },
    pace: { daily: null, monthly: null, weeklyTarget: null },
    history: [...totals.daily.entries()].map(([date, usage]) => ({ date, usage })),
  };
}
