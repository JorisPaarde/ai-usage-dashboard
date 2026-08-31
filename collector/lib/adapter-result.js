/**
 * Shared adapter result shape.
 * Adapters must never invent measured usage.
 */

/**
 * @typedef {object} AdapterResult
 * @property {string} id
 * @property {'measured'|'estimated'|'unknown'} status
 * @property {string} reason
 * @property {number|null} [usage]
 * @property {number|null} [limit]
 * @property {string|null} [unit]
 * @property {string|null} [resetDate]
 * @property {string|null} [lastUpdate]
 * @property {object} [pace]
 * @property {Array<{date:string, usage:number|null}>} [history]
 * @property {object} [budget]
 * @property {string} [name]
 */

/**
 * @param {string} id
 * @param {string} reason
 * @param {Partial<AdapterResult>} [extra]
 * @returns {AdapterResult}
 */
export function unknown(id, reason, extra = {}) {
  return {
    id,
    status: "unknown",
    reason,
    usage: null,
    limit: extra.limit ?? null,
    unit: extra.unit ?? null,
    resetDate: extra.resetDate ?? null,
    lastUpdate: extra.lastUpdate ?? null,
    pace: extra.pace || { daily: null, monthly: null, weeklyTarget: null },
    history: extra.history || [],
    ...(extra.budget ? { budget: extra.budget } : {}),
    ...(extra.name ? { name: extra.name } : {}),
  };
}
