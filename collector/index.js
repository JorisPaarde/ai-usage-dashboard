#!/usr/bin/env node
/**
 * Snapshot collector — isolated adapters, JSON output only.
 * Never fabricates usage for unavailable sources.
 *
 * Box mode (default): measures BOX_SOURCE_IDS, merges data/mac-sources.json
 * into the published latest.json (Mac sources keep their own measuredAt;
 * older than MAC_STALE_HOURS → marked stale, not deleted).
 *
 * Mac mode (--mac): measures MAC_SOURCE_IDS only → data/mac-sources.json.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as openaiBuzz from "./adapters/openai-buzz.js";
import * as cursorAgent from "./adapters/cursor-agent.js";
import * as grokBot from "./adapters/grok-bot.js";
import * as claudeCode from "./adapters/claude-code.js";
import * as openrouter from "./adapters/openrouter.js";
import * as sail from "./adapters/sail-research.js";
import {
  SOURCE_IDS,
  BOX_SOURCE_IDS,
  MAC_SOURCE_IDS,
  emptySource,
  validateSnapshot,
  assertHonestSource,
  assertPublishableSnapshot,
  validateLocalOverrides,
  validateComponents,
  STATUSES,
  COLLECTION_MODES,
} from "./lib/schema.js";
import { compactHistory } from "./lib/pace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "latest.json");
export const MAC_SOURCES_FILE = path.join(OUT_DIR, "mac-sources.json");

/** Mac sources older than this (relative to box collect time) are marked stale. */
export const MAC_STALE_HOURS = 2;

const SNAPSHOT_VERSION = "1.9.0";

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
 * apart. Prefer one shared file per machine so all checkouts, and the scheduler,
 * read the same seed. The in-repo path stays last for backwards compatibility.
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

const BOX_ADAPTERS = {
  "openai-buzz": openaiBuzz,
  "claude-code": claudeCode,
  openrouter,
  sail,
};

const MAC_ADAPTERS = {
  "cursor-agent": cursorAgent,
  "grok-bot": grokBot,
};

const SECRET_RE =
  /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i;

/**
 * Merge adapter result into canonical source record.
 * @param {object} result
 */
export function normalizeSource(result) {
  const src = emptySource(result);
  src.pace = {
    daily: null,
    monthly: null,
    weeklyTarget: src.pace?.weeklyTarget ?? null,
  };
  src.history = compactHistory(src.history || []);
  if (result && result.stale === true) src.stale = true;
  if (result && typeof result.measuredAt === "string") {
    src.measuredAt = result.measuredAt;
  }
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
 * Describe how old a hand-entered reading is at collect time.
 * @param {string|null|undefined} lastUpdate
 * @param {Date} now
 * @param {{ filledMeter?: boolean }} [opts]
 */
export function manualFreshnessNote(lastUpdate, now = new Date(), opts = {}) {
  if (!lastUpdate) {
    return opts.filledMeter
      ? "manual fill with no recorded timestamp."
      : "Manual reading with no recorded timestamp; this run did not re-measure it.";
  }
  const observed = new Date(lastUpdate);
  if (Number.isNaN(observed.getTime())) {
    return opts.filledMeter
      ? "manual fill with an unreadable timestamp."
      : "Manual reading with an unreadable timestamp; this run did not re-measure it.";
  }
  const hours = Math.max(0, (now.getTime() - observed.getTime()) / 3600000);
  const age =
    hours < 1
      ? `${Math.round(hours * 60)} minute(s)`
      : `${Math.round(hours)} hour(s)`;
  const prefix = hours >= MANUAL_STALE_HOURS ? "STALE: " : "";
  if (opts.filledMeter) {
    return `${prefix}manual fill ${age} old.`;
  }
  return `${prefix}Manual reading ${age} old at this collect; no local meter exists for this source, so this run did not re-measure it.`;
}

/**
 * When the adapter already measured this run, a local override must never flip
 * the source back to manual or replace live meters with a stale scrape.
 * @param {object} base automatic measurement
 * @param {object} override
 * @param {Date} [now]
 */
export function mergeOverrideOntoAutomatic(base, override, now = new Date()) {
  const baseComponents = Array.isArray(base.components) ? [...base.components] : [];
  const overrideComponents = Array.isArray(override.components)
    ? override.components
    : [];
  const byId = new Map();
  for (const c of baseComponents) {
    if (c && typeof c.id === "string") byId.set(c.id, c);
  }
  /** @type {string[]} */
  const filledIds = [];
  if (override.supplements) {
    for (const c of overrideComponents) {
      if (!c || typeof c.id !== "string" || !c.id) continue;
      if (byId.has(c.id)) continue;
      byId.set(c.id, {
        ...c,
        filledFrom: "manual",
        filledAt: override.lastUpdate ?? null,
      });
      filledIds.push(c.id);
    }
  }

  const hasBaseComponents = baseComponents.length > 0;
  const mergedComponents =
    byId.size > 0 ? [...byId.values()] : base.components ?? null;

  const kept = normalizeSource({
    ...base,
    name: override.name || base.name,
    budget: override.budget || base.budget,
    usageUrl:
      override.usageUrl !== undefined ? override.usageUrl : base.usageUrl,
    components: mergedComponents,
    collectionMode: "automatic",
    status: base.status,
    lastUpdate: base.lastUpdate,
    usage: base.usage,
    limit: base.limit,
    unit: base.unit,
    coverageStart: base.coverageStart,
    breakdown: base.breakdown,
    history: base.history,
    reason: base.reason,
  });

  if (hasBaseComponents && filledIds.length) {
    kept.reason =
      `${kept.reason} Manual override filled missing meter(s) only: ${filledIds.join(", ")} ` +
      `(${manualFreshnessNote(override.lastUpdate, now, { filledMeter: true })}). Source stays automatic from this collect.`;
  } else if (filledIds.length && !hasBaseComponents) {
    kept.reason =
      `${kept.reason} Manual override added meter(s) the automatic path lacked: ` +
      `${filledIds.join(", ")} (${manualFreshnessNote(override.lastUpdate, now, { filledMeter: true })}). ` +
      "Source stays automatic.";
  } else if (!override.supplements) {
    kept.reason = `${kept.reason} A manual override was ignored: the collector measures this source directly.`;
  } else {
    kept.reason = `${kept.reason} A manual override added no new meters; automatic reading kept.`;
  }

  assertHonestSource(kept);
  return kept;
}

/**
 * Apply a validated local override onto an adapter-normalized source.
 * @param {object} base
 * @param {object} override
 * @param {Date} [now]
 */
export function applyOverride(base, override, now = new Date()) {
  if (
    base.id === "claude-code" &&
    /OAuth usage (?:API|backoff|response)|OAuth token/i.test(base.reason || "")
  ) {
    const kept = normalizeSource({
      ...base,
      name: override.name || base.name,
      budget: override.budget || base.budget,
      usageUrl:
        override.usageUrl !== undefined ? override.usageUrl : base.usageUrl,
    });
    kept.reason =
      `${kept.reason} Manual plan percentages were not used after an OAuth failure; ` +
      "the capacity pool stays unknown unless a cached automatic reading exists.";
    assertHonestSource(kept);
    return kept;
  }

  if (isAutomaticMeasurement(base)) {
    return mergeOverrideOntoAutomatic(base, override, now);
  }

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
    pace: {
      daily: null,
      monthly: null,
      weeklyTarget:
        override.pace?.weeklyTarget ?? base.pace?.weeklyTarget ?? null,
    },
  });
  if (!override.reason && (!merged.reason || merged.reason === base.reason)) {
    merged.reason =
      "Local override applied from data/local-overrides.json (credentials never published).";
  }
  merged.reason =
    `${merged.reason} ${manualFreshnessNote(merged.lastUpdate, now)}`.trim();
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
 * Validate data/mac-sources.json shape (not a full snapshot).
 * @param {unknown} payload
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateMacSourcesPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: ["mac-sources must be an object"] };
  }
  const p = /** @type {Record<string, unknown>} */ (payload);
  if (typeof p.measuredAt !== "string" || !p.measuredAt) {
    errors.push("mac-sources.measuredAt must be a non-empty string");
  }
  if (!Array.isArray(p.sources)) {
    return { ok: false, errors: [...errors, "mac-sources.sources must be an array"] };
  }
  const ids = new Set();
  for (const raw of p.sources) {
    if (!raw || typeof raw !== "object") {
      errors.push("each mac source must be an object");
      continue;
    }
    const src = /** @type {Record<string, unknown>} */ (raw);
    if (!MAC_SOURCE_IDS.includes(/** @type {string} */ (src.id))) {
      errors.push(`unknown or non-Mac source id in mac-sources: ${src.id}`);
      continue;
    }
    if (ids.has(src.id)) errors.push(`duplicate mac source id: ${src.id}`);
    ids.add(src.id);
    if (!STATUSES.has(/** @type {string} */ (src.status))) {
      errors.push(`${src.id}: invalid status`);
    }
    if (!COLLECTION_MODES.has(/** @type {string} */ (src.collectionMode))) {
      errors.push(`${src.id}: invalid collectionMode`);
    }
    if (src.status === "unknown" && (!src.reason || typeof src.reason !== "string")) {
      errors.push(`${src.id}: unknown status requires a reason string`);
    }
    errors.push(...validateComponents(src.components, /** @type {string} */ (src.id)));
    try {
      assertHonestSource({
        id: src.id,
        status: src.status || "unknown",
        usage: src.usage ?? null,
        lastUpdate: src.lastUpdate ?? null,
        reason: src.reason || "mac-source",
      });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Load mac-sources.json. Missing / invalid → null (caller inserts unknowns).
 * @param {string} [filePath]
 */
export async function loadMacSources(
  filePath = process.env.AI_USAGE_MAC_SOURCES_PATH || MAC_SOURCES_FILE,
) {
  try {
    await access(filePath);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  if (SECRET_RE.test(JSON.stringify(parsed))) {
    throw new Error(
      "mac-sources.json looks like it contains secrets (fail closed); refusing merge.",
    );
  }
  const check = validateMacSourcesPayload(parsed);
  if (!check.ok) return null;
  return parsed;
}

/**
 * Age of a Mac reading in hours, or null when unreadable.
 * @param {string|null|undefined} measuredAt
 * @param {Date} now
 */
export function macSourceAgeHours(measuredAt, now = new Date()) {
  if (!measuredAt) return null;
  const t = new Date(measuredAt);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, (now.getTime() - t.getTime()) / 3600000);
}

/**
 * Placeholder when the Mac has not published a source yet.
 * @param {string} id
 */
export function missingMacSource(id) {
  return normalizeSource(
    emptySource({
      id,
      status: "unknown",
      collectionMode: "unavailable",
      reason:
        "Waiting for Mac LaunchAgent (scripts/mac-snapshot.sh) to publish data/mac-sources.json. No figures fabricated.",
    }),
  );
}

/**
 * Merge Mac sources into a box-built source list. Keeps each Mac source's own
 * measuredAt / lastUpdate. If older than MAC_STALE_HOURS, marks stale (not deleted).
 *
 * @param {object[]} boxSources
 * @param {{ measuredAt?: string, sources?: object[] }|null} macPayload
 * @param {Date} [now]
 * @returns {object[]}
 */
export function mergeMacSources(boxSources, macPayload, now = new Date()) {
  const byId = new Map(
    (Array.isArray(boxSources) ? boxSources : []).map((s) => [s.id, s]),
  );
  const macById = new Map(
    (Array.isArray(macPayload?.sources) ? macPayload.sources : []).map((s) => [
      s.id,
      s,
    ]),
  );
  const fileMeasuredAt =
    typeof macPayload?.measuredAt === "string" ? macPayload.measuredAt : null;

  for (const id of MAC_SOURCE_IDS) {
    const raw = macById.get(id);
    if (!raw) {
      byId.set(id, missingMacSource(id));
      continue;
    }
    const measuredAt =
      (typeof raw.measuredAt === "string" && raw.measuredAt) ||
      (typeof raw.lastUpdate === "string" && raw.lastUpdate) ||
      fileMeasuredAt;
    const ageHours = macSourceAgeHours(measuredAt, now);
    const stale =
      ageHours == null ? true : ageHours >= MAC_STALE_HOURS;
    let src = normalizeSource({
      ...raw,
      id,
      measuredAt: measuredAt || null,
      lastUpdate: raw.lastUpdate || measuredAt || null,
      stale,
    });
    if (stale) {
      const ageLabel =
        ageHours == null
          ? "unreadable age"
          : ageHours < 1
            ? `${Math.round(ageHours * 60)} minute(s) old`
            : `${Math.round(ageHours)} hour(s) old`;
      const prefix = `STALE (Mac meter ${ageLabel}, threshold ${MAC_STALE_HOURS}h).`;
      if (!/\bSTALE\b/.test(src.reason || "")) {
        src.reason = `${prefix} ${src.reason || ""}`.trim();
      }
      src.stale = true;
    } else {
      delete src.stale;
    }
    byId.set(id, src);
  }

  return SOURCE_IDS.map((id) => {
    if (byId.has(id)) return byId.get(id);
    if (MAC_SOURCE_IDS.includes(id)) return missingMacSource(id);
    throw new Error(`mergeMacSources: missing box source ${id}`);
  });
}

/**
 * Run adapters for a subset of source ids.
 * @param {string[]} ids
 * @param {Record<string, {collect: Function}>} adapters
 * @param {Date} now
 * @param {Map<string, object>} overrideById
 */
async function collectIds(ids, adapters, now, overrideById) {
  const sources = [];
  for (const id of ids) {
    const adapter = adapters[id];
    if (!adapter) {
      throw new Error(`No adapter registered for source ${id}`);
    }
    const result = await adapter.collect({ now });
    let src = normalizeSource(result);
    const ov = overrideById.get(id);
    if (ov) {
      src = applyOverride(src, ov, now);
    }
    sources.push(src);
  }
  return sources;
}

/**
 * Run box adapters and merge Mac sources into a full snapshot.
 * @param {Date} [now]
 * @param {{ overrides?: object[], macSources?: object|null }} [opts]
 */
export async function collectSnapshot(now = new Date(), opts = {}) {
  const overrideList =
    opts.overrides !== undefined ? opts.overrides : await loadLocalOverrides();
  const byId = new Map(overrideList.map((o) => [o.id, o]));

  const boxSources = await collectIds(BOX_SOURCE_IDS, BOX_ADAPTERS, now, byId);
  const macPayload =
    opts.macSources !== undefined
      ? opts.macSources
      : await loadMacSources();
  const sources = mergeMacSources(boxSources, macPayload, now);

  const snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    timezone: "Europe/Amsterdam",
    scheduleNote:
      "Split meter: Linux box cron (scripts/box-snapshot.sh) measures box sources and merges data/mac-sources.json; Mac LaunchAgent (scripts/mac-snapshot.sh) publishes Cursor Agent + Grok Bot. LLM-free, no cloud agent. Pages \"Alles updaten\" only re-fetches published latest.json. Box-online badge uses generatedAt age (~20 min).",
    routing: ROUTING_HOLD,
    sources,
  };
  assertPublishableSnapshot(snapshot);
  return snapshot;
}

/**
 * Run Mac-only adapters → mac-sources payload (not a full snapshot).
 * @param {Date} [now]
 * @param {{ overrides?: object[] }} [opts]
 */
export async function collectMacSourcesSnapshot(now = new Date(), opts = {}) {
  const overrideList =
    opts.overrides !== undefined ? opts.overrides : await loadLocalOverrides();
  const byId = new Map(
    overrideList
      .filter((o) => MAC_SOURCE_IDS.includes(o.id))
      .map((o) => [o.id, o]),
  );

  const sources = await collectIds(MAC_SOURCE_IDS, MAC_ADAPTERS, now, byId);
  const measuredAt = now.toISOString();
  for (const src of sources) {
    src.measuredAt = measuredAt;
    if (!src.lastUpdate) src.lastUpdate = measuredAt;
  }

  const payload = {
    version: SNAPSHOT_VERSION,
    measuredAt,
    timezone: "Europe/Amsterdam",
    sources,
  };
  const check = validateMacSourcesPayload(payload);
  if (!check.ok) {
    throw new Error(`Invalid mac-sources payload: ${check.errors.join("; ")}`);
  }
  if (SECRET_RE.test(JSON.stringify(payload))) {
    throw new Error(
      "Refusing to write mac-sources that look like they contain secrets",
    );
  }
  return payload;
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

export async function writeMacSources(payload, outFile = MAC_SOURCES_FILE) {
  const check = validateMacSourcesPayload(payload);
  if (!check.ok) {
    throw new Error(`Invalid mac-sources payload: ${check.errors.join("; ")}`);
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (SECRET_RE.test(text)) {
    throw new Error(
      "Refusing to write mac-sources that look like they contain secrets",
    );
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, text, "utf8");
  return outFile;
}

async function main() {
  const macMode =
    process.argv.includes("--mac") ||
    process.env.AI_USAGE_COLLECT_MODE === "mac";
  if (macMode) {
    const payload = await collectMacSourcesSnapshot();
    const dest = await writeMacSources(payload);
    // eslint-disable-next-line no-console
    console.log(`Wrote ${dest}`);
    return;
  }
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
