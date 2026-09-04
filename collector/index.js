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
import { compactHistory } from "./lib/pace.js";

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
  // pace.daily / pace.monthly removed from the product — do not compute or show them.
  src.pace = {
    daily: null,
    monthly: null,
    weeklyTarget: src.pace?.weeklyTarget ?? null,
  };
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
 * Missing component ids (e.g. Claude usage-credits when OAuth omitted them)
 * may still be filled from the override.
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
  // Only a declared supplement may add meters the automatic path lacked.
  // A non-supplement override is presentation-only (name / budget / usageUrl).
  if (override.supplements) {
    for (const c of overrideComponents) {
      if (!c || typeof c.id !== "string" || !c.id) continue;
      if (byId.has(c.id)) continue;
      // Stamp provenance on the component itself. The source stays
      // collectionMode "automatic" because the adapter did measure something
      // this run, and its lastUpdate is this collect — so a consumer reading
      // only the source cannot tell that these particular meters are a
      // hand-typed seed from yesterday. Carrying the fill's own age here is
      // what lets the capacity router refuse to treat them as fresh.
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

  // Headline usage/limit stay with the automatic reading. Overrides never
  // replace OAuth/plan components wholesale, and never demote collectionMode.
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
    // Automatic tokens-only + override components for plan meters that OAuth
    // could not return this run — still automatic; components are supplements.
    kept.reason =
      `${kept.reason} Manual override added meter(s) the automatic path lacked: ` +
      `${filledIds.join(", ")} (${manualFreshnessNote(override.lastUpdate, now, { filledMeter: true })}). ` +
      "Source stays automatic.";
  } else if (!override.supplements) {
    kept.reason = `${kept.reason} A manual override was ignored: the collector measures this source directly.`;
  } else {
    kept.reason = `${kept.reason} A manual override added no new meters; automatic reading kept.`;
  }

  // Never append whole-source STALE / "no local meter" copy when we measured live.
  assertHonestSource(kept);
  return kept;
}

/**
 * Apply a validated local override onto an adapter-normalized source.
 * Only sanitized aggregate fields flow into the published snapshot.
 *
 * A manual override never silently replaces a real automatic reading of the
 * same thing — that is how a scheduled run ends up republishing hand-typed
 * numbers as if it had measured them. When the adapter measured this run,
 * overrides may only fill *missing* component meters (see
 * mergeOverrideOntoAutomatic); they cannot flip collectionMode to manual.
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
    version: "1.6.1",
    generatedAt: now.toISOString(),
    timezone: "Europe/Amsterdam",
    scheduleNote:
      "Local LaunchAgent collects + publishes every 15 minutes (LLM-free, no cloud agent). Pages \"Alles updaten\" only re-fetches published latest.json. Mac-online badge uses generatedAt age (~20 min). On-demand re-measure: local app only — never Codex/Grok/agent.",
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
