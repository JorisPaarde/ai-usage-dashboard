import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSnapshot,
  emptySource,
  assertHonestSource,
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
import { normalizeSource, collectSnapshot } from "../collector/index.js";
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
      version: "1.0.0",
      generatedAt: "2026-08-31T10:00:00.000Z",
      timezone: "Europe/Amsterdam",
      sources: SOURCE_IDS.map((id) =>
        emptySource({ id, status: "unknown", reason: "n/a" }),
      ),
    };
    assert.equal(validateSnapshot(snap).ok, true);
  });

  it("rejects unknown without reason", () => {
    const snap = {
      version: "1.0.0",
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
    const r = await ollama.collect(async () => {
      throw new Error("offline");
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /unavailable|fabricated/i);

    const ok = await ollama.collect(async () => ({
      ok: true,
      async json() {
        return { models: [{ name: "x" }, { name: "y" }] };
      },
    }));
    assert.equal(ok.status, "measured");
    assert.equal(ok.usage, null);
    assert.match(ok.reason, /2 model/);
  });
});

describe("collector", () => {
  it("builds a valid honest snapshot", async () => {
    const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"));
    assert.equal(validateSnapshot(snap).ok, true);
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
});

describe("public seed", () => {
  it("latest.json is valid and secret-free", async () => {
    const raw = await readFile(path.join(ROOT, "data", "latest.json"), "utf8");
    assert.doesNotMatch(raw, /sk-[a-zA-Z0-9]{10,}/);
    assert.doesNotMatch(raw, /@[\w.-]+\.(com|nl|ai)/i);
    assert.doesNotMatch(raw, /Bearer\s/i);
    const snap = JSON.parse(raw);
    assert.equal(validateSnapshot(snap).ok, true);
    for (const s of snap.sources) {
      if (s.status === "unknown") assert.equal(s.usage, null);
    }
  });
});
