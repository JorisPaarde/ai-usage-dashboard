import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as openrouter from "../collector/adapters/openrouter.js";
import * as sail from "../collector/adapters/sail-research.js";
import { envKey } from "../collector/lib/json-get.js";
import { SOURCE_IDS } from "../collector/lib/schema.js";

const NOW = new Date("2026-09-04T10:00:00.000Z");
const KEY = "sk-or-v1-this-must-never-appear-in-reasons";
const SAIL_KEY = "sail-secret-this-must-never-appear";

function jsonRes(status, body) {
  return {
    status,
    json: async () => body,
  };
}

function fetchByPath(routes) {
  return async (url) => {
    const href = String(url);
    for (const [needle, res] of Object.entries(routes)) {
      if (href.includes(needle)) {
        return typeof res === "function" ? res(href) : res;
      }
    }
    return jsonRes(404, { error: { message: "missing fixture" } });
  };
}

describe("json-get envKey", () => {
  it("treats blank strings as missing", () => {
    assert.equal(envKey("X", {}), null);
    assert.equal(envKey("X", { X: "  " }), null);
    assert.equal(envKey("X", { X: " abc " }), "abc");
  });
});

describe("OpenRouter adapter", () => {
  it("stays unknown without a key and fabricates nothing", async () => {
    const r = await openrouter.collect({ now: NOW, env: {}, fetchImpl: async () => {
      throw new Error("network must not run without a key");
    } });
    assert.equal(r.status, "unknown");
    assert.equal(r.collectionMode, "unavailable");
    assert.equal(r.usage, null);
    assert.match(r.reason, /OPENROUTER_API_KEY/);
    assert.match(r.reason, /No usage fabricated/);
  });

  it("measures account credits and a key cap without leaking the key", async () => {
    const r = await openrouter.collect({
      now: NOW,
      env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MANAGEMENT_KEY: KEY },
      fetchImpl: fetchByPath({
        "/credits": jsonRes(200, { data: { total_credits: 100.5, total_usage: 25.75 } }),
        "/key": jsonRes(200, {
          data: {
            label: "prod-key-do-not-publish",
            limit: 50,
            limit_remaining: 12.5,
            limit_reset: "monthly",
            usage: 999,
            usage_monthly: 37.5,
            is_free_tier: false,
          },
        }),
        "/activity": jsonRes(200, {
          data: [
            { date: "2026-09-02", usage: 1.1, model: "openai/gpt-4.1", endpoint_id: "abc", provider_name: "OpenAI", requests: 2, prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0, byok_usage_inference: 0, model_permaslug: "x" },
            { date: "2026-09-02", usage: 0.4, model: "other", endpoint_id: "def", provider_name: "X", requests: 1, prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0, byok_usage_inference: 0, model_permaslug: "y" },
            { date: "2026-09-03", usage: 2.25, model: "openai/gpt-4.1", endpoint_id: "abc", provider_name: "OpenAI", requests: 3, prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0, byok_usage_inference: 0, model_permaslug: "x" },
          ],
        }),
      }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, 37.5);
    assert.equal(r.limit, 50);
    assert.equal(r.usageUrl, "https://openrouter.ai/workspaces/default");
    const credits = r.components.find((c) => c.id === "credits");
    const cap = r.components.find((c) => c.id === "key-limit");
    assert.equal(credits.usage, 25.75);
    assert.equal(credits.limit, 100.5);
    assert.equal(cap.usage, 37.5);
    assert.equal(cap.limit, 50);
    assert.deepEqual(
      r.history.map((h) => h.date),
      ["2026-09-02", "2026-09-03"],
    );
    assert.equal(r.history[0].usage, 1.5);
    assert.doesNotMatch(JSON.stringify(r), /sk-or-v1-this-must-never/);
    assert.doesNotMatch(JSON.stringify(r), /prod-key-do-not-publish/);
    assert.doesNotMatch(r.reason, /gpt-4/);
  });

  it("uses account credits when the key has no cap", async () => {
    const r = await openrouter.collect({
      now: NOW,
      env: { OPENROUTER_API_KEY: KEY },
      fetchImpl: fetchByPath({
        "/credits": jsonRes(200, { data: { total_credits: 20, total_usage: 5 } }),
        "/key": jsonRes(200, { data: { limit: null, limit_remaining: null, usage: 5 } }),
        "/activity": jsonRes(403, { error: { message: "Only management keys" } }),
      }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.usage, 5);
    assert.equal(r.limit, 20);
    assert.equal(r.components.length, 1);
    assert.equal(r.components[0].id, "credits");
  });

  it("stays unknown when /credits is forbidden and the key is uncapped", async () => {
    const r = await openrouter.collect({
      now: NOW,
      env: { OPENROUTER_API_KEY: KEY },
      fetchImpl: fetchByPath({
        "/credits": jsonRes(403, { error: { message: "Only management keys" } }),
        "/key": jsonRes(200, { data: { limit: null, usage: 12.3, usage_monthly: 4 } }),
      }),
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /management key/);
  });
});

describe("Sail Research adapter", () => {
  it("stays unknown without a key", async () => {
    const r = await sail.collect({ now: NOW, env: {} });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /SAIL_API_KEY/);
  });

  it("converts fractional cents to USD and builds a period pot", () => {
    assert.equal(sail.centsToUsd(73795.09), 737.95);
    const meter = sail.summaryMeter({
      period_spend: 105392.94,
      balance: 73795.09,
      product_spend: { inference: 87200.31, sailboxes: 18192.63 },
    });
    assert.equal(meter.spend, 1053.93);
    assert.equal(meter.balance, 737.95);
    assert.equal(meter.limit, 1791.88);
    assert.equal(meter.inference, 872);
    assert.equal(meter.sailboxes, 181.93);
  });

  it("measures the billing period without leaking the key", async () => {
    const r = await sail.collect({
      now: NOW,
      env: { SAIL_API_KEY: SAIL_KEY },
      fetchImpl: fetchByPath({
        "/v2/usage/summary": jsonRes(200, {
          period_spend: 1054,
          balance: 738,
          balance_unavailable: false,
          product_spend: { inference: 872, sailboxes: 182 },
        }),
        "/v2/usage/breakdown": jsonRes(200, {
          data: [
            { timestamp: "2026-09-02", total: 400, models: { "secret/model": { total: 400 } } },
            { timestamp: "2026-09-03", total: 654 },
          ],
        }),
      }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.usage, 10.54);
    assert.equal(r.limit, 17.92);
    assert.equal(r.usageUrl, "https://app.sailresearch.com/usage");
    const period = r.components.find((c) => c.id === "period");
    assert.equal(period.role, "capacity");
    assert.equal(period.limit, 17.92);
    assert.equal(r.history.length, 2);
    assert.equal(r.history[0].usage, 4);
    assert.doesNotMatch(JSON.stringify(r), /sail-secret/);
    assert.doesNotMatch(JSON.stringify(r), /secret\/model/);
  });

  it("treats HTTP 402 as an empty prepaid pot", async () => {
    const r = await sail.collect({
      now: NOW,
      env: { SAIL_API_KEY: SAIL_KEY },
      fetchImpl: fetchByPath({
        "/v2/usage/summary": jsonRes(402, {
          error: { type: "billing_error", code: "credits_exhausted", billing_url: "https://app.sailresearch.com" },
        }),
      }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.usage, 100);
    assert.equal(r.limit, 100);
    assert.match(r.reason, /credits_exhausted/);
    assert.doesNotMatch(JSON.stringify(r), /sail-secret/);
  });
});

describe("source registry", () => {
  it("includes OpenRouter and Sail in SOURCE_IDS", () => {
    assert.ok(SOURCE_IDS.includes("openrouter"));
    assert.ok(SOURCE_IDS.includes("sail"));
    assert.equal(SOURCE_IDS.length, 7);
  });
});
