import { unknown } from "../lib/adapter-result.js";

/**
 * Claude Code — plan/usage screens are account-authenticated; no safe local
 * meter is available in this collector.
 */
export async function collect() {
  return unknown(
    "claude-code",
    "Claude Code usage is not available without account credentials. Collector leaves status Unknown.",
    { collectionMode: "unavailable" },
  );
}
