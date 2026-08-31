import { unknown } from "../lib/adapter-result.js";

/**
 * Cursor Agent — subscription usage is not exposed via a public local API
 * without credentials. Do not scrape or invent totals.
 */
export async function collect() {
  return unknown(
    "cursor-agent",
    "Cursor usage requires an authenticated dashboard or API that is not wired here. Status Unknown to avoid fabricated figures.",
    { collectionMode: "unavailable" },
  );
}
