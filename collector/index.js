#!/usr/bin/env node
/**
 * Local snapshot collector — isolated adapters, JSON output only.
 * Never fabricates usage for unavailable sources.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as openaiBuzz from "./adapters/openai-buzz.js";
import * as cursorAgent from "./adapters/cursor-agent.js";
import * as claudeCode from "./adapters/claude-code.js";
import * as ollama from "./adapters/ollama.js";
import * as enrichLabs from "./adapters/enrich-labs.js";
import {
  SOURCE_IDS,
  emptySource,
  validateSnapshot,
  assertHonestSource,
  ENRICH_MONTHLY_BUDGET,
  ENRICH_WEEKLY_PACE_MAX,
} from "./lib/schema.js";
import { computePace, compactHistory } from "./lib/pace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "latest.json");

const ADAPTERS = {
  "openai-buzz": openaiBuzz,
  "cursor-agent": cursorAgent,
  "claude-code": claudeCode,
  ollama,
  "enrich-labs": enrichLabs,
};

/**
 * Merge adapter result into canonical source record.
 * @param {object} result
 */
export function normalizeSource(result) {
  const src = emptySource(result);
  if (src.usage != null) {
    const pace = computePace(src.usage);
    src.pace = {
      daily: pace.daily,
      monthly: pace.monthly,
      weeklyTarget: src.pace.weeklyTarget,
    };
  }
  if (src.id === "enrich-labs") {
    src.limit = src.limit ?? ENRICH_MONTHLY_BUDGET;
    src.budget = {
      monthly: ENRICH_MONTHLY_BUDGET,
      weeklyPaceMax: ENRICH_WEEKLY_PACE_MAX,
    };
    src.pace.weeklyTarget = ENRICH_WEEKLY_PACE_MAX;
  }
  src.history = compactHistory(src.history || []);
  assertHonestSource(src);
  return src;
}

/**
 * Run all adapters and build a snapshot object.
 */
export async function collectSnapshot(now = new Date()) {
  const sources = [];
  for (const id of SOURCE_IDS) {
    const adapter = ADAPTERS[id];
    const result = await adapter.collect();
    sources.push(normalizeSource(result));
  }
  const snapshot = {
    version: "1.0.0",
    generatedAt: now.toISOString(),
    timezone: "Europe/Amsterdam",
    scheduleNote:
      "Intended local windows: 09:00 and 16:00 Europe/Amsterdam. GitHub Actions cron is UTC-only; see docs/SCHEDULE.md for DST limits.",
    sources,
  };
  const check = validateSnapshot(snapshot);
  if (!check.ok) {
    throw new Error(`Invalid snapshot: ${check.errors.join("; ")}`);
  }
  return snapshot;
}

export async function writeSnapshot(snapshot, outFile = OUT_FILE) {
  await mkdir(path.dirname(outFile), { recursive: true });
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(outFile, text, "utf8");
  return outFile;
}

async function main() {
  const snapshot = await collectSnapshot();
  const dest = await writeSnapshot(snapshot);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${dest}`);
  // Keep a copy readable by the site build without secrets.
  try {
    const published = JSON.parse(await readFile(dest, "utf8"));
    if (JSON.stringify(published).match(/sk-[a-zA-Z0-9]|api[_-]?key|Bearer\s/i)) {
      throw new Error("Refusing to write snapshot that looks like it contains secrets");
    }
  } catch (e) {
    if (e.message?.includes("Refusing")) throw e;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
