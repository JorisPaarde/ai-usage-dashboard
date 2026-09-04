/**
 * Capacity routing facts — which pool has room, and how old that answer is.
 *
 * Deliberately NOT the same thing as `snapshot.routing`, which is the
 * local-share metric (how much work ran on the local runtime). This module is
 * about capacity per provider pool and drives task dispatch.
 *
 * Honesty rules, same house style as the collector:
 * - A pool is never called `ok` from an estimate. A percentage only exists when
 *   a measured source carried usage AND limit; otherwise it is null and the
 *   pool reads `unknown`, which the caller must treat as `low`, never as room.
 * - The verdict is NOT stored. `poolsFromSnapshot` writes facts plus each
 *   pool's own `measuredAt` and `maxAgeMinutes`; `verdictForPool` computes the
 *   verdict against a clock at read time. A stored verdict would go stale in
 *   the file exactly the way a fresh `generatedAt` over old values did.
 * - A pool observed to be out of quota (a 429 from the provider) can be blocked
 *   from outside; a block always wins over any measurement.
 *
 * No external deps.
 */

/** Below this percentage a pool is freely usable. */
export const OK_BELOW_PERCENT = 80;
/** At or above this percentage a pool is treated as exhausted. */
export const FULL_AT_PERCENT = 95;

function positiveMinutes(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Keep the router's freshness window aligned with the OAuth cache interval. */
export const CLAUDE_MAX_AGE_MINUTES = positiveMinutes(
  process.env.CLAUDE_OAUTH_CACHE_TTL_MINUTES,
  60,
);

/**
 * Which dashboard source backs each pool, and how the pool's headline
 * percentage is derived from it.
 *
 * `componentIds` — max over those named components (percent of their own limit).
 * `componentRole` — max over components carrying that role. Cursor's capped
 *   meters (on-demand spend, Grok weekly) are deliberately excluded from the
 *   verdict: on 2026-08-31 on-demand sat at 98% while included capacity was
 *   under 30%, and reading that as "Cursor is full" would push all repo work to
 *   a paid lane for no reason.
 * `useSourceUsage` — the source's own usage/limit is the meter.
 * `unmetered` — no quota exists (local runtime); measured means usable.
 */
export const POOLS = Object.freeze({
  claude: {
    sourceId: "claude-code",
    componentIds: ["session", "weekly-all-models"],
    maxAgeMinutes: CLAUDE_MAX_AGE_MINUTES,
    agent: "Claude-agent",
  },
  openai: {
    sourceId: "openai-buzz",
    useSourceUsage: true,
    maxAgeMinutes: 15,
    agent: "Codex-agent",
  },
  cursor: {
    sourceId: "cursor-agent",
    componentRole: "capacity",
    maxAgeMinutes: 60,
    agent: "Cursor Builder",
  },
  local: {
    sourceId: "ollama",
    unmetered: true,
    maxAgeMinutes: 60,
    agent: "LocalAI guy",
  },
  sail: {
    sourceId: "sail",
    componentIds: ["period"],
    maxAgeMinutes: 15,
    agent: "sail-worker",
    paidFallback: true,
    note: "Prepaid credits, flex window.",
  },
  openrouter: {
    sourceId: "openrouter",
    componentIds: ["credits", "key-limit"],
    maxAgeMinutes: 15,
    agent: "or-worker",
    paidFallback: true,
    note: "Prepaid credits, pay per token.",
  },
});

/**
 * @deprecated Prepaid pools now live in POOLS with `paidFallback`. Kept as an
 * empty table so older imports do not throw; poolsFromSnapshot no longer
 * iterates it.
 */
export const PAID_POOLS = Object.freeze({});

function pct(usage, limit) {
  if (typeof usage !== "number" || !Number.isFinite(usage)) return null;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return Math.round((usage / limit) * 1000) / 10;
}

/**
 * Highest percentage among the accepted components, plus the provenance of the
 * ones that contributed.
 *
 * Provenance matters more than it looks. A source can report
 * `collectionMode: "automatic"` with `lastUpdate` set to this collect while the
 * individual plan meters were filled from a hand-typed override — that is what
 * happens when the Claude OAuth token is rejected and the seed fills the gap.
 * Reading only the source would call a day-old 0% a fresh measurement.
 */
function maxPercent(components, accept) {
  let best = null;
  /** @type {string[]} */
  const manualIds = [];
  /** @type {string[]} */
  const filledAts = [];
  for (const c of components || []) {
    if (!c || typeof c.id !== "string") continue;
    if (!accept(c)) continue;
    const p = pct(c.usage, c.limit);
    if (p == null) continue;
    best = best == null ? p : Math.max(best, p);
    if (c.filledFrom === "manual") {
      manualIds.push(c.id);
      if (typeof c.filledAt === "string" && c.filledAt) filledAts.push(c.filledAt);
    }
  }
  // The oldest contributing fill decides the pool's age: a percentage is only
  // as fresh as the weakest number behind it.
  const oldestFill = filledAts.length
    ? filledAts.reduce((a, b) => (new Date(a) < new Date(b) ? a : b))
    : null;
  return { percent: best, manualIds, oldestFill };
}

function cappedMeters(components) {
  const out = [];
  for (const c of components || []) {
    if (!c || c.role !== "capped") continue;
    const p = pct(c.usage, c.limit);
    if (p == null) continue;
    out.push({ id: c.id, percent: p });
  }
  return out;
}

/**
 * Derive one pool's facts from its backing source.
 * @param {string} name
 * @param {object} config
 * @param {object|undefined} source
 */
export function poolFromSource(name, config, source) {
  const base = {
    pool: name,
    agent: config.agent,
    sourceId: config.sourceId,
    percent: null,
    capped: [],
    measuredAt: null,
    maxAgeMinutes: config.maxAgeMinutes,
    collectionMode: "unavailable",
    unmetered: Boolean(config.unmetered),
    reason: "",
  };

  if (!source) {
    return {
      ...base,
      paid: Boolean(config.paidFallback),
      reason: config.paidFallback
        ? `${config.note || "Prepaid pool."} No source ${config.sourceId} in snapshot; last resort until a live meter exists.`
        : `No source ${config.sourceId} in snapshot.`,
    };
  }
  base.collectionMode = source.collectionMode || "unavailable";
  base.measuredAt = source.lastUpdate ?? null;

  if (source.status !== "measured") {
    return {
      ...base,
      paid: Boolean(config.paidFallback),
      reason: config.paidFallback
        ? `${config.note || "Prepaid pool."} Last resort until a live meter exists. ${source.reason || "unmeasured"}`
        : source.reason ||
          `Source ${config.sourceId} is ${source.status}; no percentage derived.`,
    };
  }

  if (config.unmetered) {
    return {
      ...base,
      reason: "Local runtime; no quota. Measured means usable.",
    };
  }

  let percent = null;
  let manualIds = [];
  let oldestFill = null;
  if (config.componentIds) {
    const wanted = new Set(config.componentIds);
    ({ percent, manualIds, oldestFill } = maxPercent(source.components, (c) =>
      wanted.has(c.id),
    ));
  } else if (config.componentRole) {
    ({ percent, manualIds, oldestFill } = maxPercent(
      source.components,
      (c) => c.role === config.componentRole,
    ));
  } else if (config.useSourceUsage) {
    percent = pct(source.usage, source.limit);
  }

  if (manualIds.length) {
    // Downgrade the pool to what it really is: a hand-typed reading, aged from
    // when it was typed, not from when the collector last ran.
    base.collectionMode = "manual";
    base.measuredAt = oldestFill;
    base.filledFrom = manualIds;
  }

  const capped = cappedMeters(source.components);
  if (percent == null) {
    if (config.paidFallback) {
      return {
        ...base,
        capped,
        paid: true,
        reason:
          `${config.note || "Prepaid pool."} Measured, but no usage/limit pair ` +
          "to turn into a percentage — last resort until a live meter exists.",
      };
    }
    return {
      ...base,
      capped,
      measuredAt: null,
      collectionMode: "unavailable",
      reason:
        "Measured, but no usage/limit pair to turn into a percentage — " +
        "consumption without a known limit is not room.",
    };
  }
  return {
    ...base,
    percent,
    capped,
    reason: manualIds.length
      ? `Hand-typed meter(s) ${manualIds.join(", ")} behind this number; ` +
        `aged from the fill${oldestFill ? ` at ${oldestFill}` : " (no timestamp)"}, not from the collect.`
      : config.componentIds
        ? `Highest of ${config.componentIds.join(", ")}.`
        : config.componentRole
          ? `Highest capacity meter; capped meters reported separately.`
          : "Source usage against its own limit.",
  };
}

/**
 * Build the capacity fact set from a published snapshot.
 * @param {object} snapshot
 */
export function poolsFromSnapshot(snapshot) {
  const byId = new Map(
    (snapshot?.sources || []).map((s) => [s.id, s]),
  );
  /** @type {Record<string, object>} */
  const pools = {};
  for (const [name, config] of Object.entries(POOLS)) {
    pools[name] = poolFromSource(name, config, byId.get(config.sourceId));
  }
  return {
    snapshotGeneratedAt: snapshot?.generatedAt ?? null,
    thresholds: { okBelowPercent: OK_BELOW_PERCENT, fullAtPercent: FULL_AT_PERCENT },
    note:
      "Facts only. Verdicts are computed at read time by verdictForPool(); a " +
      "stored verdict would age inside this file.",
    pools,
  };
}

/**
 * Age of a measurement in minutes, or null when there is no timestamp.
 * @param {string|null} measuredAt
 * @param {Date} now
 */
export function ageMinutes(measuredAt, now = new Date()) {
  if (!measuredAt) return null;
  const t = new Date(measuredAt);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, (now.getTime() - t.getTime()) / 60000);
}

/**
 * Verdict for one pool: "ok" | "low" | "full" | "unknown".
 *
 * Asymmetric on purpose. `ok` requires a fresh measurement; `full` may be set
 * by an observed quota error regardless of what any measurement says; anything
 * stale or unmeasurable degrades to `low`, which costs a little paid capacity
 * rather than a run that dies halfway.
 *
 * @param {object} fact one entry from poolsFromSnapshot().pools
 * @param {Date} [now]
 * @param {Record<string, {until?: string, reason?: string}>} [blocks]
 */
export function verdictForPool(fact, now = new Date(), blocks = {}) {
  const block = blocks?.[fact.pool];
  if (block) {
    const until = block.until ? new Date(block.until) : null;
    const active = !until || Number.isNaN(until.getTime()) || until > now;
    if (active) {
      return {
        verdict: "full",
        age: null,
        reason: `Observed out of quota: ${block.reason || "provider reported a quota error"}.`,
      };
    }
  }

  if (fact.paid) {
    return {
      verdict: "paid",
      age: null,
      reason: "Prepaid pool without a meter; last resort.",
    };
  }

  const age = ageMinutes(fact.measuredAt, now);
  const stale =
    age == null ||
    (typeof fact.maxAgeMinutes === "number" && age > fact.maxAgeMinutes);

  if (fact.unmetered) {
    if (fact.collectionMode !== "automatic" || stale) {
      return {
        verdict: "low",
        age,
        reason: "Local runtime not proven up in this window.",
      };
    }
    return { verdict: "ok", age, reason: "Local runtime measured; no quota." };
  }

  if (fact.percent == null) {
    return {
      verdict: "unknown",
      age,
      reason: fact.reason || "No percentage available.",
    };
  }
  if (fact.percent >= FULL_AT_PERCENT) {
    return {
      verdict: "full",
      age,
      reason: `At ${fact.percent}% of limit.`,
    };
  }
  if (stale) {
    return {
      verdict: "low",
      age,
      reason:
        age == null
          ? "Measurement carries no timestamp."
          : `Measurement is ${Math.round(age)} min old, past its ${fact.maxAgeMinutes} min limit.`,
    };
  }
  if (fact.percent >= OK_BELOW_PERCENT) {
    return { verdict: "low", age, reason: `At ${fact.percent}% of limit.` };
  }
  return { verdict: "ok", age, reason: `At ${fact.percent}% of limit.` };
}

/**
 * Verdicts for every pool in a fact set.
 * @param {object} facts
 * @param {Date} [now]
 * @param {object} [blocks]
 */
export function verdictsFor(facts, now = new Date(), blocks = {}) {
  /** @type {Record<string, {verdict:string, age:number|null, reason:string}>} */
  const out = {};
  for (const [name, fact] of Object.entries(facts?.pools || {})) {
    out[name] = verdictForPool(fact, now, blocks);
  }
  return out;
}
