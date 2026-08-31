#!/usr/bin/env node
/**
 * Local snapshot collector — isolated adapters, JSON output only.
 * Never fabricates usage for unavailable sources.
 * Optional local overrides (gitignored) supply authenticated desktop/browser
 * readings; the override file itself is never published to dist/.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
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

/**
 * The local-share metric is on hold. The routing log's `local` flag was set from
 * each agent's configured model label, and on 2026-08-31 the agent labelled
 * `qwen2.5-coder:14b` was measured running `gpt-5.5` on OpenAI — so the
 * published 6/12 = 50% was wrong in both numerator and denominator. Publishing
 * no percentage is correct until the provider fix lands and the log is
 * renormalised against runtime evidence.
 */
const ROUTING_HOLD = Object.freeze({
  today: Object.freeze({ local: 0, total: 0, percent: null }),
  rolling7d: Object.freeze({ local: 0, total: 0, percent: null }),
  lastEntry: null,
  skipped: 0,
  runtimeEvidence: null,
  reason:
    "Unproven: the agent's model label was not runtime evidence. Awaiting the provider fix and a routing log renormalised against measured runtimes.",
});

/**
 * Overrides are gitignored, so every checkout keeps its own copy and they drift
 * apart. A collect run from a checkout holding an older copy then republishes
 * those older readings into the tracked snapshot — the seed silently regresses
 * even though nobody edited it.
 *
 * Prefer one shared file per machine so all checkouts, and the scheduler, read
 * the same seed. The in-repo path stays last for backwards compatibility.
 */
export const SHARED_OVERRIDES_FILE = path.join(
  os.homedir(),
  ".config",
  "ai-usage-dashboard",
  "local-overrides.json",
);
const REPO_OVERRIDES_FILE = path.join(OUT_DIR, "local-overrides.json");

/**
 * First existing candidate wins; the shared file beats the per-checkout one.
 * @param {(p: string) => Promise<boolean>} [exists]
 */
export async function resolveOverridesPath(exists = fileExists) {
  if (process.env.AI_USAGE_OVERRIDES_PATH) {
    return process.env.AI_USAGE_OVERRIDES_PATH;
  }
  if (await exists(SHARED_OVERRIDES_FILE)) return SHARED_OVERRIDES_FILE;
  return REPO_OVERRIDES_FILE;
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

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

/** A hand-entered reading older than this is called out as stale on the page. */
export const MANUAL_STALE_HOURS = 12;

/** True when the adapter itself produced a real reading this run. */
export function isAutomaticMeasurement(source) {
  return source?.status === "measured" && source?.collectionMode === "automatic";
}

/**
 * Describe how old a hand-entered reading is at collect time. A scheduled run
 * re-publishes manual values without re-measuring them, so the age must be
 * visible rather than hidden behind a fresh `generatedAt`.
 * @param {string|null|undefined} lastUpdate
 * @param {Date} now
 */
export function manualFreshnessNote(lastUpdate, now = new Date()) {
  if (!lastUpdate) {
    return "Manual reading with no recorded timestamp; this run did not re-measure it.";
  }
  const observed = new Date(lastUpdate);
  if (Number.isNaN(observed.getTime())) {
    return "Manual reading with an unreadable timestamp; this run did not re-measure it.";
  }
  const hours = Math.max(0, (now.getTime() - observed.getTime()) / 3600000);
  const age =
    hours < 1
      ? `${Math.round(hours * 60)} minute(s)`
      : `${Math.round(hours)} hour(s)`;
  const prefix = hours >= MANUAL_STALE_HOURS ? "STALE: " : "";
  return `${prefix}Manual reading ${age} old at this collect; no local meter exists for this source, so this run did not re-measure it.`;
}

/**
 * Apply a validated local override onto an adapter-normalized source.
 * Only sanitized aggregate fields flow into the published snapshot.
 *
 * A manual override never silently replaces a real automatic reading of the
 * same thing — that is how a scheduled run ends up republishing hand-typed
 * numbers as if it had measured them. An override that carries a *different*
 * metric than the collector can measure must say so with `supplements: true`;
 * it then becomes the headline figure while the automatic reading is kept as
 * supporting detail.
 * @param {object} base
 * @param {object} override
 * @param {Date} [now]
 */
export function applyOverride(base, override, now = new Date()) {
  if (isAutomaticMeasurement(base) && !override.supplements) {
    // Presentation-only fields still merge; only the measurement is protected.
    const kept = normalizeSource({
      ...base,
      name: override.name || base.name,
      budget: override.budget || base.budget,
      usageUrl:
        override.usageUrl !== undefined ? override.usageUrl : base.usageUrl,
    });
    kept.reason = `${kept.reason} A manual override was ignored: the collector measures this source directly.`;
    assertHonestSource(kept);
    return kept;
  }

  const supplementNote =
    isAutomaticMeasurement(base) && override.supplements
      ? ` Local automatic measurement alongside it: ${base.reason}`
      : "";

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
  merged.reason =
    `${merged.reason} ${manualFreshnessNote(merged.lastUpdate, now)}${supplementNote}`.trim();
  assertHonestSource(merged);
  return merged;
}

/**
 * Load and validate gitignored local overrides. Missing file → empty list.
 * @param {string} [filePath]
 */
export async function loadLocalOverrides(filePath) {
  const resolved = filePath || (await resolveOverridesPath());
  try {
    await access(resolved);
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
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
    const result = await adapter.collect({ now });
    let src = normalizeSource(result);
    const ov = byId.get(id);
    if (ov) {
      src = applyOverride(src, ov, now);
    }
    sources.push(src);
  }
  const snapshot = {
    version: "1.3.5",
    generatedAt: now.toISOString(),
    timezone: "Europe/Amsterdam",
    scheduleNote:
      "Local LaunchAgent collects every 15 minutes (LLM-free). Open dashboards soft-refresh every 5 minutes. GitHub Actions still gate CET+CEST UTC candidates to 09:00 and 16:00 Europe/Amsterdam. Hosted runners cannot measure authenticated desktop/browser usage — use a local collect with data/local-overrides.json.",
    // Fizz Claude Backup owns populating this from routing-log.jsonl. Held at
    // unavailable-with-reason: the routing log still carries legacy `local:true`
    // rows whose "local" claim came from an agent label, not from runtime proof.
    routing: ROUTING_HOLD,
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
