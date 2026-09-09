import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../collector/adapters/openrouter.js";

function jsonResponse(body, status = 200) {
  return {
    status,
    json: async () => body,
  };
}

function mockFetch(credits, key) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/credits")) return jsonResponse(credits);
    if (String(url).includes("/key")) return jsonResponse(key);
    return jsonResponse({}, 404);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

describe("openrouter adapter (main-compat)", () => {
  it("parses credits into a measured source", async () => {
    const credits = { data: { total_credits: 25, total_usage: 0.988 } };
    const key = { data: { limit: null, usage: 0.735, usage_monthly: 0.735 } };
    const fetchImpl = mockFetch(credits, key);
    const now = new Date("2026-09-09T12:00:00.000Z");
    const result = await collect({
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      fetchImpl,
      now,
    });

    assert.equal(result.id, "openrouter");
    assert.equal(result.status, "measured");
    assert.equal(result.collectionMode, "automatic");
    assert.equal(result.usage, 0.988);
    assert.equal(result.limit, 25);
    assert.equal(result.lastUpdate, now.toISOString());
    assert.ok(fetchImpl.calls.some((u) => u.includes("/credits")));
    assert.doesNotMatch(JSON.stringify(result), /sk-or-test/);
  });

  it("reports unavailable (not guessed) when the API fails", async () => {
    const fetchImpl = async () => jsonResponse({}, 500);
    const result = await collect({
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      fetchImpl,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.collectionMode, "unavailable");
    assert.equal(result.usage, null);
    assert.match(result.reason, /unavailable|OPENROUTER|No usage fabricated/i);
  });

  it("stays unknown without an API key", async () => {
    const result = await collect({ env: { OPENROUTER_API_KEY: "" } });
    assert.equal(result.status, "unknown");
    assert.equal(result.usage, null);
  });

  it("reports unknown when credits are missing/invalid and the key is uncapped", async () => {
    const credits = { data: {} };
    const key = { data: { usage_monthly: 1 } };
    const result = await collect({
      env: { OPENROUTER_API_KEY: "k" },
      fetchImpl: mockFetch(credits, key),
    });
    assert.equal(result.status, "unknown");
  });
});
