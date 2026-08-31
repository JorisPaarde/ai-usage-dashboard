import { unknown } from "../lib/adapter-result.js";

/**
 * Cursor Agent — spending/usage is not exposed via a public local API
 * without credentials. Ground-truth UI is https://cursor.com/dashboard/spending.
 * Do not scrape or invent totals; age-stamped manual seeds are the end state.
 */
export async function collect() {
  return unknown(
    "cursor-agent",
    "Cursor spending requires an authenticated dashboard or API that is not wired here. Status Unknown to avoid fabricated figures.",
    { collectionMode: "unavailable" },
  );
}
