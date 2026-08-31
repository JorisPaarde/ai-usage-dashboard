import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSnapshot,
  emptySource,
  assertHonestSource,
  assertPublishableSnapshot,
  validateLocalOverrides,
  ENRICH_MONTHLY_BUDGET,
  ENRICH_WEEKLY_PACE_MAX,
  SOURCE_IDS,
} from "../collector/lib/schema.js";
import {
  computePace,
  compactHistory,
  dailyCapFromWeekly,
  dayOfMonthInZone,
  daysInMonthInZone,
} from "../collector/lib/pace.js";
import {
  normalizeSource,
  collectSnapshot,
  applyOverride,
} from "../collector/index.js";
import {
  amsterdamClock,
  nearAmsterdamSlot,
  shouldRunCollect,
} from "../scripts/amsterdam-gate.js";
import * as enrich from "../collector/adapters/enrich-labs.js";
import * as openai from "../collector/adapters/openai-buzz.js";
import * as ollama from "../collector/adapters/ollama.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("schema", () => {
  it("requires all five sources and unknown reasons", () => {
    const snap = {
      version: "1.1.0",
      generatedAt: "2026-08-31T10:00:00.000Z",
      timezone: "Europe/Amsterdam",
      sources: SOURCE_IDS.map((id) =>
        emptySource({ id, status: "unknown", reason: "n/a" }),
      ),
    };
    assert.equal(validateSnapshot(snap).ok, true);
    assert.doesNotThrow(() => assertPublishableSnapshot(snap));
  });

  it("rejects unknown without reason", () => {
    const snap = {
      version: "1.1.0",
      generatedAt: "2026-08-31T10:00:00.000Z",
      timezone: "Europe/Amsterdam",
      sources: SOURCE_IDS.map((id) => ({
        ...emptySource({ id }),
        reason: "",
      })),
    };
    assert.equal(validateSnapshot(snap).ok, false);
  });

  it("forbids fabricated usage on unknown", () => {
    assert.throws(() =>
      assertHonestSource(
        emptySource({ id: "openai-buzz", status: "unknown", reason: "x", usage: 12 }),
      ),
    );
  });

  it("requires usage for estimated", () => {
    assert.throws(() =>
      assertHonestSource(
        emptySource({ id: "cursor-agent", status: "estimated", reason: "guess" }),
      ),
    );
  });
});

describe("pace", () => {
  it("computes daily and monthly pace", () => {
    const when = new Date("2026-08-31T12:00:00Z");
    const day = dayOfMonthInZone(when);
    const dim = daysInMonthInZone(when);
    assert.equal(day, 31);
    assert.equal(dim, 31);
    const pace = computePace(155, when);
    assert.equal(pace.daily, 5);
    assert.equal(pace.monthly, 155);
  });

  it("compacts history to last N days", () => {
    const hist = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      usage: i,
    }));
    assert.equal(compactHistory(hist, 14).length, 14);
  });

  it("maps weekly max to daily cap", () => {
    assert.equal(dailyCapFromWeekly(ENRICH_WEEKLY_PACE_MAX), 7.1);
  });
});

describe("adapters", () => {
  it("openai stays unknown without inventing usage", async () => {
    const r = await openai.collect();
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.ok(r.reason.length > 0);
  });

  it("enrich exposes public budget constants only", async () => {
    const r = await enrich.collect();
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.equal(r.limit, ENRICH_MONTHLY_BUDGET);
    assert.equal(r.budget.monthly, 200);
    assert.equal(r.budget.weeklyPaceMax, 50);
    assert.equal(r.pace.weeklyTarget, 50);
  });

  it("ollama reports unknown or measured without fake usage", async () => {
    const r = await ollama.collect(
      async () => {
        throw new Error("offline");
      },
      { readLog: async () => "" },
    );
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /unavailable|fabricated/i);

    const ok = await ollama.collect(
      async () => ({
        ok: true,
        async json() {
          return { models: [{ name: "x" }, { name: "y" }] };
        },
      }),
      {
        readLog: async () => {
          throw new Error("no log");
        },
      },
    );
    assert.equal(ok.status, "measured");
    assert.equal(ok.usage, null);
    assert.match(ok.reason, /2 model/);

    const withLog = await ollama.collect(
      async () => ({
        ok: true,
        async json() {
          return { models: [{ name: "x" }] };
        },
      }),
      {
        readLog: async () =>
          [
            "time=2026-08-31T10:00:00.000+02:00 level=INFO source=server.go msg=start",
            "slot print_timing: id  0 | task 0 | prompt eval time =    100.00 ms /    10 tokens (   10.00 ms per token,   100.00 tokens per second)",
            "slot print_timing: id  0 | task 0 |        eval time =    200.00 ms /    20 tokens (   10.00 ms per token,   100.00 tokens per second)",
            '[GIN] 2026/08/31 - 12:00:00 | 200 |         1.0s |       127.0.0.1 | POST     "/api/chat"',
          ].join("\n"),
      },
    );
    assert.equal(withLog.status, "measured");
    assert.equal(withLog.usage, 30);
  });
});

describe("collector", () => {
  it("builds a valid honest snapshot", async () => {
    const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
      overrides: [],
    });
    assert.equal(validateSnapshot(snap).ok, true);
    assert.equal(snap.version, "1.2.0");
    assert.equal(snap.sources.length, 5);
    for (const s of snap.sources) {
      assertHonestSource(s);
      if (s.status === "unknown") assert.equal(s.usage, null);
    }
    const enrichSrc = snap.sources.find((s) => s.id === "enrich-labs");
    assert.equal(enrichSrc.limit, 200);
    assert.equal(enrichSrc.pace.weeklyTarget, 50);
  });

  it("normalizeSource keeps enrich weekly target", () => {
    const src = normalizeSource({
      id: "enrich-labs",
      status: "unknown",
      reason: "test",
      usage: null,
    });
    assert.equal(src.budget.monthly, 200);
    assert.equal(src.pace.weeklyTarget, 50);
  });

  it("applies schema-validated local overrides into aggregate only", async () => {
    const check = validateLocalOverrides({
      sources: [
        {
          id: "cursor-agent",
          status: "estimated",
          usage: 42,
          reason: "manual UI read",
          lastUpdate: "2026-08-31T08:00:00.000Z",
        },
      ],
    });
    assert.equal(check.ok, true);

    const bad = validateLocalOverrides({
      sources: [{ id: "cursor-agent", status: "unknown", usage: 1 }],
    });
    assert.equal(bad.ok, false);

    const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
      overrides: [
        {
          id: "cursor-agent",
          status: "estimated",
          usage: 42,
          limit: 100,
          reason: "manual UI read",
          lastUpdate: "2026-08-31T08:00:00.000Z",
        },
      ],
    });
    const cursor = snap.sources.find((s) => s.id === "cursor-agent");
    assert.equal(cursor.status, "estimated");
    assert.equal(cursor.usage, 42);
    assert.equal(cursor.limit, 100);
    assert.match(cursor.reason, /manual UI read/);
    assert.ok(cursor.pace.daily != null);
  });

  it("accepts Cursor component rows and https usageUrl", async () => {
    const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
      overrides: [
        {
          id: "cursor-agent",
          status: "measured",
          usage: null,
          limit: null,
          reason: "component split test",
          lastUpdate: "2026-08-31T08:00:00.000Z",
          usageUrl: "https://cursor.com/dashboard?tab=usage",
          components: [
            {
              id: "grok-bot",
              label: "Grok Bot (weekly)",
              usage: 100,
              limit: 100,
              unit: "%",
            },
            {
              id: "included",
              label: "Included Cursor plan",
              usage: 37.2,
              limit: 100,
              unit: "%",
            },
            {
              id: "on-demand",
              label: "On-demand spend",
              usage: 73.6,
              limit: 75,
              unit: "USD",
            },
          ],
        },
      ],
    });
    const cursor = snap.sources.find((s) => s.id === "cursor-agent");
    assert.equal(cursor.components.length, 3);
    assert.equal(cursor.usageUrl, "https://cursor.com/dashboard?tab=usage");
    assert.equal(cursor.components[0].usage, 100);
    assert.equal(cursor.components[1].usage, 37.2);
    assert.equal(cursor.components[2].limit, 75);
  });

  it("rejects http usageUrl and malformed components", () => {
    assert.equal(
      validateLocalOverrides({
        sources: [
          {
            id: "openai-buzz",
            status: "measured",
            usage: 1,
            lastUpdate: "2026-08-31T08:00:00.000Z",
            usageUrl: "http://example.com",
          },
        ],
      }).ok,
      false,
    );
    assert.equal(
      validateSnapshot({
        version: "1.2.0",
        generatedAt: "2026-08-31T10:00:00.000Z",
        timezone: "Europe/Amsterdam",
        sources: SOURCE_IDS.map((id) =>
          emptySource({
            id,
            status: "unknown",
            reason: "n/a",
            components:
              id === "cursor-agent"
                ? [{ id: "x", label: "X", usage: "bad", limit: 1 }]
                : null,
          }),
        ),
      }).ok,
      false,
    );
  });

  it("applyOverride preserves honesty", () => {
    const base = normalizeSource({
      id: "openai-buzz",
      status: "unknown",
      reason: "no data",
      usage: null,
    });
    const merged = applyOverride(base, {
      id: "openai-buzz",
      status: "measured",
      usage: 10,
      lastUpdate: "2026-08-31T09:00:00.000Z",
      reason: "local export",
    });
    assert.equal(merged.usage, 10);
    assert.equal(merged.status, "measured");
  });
});

describe("amsterdam gate", () => {
  // CEST: 2026-08-31 07:00 UTC = 09:00 Amsterdam
  const cestMorning = new Date("2026-08-31T07:00:00Z");
  // CEST afternoon: 14:00 UTC = 16:00 Amsterdam
  const cestAfternoon = new Date("2026-08-31T14:00:00Z");
  // CET: 2026-01-15 08:00 UTC = 09:00 Amsterdam
  const cetMorning = new Date("2026-01-15T08:00:00Z");
  // CET afternoon: 15:00 UTC = 16:00 Amsterdam
  const cetAfternoon = new Date("2026-01-15T15:00:00Z");
  // Out of window: CEST 10:00 UTC = 12:00 Amsterdam
  const outOfWindow = new Date("2026-08-31T10:00:00Z");

  it("accepts CEST morning and afternoon UTC candidates", () => {
    assert.equal(amsterdamClock(cestMorning).label, "09:00");
    assert.equal(nearAmsterdamSlot(cestMorning), true);
    assert.equal(shouldRunCollect("schedule", cestMorning), true);
    assert.equal(amsterdamClock(cestAfternoon).label, "16:00");
    assert.equal(shouldRunCollect("schedule", cestAfternoon), true);
  });

  it("accepts CET morning and afternoon UTC candidates", () => {
    assert.equal(amsterdamClock(cetMorning).label, "09:00");
    assert.equal(shouldRunCollect("schedule", cetMorning), true);
    assert.equal(amsterdamClock(cetAfternoon).label, "16:00");
    assert.equal(shouldRunCollect("schedule", cetAfternoon), true);
  });

  it("rejects scheduled runs outside the Amsterdam windows", () => {
    assert.equal(amsterdamClock(outOfWindow).label, "12:00");
    assert.equal(nearAmsterdamSlot(outOfWindow), false);
    assert.equal(shouldRunCollect("schedule", outOfWindow), false);
  });

  it("allows workflow_dispatch even outside the window", () => {
    assert.equal(shouldRunCollect("workflow_dispatch", outOfWindow), true);
  });
});

describe("public seed", () => {
  it("latest.json is valid and secret-free", async () => {
    const raw = await readFile(path.join(ROOT, "data", "latest.json"), "utf8");
    assert.doesNotMatch(raw, /sk-[a-zA-Z0-9]{10,}/);
    assert.doesNotMatch(raw, /@[\w.-]+\.(com|nl|ai)/i);
    assert.doesNotMatch(raw, /Bearer\s/i);
    assert.doesNotMatch(raw, /password|api[_-]?key\s*[:=]/i);
    const snap = JSON.parse(raw);
    assert.equal(validateSnapshot(snap).ok, true);
    assert.doesNotThrow(() => assertPublishableSnapshot(snap));
    for (const s of snap.sources) {
      if (s.status === "unknown") assert.equal(s.usage, null);
    }
    const cursor = snap.sources.find((s) => s.id === "cursor-agent");
    assert.ok(Array.isArray(cursor.components));
    assert.equal(cursor.components.length, 3);
    assert.equal(cursor.usage, null);
    assert.match(cursor.usageUrl, /^https:\/\/cursor\.com\//);
    assert.match(
      await readFile(path.join(ROOT, "site", "app.js"), "utf8"),
      /source-link/,
    );
  });

  it("site marks measured estimated and unavailable distinctly", async () => {
    const html = await readFile(path.join(ROOT, "site", "index.html"), "utf8");
    const css = await readFile(path.join(ROOT, "site", "styles.css"), "utf8");
    const js = await readFile(path.join(ROOT, "site", "app.js"), "utf8");
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/i);
    assert.match(html, /measured/);
    assert.match(html, /estimated/);
    assert.match(html, /unavailable/);
    assert.match(css, /badge-measured/);
    assert.match(css, /badge-estimated/);
    assert.match(css, /badge-unknown/);
    assert.match(js, /STATUS_LABEL/);
    assert.match(js, /unavailable/);
  });
});
