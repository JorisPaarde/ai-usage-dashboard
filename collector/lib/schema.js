/** Snapshot schema helpers — no external deps. */

export const SOURCE_IDS = [
  "openai-buzz",
  "cursor-agent",
  "claude-code",
  "ollama",
  "enrich-labs",
];

export const SOURCE_META = {
  "openai-buzz": { name: "OpenAI / Buzz", unit: "requests" },
  "cursor-agent": { name: "Cursor Agent", unit: "tokens" },
  "claude-code": { name: "Claude Code", unit: "credits" },
  ollama: { name: "Ollama", unit: "tokens" },
  "enrich-labs": { name: "Enrich Labs", unit: "credits" },
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
export function emptySource(partial = {}) {
  const id = partial.id;
  const meta = SOURCE_META[id] || { name: id, unit: null };
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
