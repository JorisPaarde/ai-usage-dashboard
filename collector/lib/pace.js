/**
 * Pace helpers for daily / monthly / weekly targets.
 * Pure functions — safe for tests and adapters.
 */

/**
 * Days elapsed in the Amsterdam calendar month for an ISO timestamp.
 * @param {string|Date} when
 * @param {string} [timeZone]
 */
export function dayOfMonthInZone(when = new Date(), timeZone = "Europe/Amsterdam") {
  const d = when instanceof Date ? when : new Date(when);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return Number(map.day);
}

/**
 * Calendar days in the Amsterdam month containing `when`.
 * @param {string|Date} when
 * @param {string} [timeZone]
 */
export function daysInMonthInZone(when = new Date(), timeZone = "Europe/Amsterdam") {
  const d = when instanceof Date ? when : new Date(when);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const year = Number(map.year);
  const month = Number(map.month);
  // Day 0 of next month = last day of this month (UTC construction is fine for length).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * YYYY-MM-DD in a timezone.
 * @param {string|Date} when
 * @param {string} [timeZone]
 */
export function dateKeyInZone(when = new Date(), timeZone = "Europe/Amsterdam") {
  const d = when instanceof Date ? when : new Date(when);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Compute daily and monthly pace from cumulative usage.
 * dailyPace = usage / daysElapsed
 * monthlyPace = dailyPace * daysInMonth (projected)
 * @param {number|null} usage
 * @param {string|Date} [when]
 * @param {string} [timeZone]
 */
export function computePace(usage, when = new Date(), timeZone = "Europe/Amsterdam") {
  if (usage == null || Number.isNaN(usage)) {
    return { daily: null, monthly: null };
  }
  const elapsed = Math.max(1, dayOfMonthInZone(when, timeZone));
  const dim = daysInMonthInZone(when, timeZone);
  const daily = usage / elapsed;
  const monthly = daily * dim;
  return {
    daily: round1(daily),
    monthly: round1(monthly),
  };
}

/**
 * Suggested average per day to stay under a weekly max.
 * @param {number} weeklyMax
 */
export function dailyCapFromWeekly(weeklyMax) {
  return round1(weeklyMax / 7);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Compact history: keep last N days, newest last.
 * @param {Array<{date:string, usage:number|null}>} history
 * @param {number} [maxDays]
 */
export function compactHistory(history, maxDays = 14) {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(-maxDays);
}
