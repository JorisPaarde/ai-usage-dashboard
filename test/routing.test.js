import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  POOLS,
  poolFromSource,
  poolsFromSnapshot,
  verdictForPool,
  verdictsFor,
  ageMinutes,
  CLAUDE_MAX_AGE_MINUTES,
  OK_BELOW_PERCENT,
  FULL_AT_PERCENT,
} from "../collector/lib/routing.js";
import {
  validateTask,
  candidatesFor,
  pickPool,
  LANES,
  TASK_TYPES,
} from "../collector/lib/lanes.js";
import { planRoute, QUOTA_RE } from "../scripts/route.js";

const NOW = new Date("2026-09-04T09:00:00.000Z");
const FRESH = "2026-09-04T08:55:00.000Z"; // 5 min old
const OLD = "2026-09-04T06:00:00.000Z"; // 3 h old

function cursorSource(overrides = {}) {
  return {
    id: "cursor-agent",
    status: "measured",
    collectionMode: "automatic",
    lastUpdate: FRESH,
    usage: null,
    limit: null,
    components: [
      { id: "included-cursor-models", usage: 28.8, limit: 100, role: "capacity" },
      { id: "other-models", usage: 35.2, limit: 100, role: "capacity" },
      { id: "on-demand", usage: 73.6, limit: 75, role: "capped" },
      { id: "grok-bot", usage: 94.9, limit: 100, role: "capped" },
    ],
    ...overrides,
  };
}

function claudeSource(session, weekly, overrides = {}) {
  return {
    id: "claude-code",
    status: "measured",
    collectionMode: "automatic",
    lastUpdate: FRESH,
    usage: 13609994,
    limit: null,
    components: [
      { id: "session", usage: session, limit: 100 },
      { id: "usage-credits", usage: 0, limit: 50 },
      { id: "weekly-all-models", usage: weekly, limit: 100 },
    ],
    ...overrides,
  };
}

describe("capacity facts", () => {
  it("reads Cursor capacity from capacity meters, not capped ones", () => {
    const fact = poolFromSource("cursor", POOLS.cursor, cursorSource());
    // on-demand sits at 98.1% of its cap; that must not read as "Cursor is full".
    assert.equal(fact.percent, 35.2);
    assert.deepEqual(
      fact.capped.map((c) => c.id).sort(),
      ["grok-bot", "on-demand"],
    );
    assert.equal(verdictForPool(fact, NOW).verdict, "ok");
  });

  it("takes the highest of Claude's session and weekly meters", () => {
    const fact = poolFromSource("claude", POOLS.claude, claudeSource(82, 8));
    assert.equal(fact.percent, 82);
    assert.equal(fact.maxAgeMinutes, 60);
    // usage-credits is a spend meter, not a rate limit; it must not drive the verdict.
    assert.equal(verdictForPool(fact, NOW).verdict, "low");
  });

  it("refuses a percentage when there is consumption but no limit", () => {
    const fact = poolFromSource("openai", POOLS.openai, {
      id: "openai-buzz",
      status: "measured",
      collectionMode: "automatic",
      lastUpdate: FRESH,
      usage: 13609994,
      limit: null,
    });
    assert.equal(fact.percent, null);
    assert.equal(fact.measuredAt, null);
    assert.equal(fact.collectionMode, "unavailable");
    assert.equal(verdictForPool(fact, NOW).verdict, "unknown");
  });

  it("derives nothing from an unmeasured source", () => {
    const fact = poolFromSource("openai", POOLS.openai, {
      id: "openai-buzz",
      status: "unknown",
      collectionMode: "unavailable",
      reason: "codex app-server unreachable",
      lastUpdate: null,
    });
    assert.equal(fact.percent, null);
    assert.match(fact.reason, /unreachable/);
  });

  it("builds every pool, including prepaid last-resort when unmetered", () => {
    const facts = poolsFromSnapshot({
      generatedAt: NOW.toISOString(),
      sources: [cursorSource()],
    });
    assert.deepEqual(
      Object.keys(facts.pools).sort(),
      ["claude", "cursor", "local", "openai", "openrouter", "sail"],
    );
    assert.equal(facts.pools.sail.paid, true);
    assert.equal(facts.pools.sail.percent, null);
    assert.equal(facts.pools.openrouter.paid, true);
    assert.equal(facts.pools.sail.sourceId, "sail");
    assert.equal(facts.pools.openrouter.sourceId, "openrouter");
  });

  it("meters OpenRouter from credits/key-limit and drops paid last-resort", () => {
    const fact = poolFromSource("openrouter", POOLS.openrouter, {
      id: "openrouter",
      status: "measured",
      collectionMode: "automatic",
      lastUpdate: FRESH,
      usage: 25.75,
      limit: 100.5,
      components: [
        { id: "credits", usage: 25.75, limit: 100.5, role: "capacity" },
        { id: "key-limit", usage: 42, limit: 50, role: "capped" },
      ],
    });
    assert.equal(fact.percent, 84);
    assert.equal(fact.paid, undefined);
    assert.equal(verdictForPool(fact, NOW).verdict, "low");
  });

  it("meters Sail from the billing-period component", () => {
    const fact = poolFromSource("sail", POOLS.sail, {
      id: "sail",
      status: "measured",
      collectionMode: "automatic",
      lastUpdate: FRESH,
      usage: 10.54,
      limit: 17.92,
      components: [
        { id: "period", usage: 10.54, limit: 17.92, role: "capacity" },
      ],
    });
    assert.equal(fact.percent, 58.8);
    assert.equal(fact.paid, undefined);
    assert.equal(verdictForPool(fact, NOW).verdict, "ok");
  });

  it("stores no verdict in the fact file", () => {
    const facts = poolsFromSnapshot({ generatedAt: NOW.toISOString(), sources: [] });
    for (const fact of Object.values(facts.pools)) {
      assert.equal("verdict" in fact, false);
    }
  });
});

describe("verdicts", () => {
  it("maps percentage onto ok / low / full at the documented thresholds", () => {
    const at = (percent) =>
      verdictForPool(
        {
          pool: "claude",
          percent,
          measuredAt: FRESH,
          maxAgeMinutes: 15,
          collectionMode: "automatic",
        },
        NOW,
      ).verdict;
    assert.equal(at(0), "ok");
    assert.equal(at(OK_BELOW_PERCENT - 0.1), "ok");
    assert.equal(at(OK_BELOW_PERCENT), "low");
    assert.equal(at(FULL_AT_PERCENT - 0.1), "low");
    assert.equal(at(FULL_AT_PERCENT), "full");
    assert.equal(at(100), "full");
  });

  it("degrades a stale measurement to low, never to ok", () => {
    const v = verdictForPool(
      {
        pool: "claude",
        percent: 4,
        measuredAt: OLD,
        maxAgeMinutes: 15,
        collectionMode: "automatic",
      },
      NOW,
    );
    assert.equal(v.verdict, "low");
    assert.match(v.reason, /past its 15 min limit/);
  });

  it("keeps a cached Claude reading usable for the configured hour", () => {
    const v = verdictForPool(
      {
        pool: "claude",
        percent: 14,
        measuredAt: "2026-09-04T08:15:00.000Z",
        maxAgeMinutes: CLAUDE_MAX_AGE_MINUTES,
        collectionMode: "automatic",
      },
      NOW,
    );
    assert.equal(v.verdict, "ok");
    assert.equal(v.age, 45);
  });

  it("keeps a stale full reading full", () => {
    const v = verdictForPool(
      { pool: "claude", percent: 99, measuredAt: OLD, maxAgeMinutes: 15 },
      NOW,
    );
    assert.equal(v.verdict, "full");
  });

  it("treats a missing timestamp as stale", () => {
    const v = verdictForPool(
      { pool: "claude", percent: 4, measuredAt: null, maxAgeMinutes: 15 },
      NOW,
    );
    assert.equal(v.verdict, "low");
    assert.equal(ageMinutes(null, NOW), null);
  });

  it("lets an observed quota error outrank a fresh, roomy measurement", () => {
    const fact = {
      pool: "claude",
      percent: 3,
      measuredAt: FRESH,
      maxAgeMinutes: 15,
      collectionMode: "automatic",
    };
    assert.equal(verdictForPool(fact, NOW).verdict, "ok");
    const blocked = verdictForPool(fact, NOW, {
      claude: { until: "2026-09-04T10:00:00.000Z", reason: "429 from provider" },
    });
    assert.equal(blocked.verdict, "full");
    assert.match(blocked.reason, /429/);
  });

  it("releases a block once it has expired", () => {
    const fact = {
      pool: "claude",
      percent: 3,
      measuredAt: FRESH,
      maxAgeMinutes: 15,
      collectionMode: "automatic",
    };
    const v = verdictForPool(fact, NOW, {
      claude: { until: "2026-09-04T08:00:00.000Z", reason: "earlier 429" },
    });
    assert.equal(v.verdict, "ok");
  });

  it("only calls the local runtime ok when this run proved it up", () => {
    const up = {
      pool: "local",
      unmetered: true,
      measuredAt: FRESH,
      maxAgeMinutes: 60,
      collectionMode: "automatic",
    };
    assert.equal(verdictForPool(up, NOW).verdict, "ok");
    assert.equal(
      verdictForPool({ ...up, collectionMode: "manual" }, NOW).verdict,
      "low",
    );
    assert.equal(verdictForPool({ ...up, measuredAt: OLD }, NOW).verdict, "low");
  });
});

describe("lane choice", () => {
  const facts = {
    pools: {
      cursor: { pool: "cursor", agent: "Cursor Builder" },
      claude: { pool: "claude", agent: "Claude-agent" },
      openai: { pool: "openai", agent: "Codex-agent" },
      local: { pool: "local", agent: "LocalAI guy" },
      sail: { pool: "sail", agent: "sail-worker" },
      openrouter: { pool: "openrouter", agent: "or-worker" },
    },
  };
  const V = (over = {}) => ({
    cursor: { verdict: "ok" },
    claude: { verdict: "ok" },
    openai: { verdict: "ok" },
    local: { verdict: "ok" },
    sail: { verdict: "paid" },
    openrouter: { verdict: "paid" },
    ...over,
  });

  it("sends code work to Cursor while it has room", () => {
    const p = pickPool({ type: "code", quality: "normal" }, V(), facts.pools);
    assert.equal(p.pool, "cursor");
    assert.equal(p.agent, "Cursor Builder");
  });

  it("steps to the next lane when the first is full", () => {
    const p = pickPool(
      { type: "code", quality: "normal" },
      V({ cursor: { verdict: "full" } }),
      facts.pools,
    );
    assert.equal(p.pool, "openai");
  });

  it("prefers a metered low pool over a paid one", () => {
    const p = pickPool(
      { type: "review", quality: "max" },
      V({ claude: { verdict: "low" }, openai: { verdict: "low" } }),
      facts.pools,
    );
    assert.equal(p.pool, "claude");
  });

  it("falls through to a paid pool only when everything metered is full", () => {
    const p = pickPool(
      { type: "review", quality: "max" },
      V({ claude: { verdict: "full" }, openai: { verdict: "full" } }),
      facts.pools,
    );
    assert.equal(p.pool, "openrouter");
    assert.match(p.reason, /last resort/);
  });

  it("never sends max-quality work to the local runtime", () => {
    assert.equal(candidatesFor({ type: "digest", quality: "cheap" })[0], "local");
    assert.equal(
      candidatesFor({ type: "digest", quality: "max" }).includes("local"),
      false,
    );
  });

  it("keeps Sail out of anything that is not bulk or cheap", () => {
    assert.deepEqual(LANES.bulk, ["sail", "openrouter"]);
    assert.equal(
      candidatesFor({ type: "bulk", quality: "max" }).includes("sail"),
      false,
    );
  });

  it("dispatches nothing when every candidate is full", () => {
    const p = pickPool(
      { type: "code", quality: "normal" },
      V({ cursor: { verdict: "full" }, openai: { verdict: "full" }, openrouter: { verdict: "full" } }),
      facts.pools,
    );
    assert.equal(p.pool, null);
    assert.match(p.reason, /Nothing dispatched/);
  });

  it("is reproducible: same task and same verdicts give the same lane", () => {
    const task = { type: "code", quality: "normal" };
    const verdicts = V({ cursor: { verdict: "low" } });
    const runs = new Set();
    for (let i = 0; i < 25; i += 1) {
      runs.add(pickPool(task, verdicts, facts.pools).pool);
    }
    assert.equal(runs.size, 1);
  });

  it("covers every task type with at least one lane", () => {
    for (const type of TASK_TYPES) {
      assert.ok(LANES[type].length > 0, `${type} has no lane`);
    }
  });
});

describe("task contract", () => {
  const good = {
    id: "T-1",
    type: "code",
    quality: "normal",
    prompt: "Fix the failing month-boundary fixture.",
  };

  it("accepts a complete task", () => {
    assert.equal(validateTask(good).ok, true);
  });

  it("fails closed on an unknown type or quality", () => {
    assert.equal(validateTask({ ...good, type: "vibes" }).ok, false);
    assert.equal(validateTask({ ...good, quality: "best" }).ok, false);
  });

  it("refuses a task with no prompt or id", () => {
    assert.equal(validateTask({ ...good, prompt: "  " }).ok, false);
    assert.equal(validateTask({ ...good, id: "" }).ok, false);
  });

  it("refuses to plan an invalid task rather than defaulting a lane", () => {
    const facts = poolsFromSnapshot({ generatedAt: NOW.toISOString(), sources: [] });
    assert.throws(
      () => planRoute({ ...good, type: "vibes" }, facts, NOW),
      /Unroutable task/,
    );
  });
});

describe("plan", () => {
  it("names the chosen pool, the reason and the remaining fallback order", () => {
    const facts = poolsFromSnapshot({
      generatedAt: NOW.toISOString(),
      sources: [cursorSource()],
    });
    const plan = planRoute(
      { id: "T-2", type: "code", quality: "normal", prompt: "Run the tests." },
      facts,
      NOW,
    );
    assert.equal(plan.pool, "cursor");
    assert.equal(plan.agent, "Cursor Builder");
    assert.deepEqual(plan.fallbackOrder, ["openai", "openrouter"]);
    assert.ok(plan.reason.length > 0);
    assert.equal(plan.considered.length, 3);
  });

  it("routes around a pool the provider just refused", () => {
    const facts = poolsFromSnapshot({
      generatedAt: NOW.toISOString(),
      sources: [cursorSource()],
    });
    const plan = planRoute(
      { id: "T-3", type: "code", quality: "normal", prompt: "Run the tests." },
      facts,
      NOW,
      { cursor: { until: "2026-09-04T10:00:00.000Z", reason: "429" } },
    );
    assert.notEqual(plan.pool, "cursor");
  });
});

describe("quota detection", () => {
  it("recognises how providers say no", () => {
    for (const text of [
      "HTTP 429 Too Many Requests",
      "rate limit exceeded",
      "You have hit your usage limit for this session",
      "quota exhausted",
      "insufficient credit balance",
    ]) {
      assert.ok(QUOTA_RE.test(text), text);
    }
  });

  it("does not mistake an ordinary failure for a quota error", () => {
    for (const text of [
      "ENOENT: no such file or directory",
      "agent exited with status 1",
      "connection refused",
    ]) {
      assert.equal(QUOTA_RE.test(text), false, text);
    }
  });
});

describe("provenance: a hand-typed meter is not a measurement", () => {
  // Reproduces the live 2026-09-04 state: the Claude OAuth token was rejected,
  // so the adapter published transcript tokens (a real measurement) while the
  // plan percentages came from a 26-hour-old manual fill. The source therefore
  // reads status "measured", collectionMode "automatic", and lastUpdate = this
  // collect — while its session % is a day old and was, in reality, 82%.
  const FILLED_AT = "2026-09-03T07:00:00.000Z"; // 26 h before NOW
  const source = {
    id: "claude-code",
    status: "measured",
    collectionMode: "automatic",
    lastUpdate: "2026-09-04T08:59:00.000Z", // one minute old
    usage: 13778301,
    limit: null,
    components: [
      { id: "session", usage: 0, limit: 100, filledFrom: "manual", filledAt: FILLED_AT },
      { id: "weekly-all-models", usage: 8, limit: 100, filledFrom: "manual", filledAt: FILLED_AT },
      { id: "usage-credits", usage: 0, limit: 50, filledFrom: "manual", filledAt: FILLED_AT },
    ],
  };

  it("ages the pool from the fill, not from the collect", () => {
    const fact = poolFromSource("claude", POOLS.claude, source);
    assert.equal(fact.measuredAt, FILLED_AT);
    assert.equal(fact.collectionMode, "manual");
    assert.deepEqual(fact.filledFrom, ["session", "weekly-all-models"]);
  });

  it("refuses to call it ok, however fresh the snapshot is", () => {
    const fact = poolFromSource("claude", POOLS.claude, source);
    const v = verdictForPool(fact, NOW);
    assert.equal(v.verdict, "low");
    assert.match(v.reason, /past its 60 min limit/);
  });

  it("keeps a genuinely measured pool automatic", () => {
    const fact = poolFromSource("cursor", POOLS.cursor, cursorSource());
    assert.equal(fact.collectionMode, "automatic");
    assert.equal(fact.measuredAt, FRESH);
    assert.equal("filledFrom" in fact, false);
  });

  it("treats a fill with no timestamp as stale rather than fresh", () => {
    const noStamp = {
      ...source,
      components: source.components.map((c) => ({ ...c, filledAt: null })),
    };
    const fact = poolFromSource("claude", POOLS.claude, noStamp);
    assert.equal(fact.measuredAt, null);
    assert.equal(verdictForPool(fact, NOW).verdict, "low");
  });
});
