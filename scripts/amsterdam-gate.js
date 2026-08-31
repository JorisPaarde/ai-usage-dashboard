#!/usr/bin/env node
/**
 * Exit 0 and print run=true/false for GitHub Actions.
 * Skips scheduled runs that are not near 09:00 or 16:00 Europe/Amsterdam.
 */
import { appendFileSync } from "node:fs";

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const parts = Object.fromEntries(
  fmt.formatToParts(new Date()).map((p) => [p.type, p.value]),
);
const minutes = Number(parts.hour) * 60 + Number(parts.minute);
const targets = [9 * 60, 16 * 60];
const near = targets.some((t) => Math.abs(minutes - t) <= 90);
const event = process.env.GITHUB_EVENT_NAME || "";
const run = near || event !== "schedule";

console.log(`Amsterdam ${parts.hour}:${parts.minute} nearSlot=${near} event=${event} run=${run}`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `run=${run ? "true" : "false"}\n`);
} else {
  console.log(`run=${run ? "true" : "false"}`);
}
