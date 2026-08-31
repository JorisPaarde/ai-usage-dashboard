#!/usr/bin/env node
/**
 * Local snapshot collector — isolated adapters, JSON output only.
 * Never fabricates usage for unavailable sources.
 * Optional local overrides (gitignored) supply authenticated desktop/browser
 * readings; the override file itself is never published to dist/.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
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
  assertPublishableSnapshot,
  validateLocalOverrides,
  ENRICH_MONTHLY_BUDGET,
  ENRICH_WEEKLY_PACE_MAX,
} from "./lib/schema.js";
import { computePace, compactHistory } from "./lib/pace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "latest.json");
const OVERRIDES_FILE = path.join(OUT_DIR, "local-overrides.json");

const ADAPTERS = {
  "openai-buzz": openaiBuzz,
  "cursor-agent": cursorAgent,
  "claude-code": claudeCode,
  ollama,
  "enrich-labs": enrichLabs,
};

const SECRET_RE =
  /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i;

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
 * Apply a validated local override onto an adapter-normalized source.
 * Only sanitized aggregate fields flow into the published snapshot.
 * @param {object} base
 * @param {object} override
 */
export function applyOverride(base, override) {
  const merged = normalizeSource({
    ...base,
    ...override,
    id: base.id,
    name: override.name || base.name,
    history: override.history ?? base.history,
    budget: override.budget || base.budget,
    collectionMode: override.collectionMode || base.collectionMode,
    coverageStart: override.coverageStart ?? base.coverageStart,
    breakdown: override.breakdown ?? base.breakdown,
    components: override.components ?? base.components,
    usageUrl:
      override.usageUrl !== undefined ? override.usageUrl : base.usageUrl,
    pace: override.pace
      ? {
          daily: override.pace.daily ?? null,
          monthly: override.pace.monthly ?? null,
          weeklyTarget:
            override.pace.weeklyTarget ?? base.pace?.weeklyTarget ?? null,
        }
      : {
          daily: null,
          monthly: null,
          weeklyTarget: base.pace?.weeklyTarget ?? null,
        },
  });
  if (!override.reason && (!merged.reason || merged.reason === base.reason)) {
    merged.reason =
      "Local override applied from data/local-overrides.json (credentials never published).";
  }
  assertHonestSource(merged);
  return merged;
}

/**
 * Load and validate gitignored local overrides. Missing file → empty list.
 * @param {string} [filePath]
 */
export async function loadLocalOverrides(filePath = OVERRIDES_FILE) {
  try {
    await access(filePath);
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (e) {
    throw new Error(
      `local-overrides.json is not valid JSON (fail closed): ${e instanceof Error ? e.message : e}`,
    );
  }
  const check = validateLocalOverrides(parsed);
  if (!check.ok) {
    throw new Error(
      `local-overrides.json failed schema/honesty checks (fail closed): ${check.errors.join("; ")}`,
    );
  }
  if (SECRET_RE.test(JSON.stringify(parsed))) {
    throw new Error(
      "local-overrides.json looks like it contains secrets (fail closed); remove credentials before collecting.",
    );
  }
  return parsed.sources;
}

/**
 * Run all adapters and build a snapshot object.
 * @param {Date} [now]
 * @param {{ overrides?: object[] }} [opts]
 */
export async function collectSnapshot(now = new Date(), opts = {}) {
  const overrideList =
    opts.overrides !== undefined ? opts.overrides : await loadLocalOverrides();
  const byId = new Map(overrideList.map((o) => [o.id, o]));

  const sources = [];
  for (const id of SOURCE_IDS) {
    const adapter = ADAPTERS[id];
    const result = await adapter.collect();
    let src = normalizeSource(result);
    const ov = byId.get(id);
    if (ov) {
      src = applyOverride(src, ov);
    }
    sources.push(src);
  }
  const snapshot = {
    version: "1.2.0",
    generatedAt: now.toISOString(),
    timezone: "Europe/Amsterdam",
    scheduleNote:
      "Intended local windows: 09:00 and 16:00 Europe/Amsterdam. GitHub Actions schedules CET+CEST UTC candidates; the Amsterdam gate selects the matching slot. Hosted runners cannot measure authenticated desktop/browser usage — use a local collect with data/local-overrides.json.",
    sources,
  };
  assertPublishableSnapshot(snapshot);
  return snapshot;
}

export async function writeSnapshot(snapshot, outFile = OUT_FILE) {
  assertPublishableSnapshot(snapshot);
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (SECRET_RE.test(text)) {
    throw new Error("Refusing to write snapshot that looks like it contains secrets");
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, text, "utf8");
  return outFile;
}

async function main() {
  const snapshot = await collectSnapshot();
  const dest = await writeSnapshot(snapshot);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${dest}`);
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
