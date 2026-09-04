#!/usr/bin/env node
/**
 * Derive data/routing.json (capacity facts per pool) from data/latest.json.
 *
 * Deterministic and LLM-free, like the rest of the measurement chain. Facts
 * only — no verdict is stored, because a stored verdict ages inside the file.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { poolsFromSnapshot } from "../collector/lib/routing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = process.env.AI_USAGE_SNAPSHOT_PATH
  ? path.resolve(process.env.AI_USAGE_SNAPSHOT_PATH)
  : path.join(ROOT, "data", "latest.json");
export const ROUTING_FILE = path.join(ROOT, "data", "routing.json");

/**
 * @param {string} [snapshotPath]
 * @param {string} [outFile]
 */
export async function writeRouting(snapshotPath = SNAPSHOT, outFile = ROUTING_FILE) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (e) {
    throw new Error(
      `Cannot read snapshot ${snapshotPath} (fail closed): ${e instanceof Error ? e.message : e}`,
    );
  }
  const facts = poolsFromSnapshot(snapshot);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
  return outFile;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  writeRouting()
    .then((dest) => console.log(`Wrote ${dest}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
