/**
 * The routing table: which pools may run which kind of task, in what order.
 *
 * Kept deliberately separate from dispatch (scripts/route.js). Buzz has no
 * agent-invocation step today (block/buzz#3871 is open), so we dispatch
 * ourselves; when that ships, the dispatch half can be deleted and this table
 * stays as-is.
 *
 * No external deps.
 */

/** Quality a pool is trusted with. `max` means real reasoning work. */
export const POOL_QUALITY = Object.freeze({
  local: ["cheap"],
  sail: ["cheap", "normal"],
  cursor: ["cheap", "normal", "max"],
  claude: ["cheap", "normal", "max"],
  openai: ["cheap", "normal", "max"],
  openrouter: ["cheap", "normal", "max"],
});

export const QUALITIES = Object.freeze(["cheap", "normal", "max"]);

/**
 * Ordered pool preference per task type. First entry is the intended home;
 * the rest are overflow. Paid pools come last so a metered pool with room is
 * always preferred, even when it is only `low`.
 */
export const LANES = Object.freeze({
  code: ["cursor", "openai", "openrouter"],
  review: ["claude", "openai", "openrouter"],
  research: ["claude", "openai", "openrouter"],
  classify: ["local", "cursor", "openrouter"],
  digest: ["local", "claude", "openrouter"],
  bulk: ["sail", "openrouter"],
});

export const TASK_TYPES = Object.freeze(Object.keys(LANES));

/**
 * Validate a task before it can be routed. Fail closed: an unroutable task is
 * an error, never a silent default to the most expensive lane.
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTask(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["task must be an object"] };
  }
  const t = /** @type {Record<string, unknown>} */ (raw);
  if (typeof t.id !== "string" || !t.id.trim()) {
    errors.push("task.id must be a non-empty string");
  }
  if (typeof t.type !== "string" || !TASK_TYPES.includes(t.type)) {
    errors.push(`task.type must be one of: ${TASK_TYPES.join(", ")}`);
  }
  if (typeof t.quality !== "string" || !QUALITIES.includes(t.quality)) {
    errors.push(`task.quality must be one of: ${QUALITIES.join(", ")}`);
  }
  if (typeof t.prompt !== "string" || !t.prompt.trim()) {
    errors.push("task.prompt must be a non-empty string");
  }
  if (t.deadline != null && typeof t.deadline !== "string") {
    errors.push("task.deadline must be an ISO string or omitted");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Candidate pools for a task: the lane order, filtered by quality.
 * @param {{type: string, quality: string}} task
 */
export function candidatesFor(task) {
  const lane = LANES[task.type] || [];
  return lane.filter((pool) =>
    (POOL_QUALITY[pool] || []).includes(task.quality),
  );
}

/**
 * Choose a pool for a task given current verdicts.
 *
 * Two passes: take the first candidate that is `ok`, else the first that is
 * `low` or `unknown`, else the first paid pool. Same task plus same verdicts
 * always yields the same pool — no randomness, no time-of-day behaviour beyond
 * what the verdicts already encode.
 *
 * @param {{type: string, quality: string}} task
 * @param {Record<string, {verdict: string, reason?: string}>} verdicts
 * @returns {{pool: string|null, agent: string|null, reason: string, considered: object[]}}
 */
export function pickPool(task, verdicts, pools = {}) {
  const candidates = candidatesFor(task);
  const considered = candidates.map((pool) => ({
    pool,
    verdict: verdicts[pool]?.verdict ?? "unknown",
    reason: verdicts[pool]?.reason ?? "No verdict for this pool.",
  }));

  if (candidates.length === 0) {
    return {
      pool: null,
      agent: null,
      reason: `No pool is allowed to run ${task.type} at quality ${task.quality}.`,
      considered,
    };
  }

  const pass = (want) =>
    candidates.find((pool) => want.includes(verdicts[pool]?.verdict));

  const chosen =
    pass(["ok"]) || pass(["low", "unknown"]) || pass(["paid"]) || null;

  if (!chosen) {
    return {
      pool: null,
      agent: null,
      reason:
        "Every candidate pool is full. Nothing dispatched — refill credits or wait for a reset.",
      considered,
    };
  }

  const verdict = verdicts[chosen]?.verdict;
  const why = verdicts[chosen]?.reason || "";
  const rank =
    verdict === "ok"
      ? "first choice with room"
      : verdict === "paid"
        ? "last resort: every metered pool was full or unusable"
        : "no pool had full room; best remaining";
  return {
    pool: chosen,
    agent: pools[chosen]?.agent ?? null,
    reason: `${chosen} (${verdict}) — ${rank}. ${why}`.trim(),
    considered,
  };
}
