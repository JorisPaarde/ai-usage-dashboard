#!/usr/bin/env node
/**
 * LEGACY HELPER — not wired into any GitHub Actions workflow in this repo.
 * Hosted runners must not collect authenticated desktop meters. The sole live
 * publisher is scripts/local-snapshot.sh (Mac LaunchAgent). Keep this file for
 * optional local tooling; do not re-wire it into .github/workflows/collect.yml.
 *
 * Exit 0 and print run=true/false.
 * Skips scheduled runs that are not near 09:00 or 16:00 Europe/Amsterdam.
 *
 * (Historical) Workflow schedules both CET and CEST UTC candidates; this gate
 * picks the slot that matches local Amsterdam time and rejects off-season misfires.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Morning and afternoon targets in minutes since local midnight. */
export const AMSTERDAM_SLOT_MINUTES = [9 * 60, 16 * 60];

/**
 * @param {Date} [when]
 * @returns {{ hour: number, minute: number, minutes: number, label: string }}
 */
export function amsterdamClock(when = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(when).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    hour,
    minute,
    minutes: hour * 60 + minute,
    label: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * True when Amsterdam local time is within tolerance of 09:00 or 16:00.
 * @param {Date} [when]
 * @param {number} [toleranceMinutes]
 */
export function nearAmsterdamSlot(when = new Date(), toleranceMinutes = 90) {
  const { minutes } = amsterdamClock(when);
  return AMSTERDAM_SLOT_MINUTES.some((t) => Math.abs(minutes - t) <= toleranceMinutes);
}

/**
 * Scheduled runs only proceed near a local slot; manual/workflow_dispatch always run.
 * @param {string} [eventName]
 * @param {Date} [when]
 * @param {number} [toleranceMinutes]
 */
export function shouldRunCollect(eventName = "", when = new Date(), toleranceMinutes = 90) {
  if (eventName && eventName !== "schedule") return true;
  return nearAmsterdamSlot(when, toleranceMinutes);
}

function main() {
  const when = new Date();
  const clock = amsterdamClock(when);
  const near = nearAmsterdamSlot(when);
  const event = process.env.GITHUB_EVENT_NAME || "";
  const run = shouldRunCollect(event, when);

  console.log(
    `Amsterdam ${clock.label} nearSlot=${near} event=${event || "(none)"} run=${run}`,
  );

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `run=${run ? "true" : "false"}\n`);
  } else {
    console.log(`run=${run ? "true" : "false"}`);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
