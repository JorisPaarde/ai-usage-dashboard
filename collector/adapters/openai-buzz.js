import { unknown } from "../lib/adapter-result.js";

/**
 * OpenAI / Buzz — no public usage API and no credentialed path in this repo.
 * Never fabricates numbers.
 */
export async function collect() {
  return unknown(
    "openai-buzz",
    "No local public-safe usage endpoint configured. Connect a read-only export or API later; until then status stays Unknown.",
    { collectionMode: "unavailable" },
  );
}
