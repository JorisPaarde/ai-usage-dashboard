/** Snapshot schema helpers — no external deps. */

export const SOURCE_IDS = [
  "openai-buzz",
  "cursor-agent",
  "claude-code",
  "ollama",
  "enrich-labs",
];

export const SOURCE_META = {
  "openai-buzz": {
    name: "OpenAI / Buzz",
    unit: "requests",
    usageUrl: "https://chatgpt.com/#settings/Usage",
  },
  "cursor-agent": {
    name: "Cursor Agent",
    unit: "mixed (see components)",
    // Ground truth is the Spending page (Joris 2026-08-31), not Usage tab.
    usageUrl: "https://cursor.com/dashboard/spending",
  },
  "claude-code": {
    name: "Claude Code",
    unit: "credits",
    usageUrl: "https://claude.ai/new#settings/usage",
  },
  ollama: {
    name: "Ollama",
    unit: "tokens",
    // Local-only; no vendor cloud usage page.
    usageUrl: null,
  },
  "enrich-labs": {
    name: "Enrich Labs",
    unit: "credits",
    usageUrl: "https://www.enrichlabs.ai/login",
  },
};

/** Public Enrich Starter budget and pace policy (list pricing / operating target). */
export const ENRICH_MONTHLY_BUDGET = 200;
export const ENRICH_WEEKLY_PACE_MAX = 50;

export const STATUSES = new Set(["measured", "estimated", "unknown"]);
export const COLLECTION_MODES = new Set(["automatic", "manual", "unavailable"]);

/**
 * @param {object} partial
 * @returns {object}
 */
/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHttpsUsageUrl(value) {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {unknown} raw
 * @param {string} sourceId
 * @returns {string[]}
 */
export function validateComponents(raw, sourceId) {
  const errors = [];
  if (raw == null) return errors;
  if (!Array.isArray(raw)) {
    errors.push(`${sourceId}: components must be an array or null`);
    return errors;
  }
  const ids = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      errors.push(`${sourceId}: each component must be an object`);
      continue;
    }
    const c = /** @type {Record<string, unknown>} */ (item);
    if (typeof c.id !== "string" || !c.id) {
      errors.push(`${sourceId}: component.id must be a non-empty string`);
    } else if (ids.has(c.id)) {
      errors.push(`${sourceId}: duplicate component id: ${c.id}`);
    } else {
      ids.add(c.id);
    }
    if (typeof c.label !== "string" || !c.label) {
      errors.push(`${sourceId}: component.label must be a non-empty string`);
    }
    if (c.usage != null && typeof c.usage !== "number") {
      errors.push(`${sourceId}: component.usage must be number or null`);
    }
    if (c.limit != null && typeof c.limit !== "number") {
      errors.push(`${sourceId}: component.limit must be number or null`);
    }
    if (c.unit != null && typeof c.unit !== "string") {
      errors.push(`${sourceId}: component.unit must be string or null`);
    }
    if (c.resetDate != null && typeof c.resetDate !== "string") {
      errors.push(`${sourceId}: component.resetDate must be string or null`);
    }
    if (
      c.role != null &&
      c.role !== "capacity" &&
      c.role !== "capped"
    ) {
      errors.push(
        `${sourceId}: component.role must be "capacity", "capped", or omitted`,
      );
    }
  }
  return errors;
}

export function emptySource(partial = {}) {
  const id = partial.id;
  const meta = SOURCE_META[id] || { name: id, unit: null, usageUrl: null };
  return {
    id,
    name: partial.name || meta.name,
    status: partial.status || "unknown",
    collectionMode:
      partial.collectionMode ||
      (partial.status === "unknown" ? "unavailable" : "manual"),
    reason: partial.reason || "No observation yet.",
    usage: partial.usage ?? null,
    limit: partial.limit ?? null,
    unit: partial.unit ?? meta.unit,
    resetDate: partial.resetDate ?? null,
    lastUpdate: partial.lastUpdate ?? null,
    coverageStart: partial.coverageStart ?? null,
    breakdown: partial.breakdown ?? null,
    components: Array.isArray(partial.components) ? partial.components : null,
    usageUrl:
      partial.usageUrl !== undefined ? partial.usageUrl : (meta.usageUrl ?? null),
    pace: {
      daily: partial.pace?.daily ?? null,
      monthly: partial.pace?.monthly ?? null,
      weeklyTarget: partial.pace?.weeklyTarget ?? null,
    },
    history: Array.isArray(partial.history) ? partial.history : [],
    ...(partial.budget ? { budget: partial.budget } : {}),
  };
}

/**
 * Local-share bucket: percent is null when total is 0 (no tasks ≠ 0% local).
 * @param {unknown} raw
 * @param {string} label
 * @returns {string[]}
 */
export function validateRoutingBucket(raw, label) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return [`${label}: must be an object`];
  }
  const b = /** @type {Record<string, unknown>} */ (raw);
  for (const key of ["local", "total"]) {
    if (typeof b[key] !== "number" || !Number.isFinite(b[key]) || b[key] < 0) {
      errors.push(`${label}.${key} must be a non-negative number`);
    }
  }
  if (typeof b.local === "number" && typeof b.total === "number" && b.local > b.total) {
    errors.push(`${label}: local cannot exceed total`);
  }
  if (b.percent != null) {
    if (typeof b.percent !== "number" || !Number.isFinite(b.percent)) {
      errors.push(`${label}.percent must be number or null`);
    } else if (b.total === 0) {
      errors.push(`${label}.percent must be null when total is 0`);
    }
  } else if (b.total !== 0 && b.total != null) {
    errors.push(`${label}.percent must be a number when total > 0`);
  }
  return errors;
}

/**
 * Top-level routing metric — not a sixth SOURCE_IDS entry.
 * Entire object is null when the routing log is missing/unreadable.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function validateRouting(raw) {
  if (raw == null) return [];
  if (typeof raw !== "object") return ["routing must be an object or null"];
  const r = /** @type {Record<string, unknown>} */ (raw);
  const errors = [
    ...validateRoutingBucket(r.today, "routing.today"),
    ...validateRoutingBucket(r.rolling7d, "routing.rolling7d"),
  ];
  if (r.lastEntry != null && typeof r.lastEntry !== "string") {
    errors.push("routing.lastEntry must be string or null");
  }
  if (typeof r.skipped !== "number" || !Number.isFinite(r.skipped) || r.skipped < 0) {
    errors.push("routing.skipped must be a non-negative number");
  }
  return errors;
}

/**
 * Validate a snapshot; returns { ok, errors }.
 * @param {unknown} snapshot
 */
export function validateSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, errors: ["snapshot must be an object"] };
  }
  const s = /** @type {Record<string, unknown>} */ (snapshot);
  if (typeof s.version !== "string") errors.push("version must be a string");
  if (typeof s.generatedAt !== "string") errors.push("generatedAt must be a string");
  if (s.timezone !== "Europe/Amsterdam") {
    errors.push('timezone must be "Europe/Amsterdam"');
  }
  if ("routing" in s) {
    errors.push(...validateRouting(s.routing));
  }
  if (!Array.isArray(s.sources)) {
    errors.push("sources must be an array");
    return { ok: false, errors };
  }
  const ids = new Set();
  for (const raw of s.sources) {
    if (!raw || typeof raw !== "object") {
      errors.push("each source must be an object");
      continue;
    }
    const src = /** @type {Record<string, unknown>} */ (raw);
    if (!SOURCE_IDS.includes(/** @type {string} */ (src.id))) {
      errors.push(`unknown source id: ${src.id}`);
    }
    if (ids.has(src.id)) errors.push(`duplicate source id: ${src.id}`);
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
    if (src.usage != null && typeof src.usage !== "number") {
      errors.push(`${src.id}: usage must be number or null`);
    }
    if (src.limit != null && typeof src.limit !== "number") {
      errors.push(`${src.id}: limit must be number or null`);
    }
    if (src.coverageStart != null && typeof src.coverageStart !== "string") {
      errors.push(`${src.id}: coverageStart must be string or null`);
    }
    if (src.breakdown != null && typeof src.breakdown !== "object") {
      errors.push(`${src.id}: breakdown must be object or null`);
    }
    errors.push(...validateComponents(src.components, /** @type {string} */ (src.id)));
    if (!isHttpsUsageUrl(src.usageUrl)) {
      errors.push(`${src.id}: usageUrl must be https URL or null`);
    }
    if (!Array.isArray(src.history)) {
      errors.push(`${src.id}: history must be an array`);
    } else {
      for (const h of src.history) {
        if (!h || typeof h !== "object") {
          errors.push(`${src.id}: history entry must be object`);
          continue;
        }
        const entry = /** @type {Record<string, unknown>} */ (h);
        if (typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
          errors.push(`${src.id}: history date must be YYYY-MM-DD`);
        }
        if (entry.usage != null && typeof entry.usage !== "number") {
          errors.push(`${src.id}: history usage must be number or null`);
        }
      }
    }
  }
  for (const id of SOURCE_IDS) {
    if (!ids.has(id)) errors.push(`missing source: ${id}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Reject fabricated measured values: measured requires numeric usage OR an
 * explicit empty-history observation with lastUpdate; estimated may have
 * usage; unknown must not invent usage numbers.
 * @param {object} source
 */
export function assertHonestSource(source) {
  if (!source || typeof source !== "object") {
    throw new Error("source must be an object");
  }
  if (!STATUSES.has(source.status)) {
    throw new Error(`${source.id || "?"}: invalid status ${source.status}`);
  }
  if (source.status === "unknown" && source.usage != null) {
    throw new Error(
      `${source.id}: unknown sources must not report usage (got ${source.usage})`,
    );
  }
  if (source.status === "measured" && source.usage == null && !source.lastUpdate) {
    throw new Error(`${source.id}: measured status needs usage or lastUpdate`);
  }
  if (source.status === "estimated" && source.usage == null) {
    throw new Error(`${source.id}: estimated status needs numeric usage`);
  }
}

/**
 * Fail closed: schema + honesty for every source. Throws on any failure.
 * @param {unknown} snapshot
 */
export function assertPublishableSnapshot(snapshot) {
  const check = validateSnapshot(snapshot);
  if (!check.ok) {
    throw new Error(`Invalid snapshot: ${check.errors.join("; ")}`);
  }
  const sources = /** @type {{sources: object[]}} */ (snapshot).sources;
  for (const src of sources) {
    assertHonestSource(src);
  }
}

/**
 * Validate a local override file shape (not a full snapshot).
 * @param {unknown} overrides
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLocalOverrides(overrides) {
  const errors = [];
  if (!overrides || typeof overrides !== "object") {
    return { ok: false, errors: ["overrides must be an object"] };
  }
  const o = /** @type {Record<string, unknown>} */ (overrides);
  if (!Array.isArray(o.sources)) {
    return { ok: false, errors: ["overrides.sources must be an array"] };
  }
  const ids = new Set();
  for (const raw of o.sources) {
    if (!raw || typeof raw !== "object") {
      errors.push("each override must be an object");
      continue;
    }
    const src = /** @type {Record<string, unknown>} */ (raw);
    if (!SOURCE_IDS.includes(/** @type {string} */ (src.id))) {
      errors.push(`unknown override id: ${src.id}`);
      continue;
    }
    if (ids.has(src.id)) errors.push(`duplicate override id: ${src.id}`);
    ids.add(src.id);
    if (src.status != null && !STATUSES.has(/** @type {string} */ (src.status))) {
      errors.push(`${src.id}: invalid status`);
    }
    if (
      src.collectionMode != null &&
      !COLLECTION_MODES.has(/** @type {string} */ (src.collectionMode))
    ) {
      errors.push(`${src.id}: invalid collectionMode`);
    }
    if (src.usage != null && typeof src.usage !== "number") {
      errors.push(`${src.id}: usage must be number or null`);
    }
    if (src.limit != null && typeof src.limit !== "number") {
      errors.push(`${src.id}: limit must be number or null`);
    }
    if (src.reason != null && typeof src.reason !== "string") {
      errors.push(`${src.id}: reason must be a string`);
    }
    errors.push(...validateComponents(src.components, /** @type {string} */ (src.id)));
    if (src.usageUrl !== undefined && !isHttpsUsageUrl(src.usageUrl)) {
      errors.push(`${src.id}: usageUrl must be https URL or null`);
    }
    if (src.history != null) {
      if (!Array.isArray(src.history)) {
        errors.push(`${src.id}: history must be an array`);
      } else {
        for (const h of src.history) {
          if (!h || typeof h !== "object") {
            errors.push(`${src.id}: history entry must be object`);
            continue;
          }
          const entry = /** @type {Record<string, unknown>} */ (h);
          if (typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
            errors.push(`${src.id}: history date must be YYYY-MM-DD`);
          }
          if (entry.usage != null && typeof entry.usage !== "number") {
            errors.push(`${src.id}: history usage must be number or null`);
          }
        }
      }
    }
    // Provisional honesty check on the merged-looking fields we care about.
    try {
      assertHonestSource({
        id: src.id,
        status: src.status || "unknown",
        usage: src.usage ?? null,
        lastUpdate: src.lastUpdate ?? null,
        reason: src.reason || "override",
      });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { ok: errors.length === 0, errors };
}
