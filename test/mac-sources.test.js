import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cursorAgent from "../collector/adapters/cursor-agent.js";
import * as grokBot from "../collector/adapters/grok-bot.js";
import {
  mergeMacSources,
  missingMacSource,
  macSourceAgeHours,
  validateMacSourcesPayload,
  MAC_STALE_HOURS,
  normalizeSource,
} from "../collector/index.js";
import {
  BOX_SOURCE_IDS,
  MAC_SOURCE_IDS,
  SOURCE_IDS,
  emptySource,
  assertPublishableSnapshot,
} from "../collector/lib/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURSOR_PERIOD_FIXTURE = path.join(
  ROOT,
  "test",
  "fixtures",
  "cursor-get-current-period-usage.json",
);
const CURSOR_GROK_FIXTURE = path.join(
  ROOT,
  "test",
  "fixtures",
  "cursor-get-sand-usage-status.json",
);

describe("source registry split", () => {
  it("separates box and Mac source ids", () => {
    assert.deepEqual(BOX_SOURCE_IDS, [
      "openai-buzz",
      "claude-code",
      "openrouter",
      "sail",
    ]);
    assert.deepEqual(MAC_SOURCE_IDS, ["cursor-agent", "grok-bot"]);
    assert.ok(SOURCE_IDS.includes("cursor-agent"));
    assert.ok(SOURCE_IDS.includes("grok-bot"));
    assert.equal(SOURCE_IDS.length, 6);
  });
});

describe("Grok Bot GetSandUsageStatus mapping", () => {
  it("maps fixture usagePercent to an Included capacity bar with reset", async () => {
    const grok = JSON.parse(await readFile(CURSOR_GROK_FIXTURE, "utf8"));
    const parsed = grokBot.parseGrokBotUsage(grok);
    assert.ok(parsed);
    assert.equal(parsed.components.length, 1);
    assert.equal(parsed.components[0].id, "included");
    assert.equal(parsed.components[0].role, "capacity");
    assert.equal(parsed.components[0].usage, 100);
    assert.equal(parsed.components[0].limit, 100);
    assert.equal(parsed.resetDate, "2026-08-31T18:29:14.000Z");
    assert.ok(parsed.missing.includes("On-demand"));
  });

  it("maps defensive included + on-demand fields when present", () => {
    const parsed = grokBot.parseGrokBotUsage({
      hasNonZeroIncludedLimit: true,
      includedPercentUsed: 40,
      onDemandPercentUsed: 12,
      nextResetAt: "2026-09-07T18:29:14.000Z",
    });
    assert.ok(parsed);
    assert.equal(parsed.components.length, 2);
    assert.equal(parsed.components[0].id, "included");
    assert.equal(parsed.components[0].usage, 40);
    assert.equal(parsed.components[0].role, "capacity");
    assert.equal(parsed.components[1].id, "on-demand");
    assert.equal(parsed.components[1].usage, 12);
    assert.equal(parsed.components[1].role, "capacity");
    assert.equal(parsed.resetDate, "2026-09-07T18:29:14.000Z");
  });

  it("maps on-demand used/limit (cents) defensively", () => {
    const parsed = grokBot.parseGrokBotUsage({
      usagePercent: 8,
      hasNonZeroIncludedLimit: true,
      onDemandUsed: 250,
      onDemandLimit: 1000,
      nextResetTimestampUtc: "2026-08-31T18:29:14.000Z",
    });
    assert.ok(parsed);
    const onDemand = parsed.components.find((c) => c.id === "on-demand");
    assert.equal(onDemand.usage, 2.5);
    assert.equal(onDemand.limit, 10);
    assert.equal(onDemand.unit, "USD");
    assert.equal(onDemand.role, "capacity");
  });

  it("returns null when account is ineligible or fields absent", () => {
    assert.equal(
      grokBot.parseGrokBotUsage({
        usagePercent: 0,
        hasNonZeroIncludedLimit: false,
      }),
      null,
    );
    assert.equal(
      grokBot.parseGrokBotUsage({
        usagePercent: 50,
        usesPooledEnterpriseAllowance: true,
      }),
      null,
    );
    assert.equal(
      grokBot.parseGrokBotUsage({ includedLimitZero: true, usagePercent: 10 }),
      null,
    );
    assert.equal(grokBot.parseGrokBotUsage({}), null);
    assert.equal(grokBot.parseGrokBotUsage(null), null);
  });

  it("collect measures from fixtures without leaking a token", async () => {
    const grok = JSON.parse(await readFile(CURSOR_GROK_FIXTURE, "utf8"));
    const sentinel = "test-access-token-MUST-NOT-LEAK";
    const r = await grokBot.collect({
      now: new Date("2026-09-02T08:00:00.000Z"),
      readToken: async () => sentinel,
      fetchGrok: async () => ({ ok: true, json: grok }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.id, "grok-bot");
    assert.equal(r.components[0].id, "included");
    assert.match(r.reason, /GetSandUsageStatus/);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(r), /Bearer\s/i);
  });

  it("collect fails closed without a token", async () => {
    const r = await grokBot.collect({
      readToken: async () => null,
      fetchGrok: async () => {
        throw new Error("must not call API without a token");
      },
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /no signed-in access token/i);
  });
});

describe("Cursor Agent period usage (Mac source)", () => {
  it("parses GetCurrentPeriodUsage fixture without embedding Grok", async () => {
    const period = JSON.parse(await readFile(CURSOR_PERIOD_FIXTURE, "utf8"));
    const parsed = cursorAgent.parsePeriodUsage(period);
    assert.ok(parsed);
    assert.equal(parsed.components.length, 3);
    assert.equal(parsed.components[0].id, "included-cursor-models");
    assert.equal(parsed.components[0].role, "capacity");
    assert.equal(parsed.components[2].id, "on-demand");
    assert.ok(!parsed.components.some((c) => c.id === "grok-bot"));
  });

  it("collect measures without calling GetSandUsageStatus", async () => {
    const period = JSON.parse(await readFile(CURSOR_PERIOD_FIXTURE, "utf8"));
    const sentinel = "cursor-token-MUST-NOT-LEAK";
    const r = await cursorAgent.collect({
      now: new Date("2026-09-02T08:00:00.000Z"),
      readToken: async () => sentinel,
      fetchPeriod: async () => ({ ok: true, json: period }),
      fetchHard: async () => ({ ok: false }),
      fetchSummary: async () => ({ ok: false }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.components.length, 3);
    assert.ok(!r.components.some((c) => c.id === "included" || c.id === "grok-bot"));
    assert.match(r.reason, /GetCurrentPeriodUsage/);
    assert.doesNotMatch(r.reason, /GetSandUsageStatus/);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(sentinel));
  });
});

describe("mac-sources merge + staleness", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");

  function boxStubSources() {
    return BOX_SOURCE_IDS.map((id) =>
      normalizeSource(
        emptySource({
          id,
          status: "unknown",
          reason: "box stub",
        }),
      ),
    );
  }

  it("inserts unknowns when mac-sources is missing", () => {
    const merged = mergeMacSources(boxStubSources(), null, now);
    assert.equal(merged.length, SOURCE_IDS.length);
    const cursor = merged.find((s) => s.id === "cursor-agent");
    const grok = merged.find((s) => s.id === "grok-bot");
    assert.equal(cursor.status, "unknown");
    assert.equal(grok.status, "unknown");
    assert.match(cursor.reason, /mac-snapshot/);
  });

  it("keeps Mac measuredAt and marks stale after MAC_STALE_HOURS", () => {
    assert.equal(MAC_STALE_HOURS, 2);
    const measuredAt = "2026-09-02T09:00:00.000Z"; // 3h old
    const payload = {
      measuredAt,
      sources: [
        {
          id: "cursor-agent",
          status: "measured",
          collectionMode: "automatic",
          reason: "Live Cursor.",
          usage: null,
          lastUpdate: measuredAt,
          components: [
            {
              id: "included-cursor-models",
              label: "Included Cursor Models",
              role: "capacity",
              usage: 14,
              limit: 100,
              unit: "%",
            },
          ],
        },
        {
          id: "grok-bot",
          status: "measured",
          collectionMode: "automatic",
          reason: "Live Grok.",
          usage: null,
          lastUpdate: measuredAt,
          components: [
            {
              id: "included",
              label: "Included",
              role: "capacity",
              usage: 8,
              limit: 100,
              unit: "%",
            },
          ],
        },
      ],
    };
    assert.equal(validateMacSourcesPayload(payload).ok, true);
    assert.equal(macSourceAgeHours(measuredAt, now), 3);

    const merged = mergeMacSources(boxStubSources(), payload, now);
    const cursor = merged.find((s) => s.id === "cursor-agent");
    assert.equal(cursor.status, "measured");
    assert.equal(cursor.stale, true);
    assert.equal(cursor.measuredAt, measuredAt);
    assert.equal(cursor.lastUpdate, measuredAt);
    assert.match(cursor.reason, /STALE/);
    assert.match(cursor.reason, /3 hour/);
    // Not deleted — still present with meters.
    assert.equal(cursor.components[0].usage, 14);

    const snap = {
      version: "1.9.0",
      generatedAt: now.toISOString(),
      timezone: "Europe/Amsterdam",
      sources: merged,
    };
    assert.doesNotThrow(() => assertPublishableSnapshot(snap));
  });

  it("does not mark fresh Mac sources stale", () => {
    const measuredAt = "2026-09-02T11:30:00.000Z"; // 30 min old
    const payload = {
      measuredAt,
      sources: [
        {
          id: "cursor-agent",
          status: "measured",
          collectionMode: "automatic",
          reason: "Live Cursor.",
          usage: null,
          lastUpdate: measuredAt,
          components: [
            {
              id: "included-cursor-models",
              label: "Included",
              role: "capacity",
              usage: 10,
              limit: 100,
            },
          ],
        },
        {
          id: "grok-bot",
          status: "unknown",
          collectionMode: "unavailable",
          reason: "No personal meter.",
          usage: null,
          lastUpdate: measuredAt,
        },
      ],
    };
    const merged = mergeMacSources(boxStubSources(), payload, now);
    const cursor = merged.find((s) => s.id === "cursor-agent");
    assert.equal(cursor.stale, undefined);
    assert.doesNotMatch(cursor.reason, /STALE/);
    assert.equal(cursor.measuredAt, measuredAt);
  });

  it("missingMacSource is honest unknown", () => {
    const src = missingMacSource("grok-bot");
    assert.equal(src.id, "grok-bot");
    assert.equal(src.status, "unknown");
    assert.equal(src.usage, null);
    assert.match(src.reason, /mac-snapshot/);
  });
});
