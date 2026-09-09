import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  collect,
  readOpenRouterUsage,
} from "../collector/adapters/openrouter.js";

function jsonResponse(body, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function mockFetch(credits, key) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.endsWith("/credits")) return jsonResponse(credits);
    if (url.endsWith("/auth/key")) return jsonResponse(key);
    return jsonResponse({}, false, 404);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

describe("openrouter adapter", () => {
  it("parses credits + key into a measured source", async () => {
    const credits = { data: { total_credits: 25, total_usage: 0.988 } };
    const key = {
      data: {
        usage: 0.735,
        usage_daily: 0.01,
        usage_weekly: 0.01,
        usage_monthly: 0.735,
      },
    };
    const fetchImpl = mockFetch(credits, key);
    const now = new Date("2026-09-09T12:00:00.000Z");
    const result = await collect({
      apiKey: "sk-or-test",
      fetchImpl,
      now,
    });

    assert.equal(result.id, "openrouter");
    assert.equal(result.status, "measured");
    assert.equal(result.collectionMode, "automatic");
    assert.equal(result.usage, 0.988);
    assert.equal(result.limit, 25);
    assert.equal(result.breakdown.usageMonthly, 0.735);
    assert.equal(result.breakdown.usageDaily, 0.01);
    assert.equal(result.lastUpdate, now.toISOString());
    assert.equal(fetchImpl.calls.length, 2);
    assert.ok(fetchImpl.calls[0].endsWith("/credits"));
    assert.ok(fetchImpl.calls[1].endsWith("/auth/key"));
  });

  it("reports unavailable (not guessed) when the API fails", async () => {
    const fetchImpl = async () => jsonResponse({}, false, 500);
    const result = await collect({ apiKey: "sk-or-test", fetchImpl });
    assert.equal(result.status, "unknown");
    assert.equal(result.collectionMode, "unavailable");
    assert.equal(result.usage, null);
    assert.match(result.reason, /unavailable|OPENROUTER|could not/i);
  });

  it("returns null (no measurement) without an API key", async () => {
    const result = await readOpenRouterUsage({ apiKey: "" });
    assert.equal(result, null);
  });

  it("reports unknown when credits are missing/invalid", async () => {
    const credits = { data: {} }; // no total_credits
    const key = { data: { usage_monthly: 1 } };
    const result = await collect({ apiKey: "k", fetchImpl: mockFetch(credits, key) });
    assert.equal(result.status, "unknown");
  });
});