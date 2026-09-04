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
  resolveOverridesPath,
  loadLocalOverrides,
  SHARED_OVERRIDES_FILE,
} from "../collector/index.js";
import {
  amsterdamClock,
  nearAmsterdamSlot,
  shouldRunCollect,
} from "../scripts/amsterdam-gate.js";
import * as enrich from "../collector/adapters/enrich-labs.js";
import * as openai from "../collector/adapters/openai-buzz.js";
import * as ollama from "../collector/adapters/ollama.js";
import * as claudeCode from "../collector/adapters/claude-code.js";
import * as cursorAgent from "../collector/adapters/cursor-agent.js";
import { poolsFromSnapshot, verdictForPool } from "../collector/lib/routing.js";
import { EventEmitter } from "node:events";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Keep collectSnapshot override tests hermetic: a signed-in Cursor on the
 * machine would otherwise produce an automatic measurement and ignore
 * non-supplement overrides (by design).
 */
async function withMissingCursorLocalState(fn) {
  const prevDb = process.env.CURSOR_STATE_DB;
  const prevJson = process.env.CURSOR_STORAGE_JSON;
  const prevClaudeCredentials = process.env.CLAUDE_CREDENTIALS_PATH;
  process.env.CURSOR_STATE_DB = path.join(
    ROOT,
    "test",
    "fixtures",
    "missing-cursor-state.vscdb",
  );
  process.env.CURSOR_STORAGE_JSON = path.join(
    ROOT,
    "test",
    "fixtures",
    "missing-cursor-storage.json",
  );
  process.env.CLAUDE_CREDENTIALS_PATH = path.join(
    ROOT,
    "test",
    "fixtures",
    "missing-claude-credentials.json",
  );
  try {
    return await fn();
  } finally {
    if (prevDb === undefined) delete process.env.CURSOR_STATE_DB;
    else process.env.CURSOR_STATE_DB = prevDb;
    if (prevJson === undefined) delete process.env.CURSOR_STORAGE_JSON;
    else process.env.CURSOR_STORAGE_JSON = prevJson;
    if (prevClaudeCredentials === undefined) delete process.env.CLAUDE_CREDENTIALS_PATH;
    else process.env.CLAUDE_CREDENTIALS_PATH = prevClaudeCredentials;
  }
}

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

  it("accepts top-level routing local-share metric (not a sixth source)", () => {
    const base = {
      version: "1.3.3",
      generatedAt: "2026-08-31T14:16:00.000Z",
      timezone: "Europe/Amsterdam",
      sources: SOURCE_IDS.map((id) =>
        emptySource({ id, status: "unknown", reason: "n/a" }),
      ),
    };
    assert.equal(validateSnapshot({ ...base, routing: null }).ok, true);
    assert.equal(
      validateSnapshot({
        ...base,
        routing: {
          today: { local: 6, total: 12, percent: 50 },
          rolling7d: { local: 6, total: 12, percent: 50 },
          lastEntry: "2026-08-31T14:08:00.000Z",
          skipped: 0,
          runtimeEvidence: "ollama.log /api/generate per included task",
        },
      }).ok,
      true,
    );
    assert.equal(
      validateSnapshot({
        ...base,
        routing: {
          today: { local: 0, total: 0, percent: null },
          rolling7d: { local: 0, total: 0, percent: null },
          lastEntry: null,
          skipped: 0,
          reason: "awaiting provider fix",
        },
      }).ok,
      true,
    );
    assert.equal(
      validateSnapshot({
        ...base,
        routing: {
          today: { local: 0, total: 0, percent: 0 },
          rolling7d: { local: 0, total: 0, percent: null },
          lastEntry: null,
          skipped: 0,
        },
      }).ok,
      false,
    );
    assert.equal(
      validateSnapshot({
        ...base,
        routing: {
          today: { local: 2, total: 1, percent: 200 },
          rolling7d: { local: 0, total: 0, percent: null },
          lastEntry: null,
          skipped: 0,
        },
      }).ok,
      false,
    );
  });

  it("refuses to publish a local percentage without runtime evidence", () => {
    const base = {
      version: "1.3.4",
      generatedAt: "2026-08-31T14:16:00.000Z",
      timezone: "Europe/Amsterdam",
      sources: SOURCE_IDS.map((id) =>
        emptySource({ id, status: "unknown", reason: "n/a" }),
      ),
    };

    // Exactly the shape that shipped 6/12 = 50%: counts derived from each
    // agent's configured model label, with nothing proving the work ran locally.
    const labelOnly = {
      today: { local: 6, total: 12, percent: 50 },
      rolling7d: { local: 6, total: 12, percent: 50 },
      lastEntry: "2026-08-31T14:08:00.000Z",
      skipped: 0,
    };
    const rejected = validateSnapshot({ ...base, routing: labelOnly });
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /runtimeEvidence is required/);

    // An empty string is not evidence either.
    assert.equal(
      validateSnapshot({ ...base, routing: { ...labelOnly, runtimeEvidence: "   " } }).ok,
      false,
    );

    // Naming the measured runtime proof unblocks publication.
    assert.equal(
      validateSnapshot({
        ...base,
        routing: { ...labelOnly, runtimeEvidence: "ollama.log /api/generate per included task" },
      }).ok,
      true,
    );

    // Withholding the percentage is only honest if it says why.
    const silent = {
      today: { local: 0, total: 0, percent: null },
      rolling7d: { local: 0, total: 0, percent: null },
      lastEntry: null,
      skipped: 0,
    };
    const noReason = validateSnapshot({ ...base, routing: silent });
    assert.equal(noReason.ok, false);
    assert.match(noReason.errors.join("\n"), /reason is required/);
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
  it("openai prefers the live account read over the session log", async () => {
    const r = await openai.collect({
      queryLive: async () => ({
        observedAt: "2026-08-31T13:13:25.000Z",
        primary: { usedPercent: 15, windowMinutes: 300, resetsAt: 1788199791 },
        secondary: { usedPercent: 2, windowMinutes: 10080, resetsAt: 1788786591 },
      }),
      // A stale log saying 100% must not win over the live 15%.
      listFiles: async () => ["rollout-a.jsonl"],
      readSession: async () =>
        `${JSON.stringify({
          timestamp: "2026-08-31T12:22:30.586Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 100, window_minutes: 300 },
            },
          },
        })}\n`,
      now: new Date("2026-08-31T13:13:25.000Z"),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, 15);
    assert.match(r.reason, /Live from the signed-in Codex account/);
    assert.match(r.reason, /weekly window is 2% used/);
    assert.equal(r.resetDate, new Date(1788199791 * 1000).toISOString());
  });

  it("openai parses the live camelCase payload and drops account details", async () => {
    const { queryLiveRateLimits } = openai;
    const response = JSON.stringify({
      id: 2,
      result: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1788199791 },
          secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1788786591 },
          credits: { hasCredits: false, unlimited: false, balance: "903.20" },
          planType: "plus",
        },
      },
    });
    const fakeSpawn = () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      stdout.setEncoding = () => {};
      child.stdout = stdout;
      child.stdin = { write: () => setImmediate(() => stdout.emit("data", `${response}\n`)) };
      child.kill = () => {};
      return child;
    };
    const reading = await queryLiveRateLimits({
      spawnImpl: fakeSpawn,
      now: new Date("2026-08-31T13:13:25.000Z"),
    });
    assert.equal(reading.primary.usedPercent, 15);
    assert.equal(reading.primary.windowMinutes, 300);
    assert.equal(reading.secondary.usedPercent, 2);
    // Balance and plan tier are account details, not usage.
    assert.doesNotMatch(JSON.stringify(reading), /903\.20|plus|codex/);
  });

  it("openai falls back to the log when the live read fails", async () => {
    const failingSpawn = () => {
      throw new Error("codex not installed");
    };
    const reading = await openai.queryLiveRateLimits({ spawnImpl: failingSpawn });
    assert.equal(reading, null);
  });

  it("openai stays unknown when no Codex session log is readable", async () => {
    const r = await openai.collect({
      queryLive: async () => null,
      listFiles: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.ok(r.reason.length > 0);

    const empty = await openai.collect({
      queryLive: async () => null,
      listFiles: async () => [],
    });
    assert.equal(empty.status, "unknown");
    assert.equal(empty.usage, null);
  });

  it("openai reads provider rate-limit percentages from the session log", async () => {
    const line = JSON.stringify({
      timestamp: "2026-08-31T10:34:53.019Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 300, resets_at: 1788176638 },
          secondary: { used_percent: 16, window_minutes: 10080, resets_at: 1788763438 },
          credits: { balance: "903.2037830000" },
          plan_type: "plus",
        },
      },
    });
    const r = await openai.collect({
      queryLive: async () => null,
      listFiles: async () => ["rollout-a.jsonl"],
      readSession: async () => `${line}\n`,
      now: new Date("2026-08-31T11:34:53.019Z"),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, 100);
    assert.equal(r.limit, 100);
    assert.equal(r.unit, "% of 5-hour Codex limit");
    assert.match(r.reason, /weekly window is 16% used/);
    assert.equal(r.lastUpdate, "2026-08-31T10:34:53.019Z");
    // Credit balance and plan tier are account details and must not leak.
    assert.doesNotMatch(JSON.stringify(r), /903\.2|plus/);
  });

  it("openai refuses to publish a percentage whose window already reset", async () => {
    const resetsAt = Math.floor(Date.parse("2026-08-31T11:43:58Z") / 1000);
    const line = JSON.stringify({
      timestamp: "2026-08-31T10:34:53.019Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 300, resets_at: resetsAt },
        },
      },
    });
    const r = await openai.collect({
      queryLive: async () => null,
      listFiles: async () => ["rollout-a.jsonl"],
      readSession: async () => `${line}\n`,
      now: new Date("2026-08-31T12:59:00.000Z"),
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /has not run since|no reading yet/);
  });

  it("openai keeps the newest reading across session files", async () => {
    const event = (ts, pct) =>
      `${JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: pct, window_minutes: 300 } },
        },
      })}\n`;
    const r = await openai.collect({
      queryLive: async () => null,
      listFiles: async () => ["old.jsonl", "new.jsonl"],
      readSession: async (file) =>
        file === "old.jsonl"
          ? event("2026-08-31T08:00:00.000Z", 12)
          : event("2026-08-31T09:00:00.000Z", 44),
      now: new Date("2026-08-31T09:30:00.000Z"),
    });
    assert.equal(r.usage, 44);
  });

  it("cursor parses GetCurrentPeriodUsage fixture into spending components", async () => {
    const period = JSON.parse(await readFile(CURSOR_PERIOD_FIXTURE, "utf8"));
    const grok = JSON.parse(await readFile(CURSOR_GROK_FIXTURE, "utf8"));
    const parsed = cursorAgent.parsePeriodUsage(period);
    assert.ok(parsed);
    assert.equal(parsed.components.length, 3);
    assert.equal(parsed.components[0].id, "included-cursor-models");
    assert.equal(parsed.components[0].usage, 14);
    assert.equal(parsed.components[0].role, "capacity");
    assert.equal(parsed.components[1].id, "other-models");
    assert.equal(parsed.components[1].usage, 24);
    assert.equal(parsed.components[2].id, "on-demand");
    assert.equal(parsed.components[2].usage, 73.6);
    assert.equal(parsed.components[2].limit, 75);
    assert.equal(parsed.components[2].unit, "USD");
    assert.equal(parsed.components[2].role, "capped");
    // Fixture must never look like a real token / secret payload.
    assert.doesNotMatch(JSON.stringify(period), /Bearer|eyJ|sk-/i);

    const grokComponent = cursorAgent.parseGrokBotUsage(grok);
    assert.equal(grokComponent.id, "grok-bot");
    assert.equal(grokComponent.usage, 100);
    assert.equal(grokComponent.role, "capped");
    assert.equal(grokComponent.resetDate, "2026-08-31T18:29:14.000Z");
  });

  it("cursor omits Grok Bot when Sand status says no personal weekly meter", () => {
    assert.equal(
      cursorAgent.parseGrokBotUsage({
        usagePercent: 0,
        hasNonZeroIncludedLimit: false,
      }),
      null,
    );
    assert.equal(
      cursorAgent.parseGrokBotUsage({
        usagePercent: 50,
        usesPooledEnterpriseAllowance: true,
      }),
      null,
    );
    assert.equal(
      cursorAgent.parseGrokBotUsage({ includedLimitZero: true, usagePercent: 10 }),
      null,
    );
  });

  it("cursor collect measures from fixtures without leaking a token", async () => {
    const period = JSON.parse(await readFile(CURSOR_PERIOD_FIXTURE, "utf8"));
    const grok = JSON.parse(await readFile(CURSOR_GROK_FIXTURE, "utf8"));
    const sentinel = "test-access-token-MUST-NOT-LEAK";
    const r = await cursorAgent.collect({
      now: new Date("2026-09-02T08:00:00.000Z"),
      readToken: async () => sentinel,
      fetchPeriod: async () => ({ ok: true, json: period }),
      fetchGrok: async () => ({ ok: true, json: grok }),
      fetchHard: async () => ({ ok: false }),
      fetchSummary: async () => ({ ok: false }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, null);
    assert.equal(r.components.length, 4);
    assert.equal(r.components[0].usage, 14);
    assert.equal(r.components[2].usage, 73.6);
    assert.equal(r.components[3].id, "grok-bot");
    assert.match(r.reason, /GetCurrentPeriodUsage/);
    assert.match(r.reason, /GetSandUsageStatus/);
    const published = JSON.stringify(r);
    assert.doesNotMatch(published, new RegExp(sentinel));
    assert.doesNotMatch(published, /Bearer\s/i);
  });

  it("cursor collect omits Grok Bot and notes it when Sand endpoint fails", async () => {
    const period = JSON.parse(await readFile(CURSOR_PERIOD_FIXTURE, "utf8"));
    const r = await cursorAgent.collect({
      now: new Date("2026-09-02T08:00:00.000Z"),
      readToken: async () => "unused-in-assertions",
      fetchPeriod: async () => ({ ok: true, json: period }),
      fetchGrok: async () => ({ ok: false, status: 404 }),
      fetchHard: async () => ({ ok: false }),
      fetchSummary: async () => ({ ok: false }),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.components.length, 3);
    assert.ok(!r.components.some((c) => c.id === "grok-bot"));
    assert.match(r.reason, /Grok Bot weekly % omitted/i);
    assert.doesNotMatch(JSON.stringify(r), /unused-in-assertions/);
  });

  it("cursor fails closed when the local token/DB is missing", async () => {
    const r = await cursorAgent.collect({
      readToken: async () => null,
      fetchPeriod: async () => {
        throw new Error("must not call API without a token");
      },
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.collectionMode, "unavailable");
    assert.equal(r.usage, null);
    assert.equal(r.components, undefined);
    assert.match(r.reason, /no signed-in access token/i);
  });

  it("cursor fails closed when GetCurrentPeriodUsage is unavailable", async () => {
    const r = await cursorAgent.collect({
      readToken: async () => "tok",
      fetchPeriod: async () => ({ ok: false, status: 401 }),
      fetchGrok: async () => ({ ok: false }),
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /GetCurrentPeriodUsage was unavailable/);
    assert.doesNotMatch(JSON.stringify(r), /\btok\b/);
  });

  it("cursor automatic measurement ignores a non-supplement manual seed", () => {
    const base = normalizeSource({
      id: "cursor-agent",
      status: "measured",
      collectionMode: "automatic",
      reason: "Live from GetCurrentPeriodUsage.",
      usage: null,
      lastUpdate: "2026-09-02T08:00:00.000Z",
      components: [
        {
          id: "included-cursor-models",
          label: "Included Cursor Models",
          role: "capacity",
          usage: 14,
          limit: 100,
          unit: "% of included allowance",
        },
      ],
    });
    const merged = applyOverride(
      base,
      {
        id: "cursor-agent",
        status: "measured",
        collectionMode: "manual",
        usage: null,
        lastUpdate: "2026-08-31T13:59:14.000Z",
        reason: "stale manual seed",
        components: [
          {
            id: "included-cursor-models",
            label: "Included Cursor Models",
            role: "capacity",
            usage: 99,
            limit: 100,
            unit: "% of included allowance",
          },
          {
            id: "grok-bot",
            label: "Grok Bot (weekly)",
            role: "capped",
            usage: 100,
            limit: 100,
            unit: "% of weekly allowance",
          },
        ],
      },
      new Date("2026-09-02T08:00:00.000Z"),
    );
    assert.equal(merged.collectionMode, "automatic");
    assert.equal(merged.components.length, 1);
    assert.equal(merged.components[0].usage, 14);
    assert.match(merged.reason, /manual override was ignored/i);
    assert.doesNotMatch(merged.reason, /stale manual seed/);
  });

  it("claude-code measures transcript tokens and de-duplicates streamed messages", async () => {
    const msg = (id, ts, out) =>
      `${JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: {
          id,
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 900,
            output_tokens: out,
          },
        },
      })}\n`;
    const r = await claudeCode.collect({
      listFiles: async () => ["a.jsonl"],
      readTranscript: async () =>
        // Same id twice (streaming), then a second message, then a prior month.
        msg("msg_1", "2026-08-31T10:00:00.000Z", 50) +
        msg("msg_1", "2026-08-31T10:00:02.000Z", 50) +
        msg("msg_2", "2026-08-31T11:00:00.000Z", 25) +
        msg("msg_old", "2026-07-30T11:00:00.000Z", 999),
      readToken: async () => null,
      now: new Date("2026-08-31T12:00:00.000Z"),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.breakdown.generations, 2);
    assert.equal(r.breakdown.promptTokens, 2004);
    assert.equal(r.breakdown.outputTokens, 75);
    assert.equal(r.usage, 2079);
    assert.equal(r.limit, null);
    assert.equal(r.lastUpdate, "2026-08-31T11:00:00.000Z");
  });

  it("claude-code stays unknown without transcripts", async () => {
    const r = await claudeCode.collect({
      listFiles: async () => [],
      readToken: async () => null,
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
  });

  it("claude-code OAuth usage maps session/weekly/credits without leaking tokens", async () => {
    const fixture = JSON.parse(await readFile(
      path.join(ROOT, "test", "fixtures", "claude-oauth-usage.json"),
      "utf8",
    ));
    const parsed = claudeCode.parseOauthUsage(fixture);
    assert.ok(parsed);
    assert.equal(parsed.components.length, 3);
    assert.equal(parsed.components[0].id, "session");
    assert.equal(parsed.components[0].usage, 14);
    assert.equal(parsed.components[1].id, "weekly-all-models");
    assert.equal(parsed.components[2].id, "usage-credits");
    assert.equal(parsed.components[2].unit, "EUR");
    assert.equal(parsed.resetDate, "2026-10-01");

    const r = await claudeCode.collect({
      listFiles: async () => ["a.jsonl"],
      readTranscript: async () =>
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-09-02T10:00:00.000Z",
          message: {
            id: "msg_oauth",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        })}\n`,
      readToken: async () => "sk-ant-oat-TEST-TOKEN-NOT-REAL",
      queryOauth: async ({ token }) => {
        assert.equal(token, "sk-ant-oat-TEST-TOKEN-NOT-REAL");
        return { ok: true, json: fixture };
      },
      readOauthCache: async () => null,
      writeOauthCache: async () => {},
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, null);
    assert.equal(r.unit, "mixed (see components)");
    assert.equal(r.components.length, 3);
    assert.equal(r.breakdown.generations, 1);
    assert.match(r.reason, /OAuth/);
    assert.doesNotMatch(r.reason, /sk-ant-oat/);
    assert.doesNotMatch(JSON.stringify(r), /sk-ant-oat/);
  });

  it("claude-code falls back to transcripts when OAuth is rate-limited", async () => {
    const r = await claudeCode.collect({
      listFiles: async () => ["a.jsonl"],
      readTranscript: async () =>
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-09-02T10:00:00.000Z",
          message: {
            id: "msg_rl",
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        })}\n`,
      readToken: async () => "sk-ant-oat-TEST",
      queryOauth: async () => ({ ok: false, status: 429 }),
      readOauthCache: async () => null,
      writeOauthCache: async () => {},
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, 120);
    assert.equal(r.unit, "tokens");
    assert.match(r.reason, /429/);
  });

  it("claude-code reuses one OAuth reading for two collects within an hour", async () => {
    const fixture = JSON.parse(await readFile(
      path.join(ROOT, "test", "fixtures", "claude-oauth-usage.json"),
      "utf8",
    ));
    let cache = null;
    let calls = 0;
    const options = {
      listFiles: async () => [],
      readToken: async () => "sk-ant-oat-FIXTURE",
      queryOauth: async () => {
        calls += 1;
        return { ok: true, json: fixture };
      },
      readOauthCache: async () => cache,
      writeOauthCache: async (value) => {
        cache = structuredClone(value);
      },
    };
    const measuredAt = "2026-09-02T12:00:00.000Z";
    const first = await claudeCode.collect({
      ...options,
      now: new Date(measuredAt),
    });
    const second = await claudeCode.collect({
      ...options,
      now: new Date("2026-09-02T12:45:00.000Z"),
    });

    assert.equal(calls, 1);
    assert.equal(first.lastUpdate, measuredAt);
    assert.equal(second.lastUpdate, measuredAt);
    assert.match(second.reason, /^Cached/);

    const routing = poolsFromSnapshot({
      generatedAt: "2026-09-02T12:45:00.000Z",
      sources: [second],
    });
    assert.equal(routing.pools.claude.percent, 14);
    assert.equal(routing.pools.claude.collectionMode, "automatic");
    assert.equal(routing.pools.claude.measuredAt, measuredAt);
  });

  it("claude-code respects Retry-After and stays unknown after a 429 without cache", async () => {
    let cache = null;
    let calls = 0;
    const options = {
      listFiles: async () => [],
      readToken: async () => "sk-ant-oat-FIXTURE",
      queryOauth: async () => {
        calls += 1;
        return { ok: false, status: 429, retryAfter: "7200" };
      },
      readOauthCache: async () => cache,
      writeOauthCache: async (value) => {
        cache = structuredClone(value);
      },
    };
    const first = await claudeCode.collect({
      ...options,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    const second = await claudeCode.collect({
      ...options,
      now: new Date("2026-09-02T13:01:00.000Z"),
    });

    assert.equal(calls, 1);
    assert.equal(cache.retryAfter, "2026-09-02T14:00:00.000Z");
    assert.equal(first.status, "unknown");
    assert.equal(second.status, "unknown");
    const withManualSeed = applyOverride(normalizeSource(second), {
      id: "claude-code",
      supplements: true,
      status: "measured",
      collectionMode: "manual",
      lastUpdate: "2026-09-01T10:00:00.000Z",
      reason: "stale fixture seed",
      components: [
        {
          id: "session",
          label: "Session window",
          role: "capacity",
          usage: 0,
          limit: 100,
          unit: "% of session limit",
        },
      ],
    });
    const fact = poolsFromSnapshot({ sources: [withManualSeed] }).pools.claude;
    assert.equal(withManualSeed.status, "unknown");
    assert.equal(withManualSeed.components, null);
    assert.equal(fact.percent, null);
    assert.equal(verdictForPool(fact, new Date("2026-09-02T13:01:00.000Z")).verdict, "unknown");
  });

  it("claude-code serves the last successful reading on 429 without refreshing its age", async () => {
    const fixture = JSON.parse(await readFile(
      path.join(ROOT, "test", "fixtures", "claude-oauth-usage.json"),
      "utf8",
    ));
    const measuredAt = "2026-09-02T10:00:00.000Z";
    let cache = {
      version: 1,
      oauth: claudeCode.parseOauthUsage(fixture),
      measuredAt,
      lastAttemptAt: measuredAt,
      retryAfter: null,
    };
    const result = await claudeCode.collect({
      listFiles: async () => [],
      readToken: async () => "sk-ant-oat-FIXTURE",
      queryOauth: async () => ({ ok: false, status: 429, retryAfter: "3600" }),
      readOauthCache: async () => cache,
      writeOauthCache: async (value) => {
        cache = structuredClone(value);
      },
      now: new Date("2026-09-02T11:01:00.000Z"),
    });

    assert.equal(result.status, "measured");
    assert.equal(result.lastUpdate, measuredAt);
    assert.match(result.reason, /^Cached/);
    assert.match(result.reason, /429/);
    assert.equal(cache.measuredAt, measuredAt);
  });

  it("readClaudeOauthToken reads accessToken only", async () => {
    const token = await claudeCode.readClaudeOauthToken({
      credentialsPath: "unused",
      readText: async () =>
        JSON.stringify({
          claudeAiOauth: { accessToken: "sk-ant-oat-ABC", refreshToken: "nope" },
        }),
    });
    assert.equal(token, "sk-ant-oat-ABC");
  });

  it("enrich exposes public budget constants only", async () => {
    const r = await enrich.collect();
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.equal(r.limit, ENRICH_MONTHLY_BUDGET);
    assert.equal(r.budget.monthly, 200);
    assert.equal(r.budget.weeklyPaceMax, 50);
    assert.equal(r.pace.weeklyTarget, 50);
    assert.match(r.reason, /Hard stop/i);
    assert.match(r.reason, /enrich\.so/i);
  });

  it("ollama reports unknown or measured without fake usage", async () => {
    const r = await ollama.collect({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      readLog: async () => "",
    });
    assert.equal(r.status, "unknown");
    assert.equal(r.usage, null);
    assert.match(r.reason, /unavailable|fabricated/i);

    const ok = await ollama.collect({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { models: [{ name: "x" }, { name: "y" }] };
        },
      }),
      readLog: async () => {
        throw new Error("no log");
      },
    });
    assert.equal(ok.status, "measured");
    assert.equal(ok.usage, null);
    assert.match(ok.reason, /2 model/);

    const withLog = await ollama.collect({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { models: [{ name: "x" }] };
        },
      }),
      readLog: async () =>
          [
            "time=2026-08-31T10:00:00.000+02:00 level=INFO source=server.go msg=start",
            "slot print_timing: id  0 | task 0 | prompt eval time =    100.00 ms /    10 tokens (   10.00 ms per token,   100.00 tokens per second)",
            "slot print_timing: id  0 | task 0 |        eval time =    200.00 ms /    20 tokens (   10.00 ms per token,   100.00 tokens per second)",
            '[GIN] 2026/08/31 - 12:00:00 | 200 |         1.0s |       127.0.0.1 | POST     "/api/chat"',
          ].join("\n"),
      // Pin collect time to the fixture month — parser scopes to Amsterdam month.
      now: new Date("2026-08-31T10:00:00.000Z"),
    });
    assert.equal(withLog.status, "measured");
    assert.equal(withLog.usage, 30);
  });
});

describe("overrides path", () => {
  it("prefers the shared machine-wide file over the per-checkout copy", async () => {
    delete process.env.AI_USAGE_OVERRIDES_PATH;
    const shared = await resolveOverridesPath(async (p) => p === SHARED_OVERRIDES_FILE);
    assert.equal(shared, SHARED_OVERRIDES_FILE);

    // Without the shared file, fall back to the in-repo copy.
    const repo = await resolveOverridesPath(async () => false);
    assert.match(repo, /data\/local-overrides\.json$/);
  });

  it("honours an explicit AI_USAGE_OVERRIDES_PATH", async () => {
    process.env.AI_USAGE_OVERRIDES_PATH = "/tmp/explicit-overrides.json";
    try {
      assert.equal(
        await resolveOverridesPath(async () => true),
        "/tmp/explicit-overrides.json",
      );
    } finally {
      delete process.env.AI_USAGE_OVERRIDES_PATH;
    }
  });

  it("reads the resolved file, not the default one", async () => {
    const file = path.join(ROOT, "test", "fixture-overrides.json");
    await writeFile(
      file,
      JSON.stringify({
        sources: [
          {
            id: "enrich-labs",
            status: "measured",
            usage: 7,
            limit: 200,
            reason: "fixture",
            lastUpdate: "2026-08-31T10:00:00.000Z",
          },
        ],
      }),
    );
    try {
      const sources = await loadLocalOverrides(file);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].usage, 7);
    } finally {
      await rm(file, { force: true });
    }
  });
});

describe("collector", () => {
  it("builds a valid honest snapshot", async () => {
    await withMissingCursorLocalState(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [],
      });
      assert.equal(validateSnapshot(snap).ok, true);
      assert.equal(snap.version, "1.6.1");
      assert.equal(snap.sources.length, 5);
      for (const s of snap.sources) {
        assertHonestSource(s);
        if (s.status === "unknown") assert.equal(s.usage, null);
      }
      const enrichSrc = snap.sources.find((s) => s.id === "enrich-labs");
      assert.equal(enrichSrc.limit, 200);
      assert.equal(enrichSrc.pace.weeklyTarget, 50);
    });
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

    await withMissingCursorLocalState(async () => {
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
      assert.equal(cursor.pace.daily, null);
      assert.equal(cursor.pace.monthly, null);
    });
  });

  it("stamps every manual override with how old the reading is", () => {
    const base = normalizeSource({
      id: "enrich-labs",
      status: "unknown",
      reason: "no public API",
      usage: null,
    });
    const fresh = applyOverride(
      base,
      {
        id: "enrich-labs",
        status: "measured",
        usage: 200,
        limit: 200,
        reason: "read from the workspace",
        lastUpdate: "2026-08-31T10:00:00.000Z",
      },
      new Date("2026-08-31T12:00:00.000Z"),
    );
    assert.match(fresh.reason, /Manual reading 2 hour\(s\) old/);
    assert.doesNotMatch(fresh.reason, /STALE/);

    const stale = applyOverride(
      base,
      {
        id: "enrich-labs",
        status: "measured",
        usage: 200,
        limit: 200,
        reason: "read from the workspace",
        lastUpdate: "2026-08-30T10:00:00.000Z",
      },
      new Date("2026-08-31T12:00:00.000Z"),
    );
    assert.match(stale.reason, /^STALE: |\bSTALE: /);
    assert.equal(stale.usage, 200);
  });

  it("refuses to let a manual override overwrite an automatic measurement", () => {
    const base = normalizeSource({
      id: "openai-buzz",
      status: "measured",
      collectionMode: "automatic",
      reason: "read from the Codex session log",
      usage: 100,
      limit: 100,
      unit: "% of 5-hour Codex limit",
      lastUpdate: "2026-08-31T10:34:53.019Z",
    });
    const merged = applyOverride(
      base,
      {
        id: "openai-buzz",
        status: "measured",
        usage: 98,
        limit: 100,
        reason: "typed from the billing screen",
        lastUpdate: "2026-08-31T09:00:00.000Z",
      },
      new Date("2026-08-31T12:00:00.000Z"),
    );
    assert.equal(merged.usage, 100);
    assert.equal(merged.collectionMode, "automatic");
    assert.doesNotMatch(merged.reason, /typed from the billing screen/);
    assert.match(merged.reason, /manual override was ignored/i);
  });

  it("lets a declared supplement carry a metric the collector cannot measure", () => {
    const base = normalizeSource({
      id: "claude-code",
      status: "measured",
      collectionMode: "automatic",
      reason: "2079 tokens this month from local transcripts.",
      usage: 2079,
      limit: null,
      unit: "tokens",
      lastUpdate: "2026-08-31T11:00:00.000Z",
      breakdown: { promptTokens: 2004, outputTokens: 75, generations: 2 },
      history: [{ date: "2026-08-31", usage: 2079 }],
    });
    const merged = applyOverride(
      base,
      {
        id: "claude-code",
        supplements: true,
        status: "measured",
        collectionMode: "manual",
        usage: 10.23,
        limit: 50,
        unit: "EUR usage credits",
        reason: "Read from the Claude usage settings page.",
        lastUpdate: "2026-08-31T10:00:00.000Z",
        components: [
          {
            id: "usage-credits",
            label: "Usage credits",
            usage: 10.23,
            limit: 50,
            unit: "EUR",
            resetDate: "2026-10-01",
          },
        ],
      },
      new Date("2026-08-31T12:00:00.000Z"),
    );
    // Automatic reading stays the source of truth; override only adds meters.
    assert.equal(merged.collectionMode, "automatic");
    assert.equal(merged.usage, 2079);
    assert.equal(merged.lastUpdate, "2026-08-31T11:00:00.000Z");
    assert.equal(merged.breakdown.generations, 2);
    assert.equal(merged.components.length, 1);
    assert.equal(merged.components[0].id, "usage-credits");
    assert.equal(merged.components[0].usage, 10.23);
    assert.match(merged.reason, /Source stays automatic/);
    assert.doesNotMatch(merged.reason, /Local automatic measurement alongside it/);
    assert.doesNotMatch(merged.reason, /does not persist these plan percentages/i);
  });

  it("Claude OAuth automatic wins over a stale supplements scrape", () => {
    const base = normalizeSource({
      id: "claude-code",
      status: "measured",
      collectionMode: "automatic",
      reason:
        "Live from the signed-in Claude.ai OAuth session via /api/oauth/usage: session 0%; weekly all-models 8% (resets 2026-09-05T07:00:00.320Z). Missing from API: usage credits.",
      usage: null,
      limit: null,
      unit: "mixed (see components)",
      lastUpdate: "2026-09-03T05:44:00.000Z",
      components: [
        {
          id: "session",
          label: "Session window",
          usage: 0,
          limit: 100,
          unit: "% of session limit",
          resetDate: "2026-09-03T10:00:00.000Z",
        },
        {
          id: "weekly-all-models",
          label: "Weekly (all models)",
          usage: 8,
          limit: 100,
          unit: "% of weekly limit",
          resetDate: "2026-09-05T07:00:00.320Z",
        },
      ],
      breakdown: { promptTokens: 100, outputTokens: 10, generations: 1 },
    });
    const merged = applyOverride(
      base,
      {
        id: "claude-code",
        supplements: true,
        status: "measured",
        collectionMode: "manual",
        reason:
          "Read from the signed-in Claude usage page. Claude Code does not persist these plan percentages locally, so a scheduled run cannot re-measure them.",
        lastUpdate: "2026-09-02T09:34:38.875Z",
        components: [
          {
            id: "session",
            label: "Session window",
            usage: 14,
            limit: 100,
            unit: "% of session limit",
            resetDate: "2026-09-02T13:40:38.000Z",
          },
          {
            id: "weekly-all-models",
            label: "Weekly (all models)",
            usage: 3,
            limit: 100,
            unit: "% of weekly limit",
            resetDate: "2026-09-05T09:00:00.000Z",
          },
          {
            id: "usage-credits",
            label: "Usage credits",
            usage: 0,
            limit: 50,
            unit: "EUR",
            resetDate: "2026-10-01",
          },
        ],
      },
      new Date("2026-09-03T05:44:00.000Z"),
    );
    assert.equal(merged.collectionMode, "automatic");
    assert.equal(merged.lastUpdate, "2026-09-03T05:44:00.000Z");
    assert.equal(merged.components.length, 3);
    assert.equal(
      merged.components.find((c) => c.id === "session").usage,
      0,
    );
    assert.equal(
      merged.components.find((c) => c.id === "weekly-all-models").usage,
      8,
    );
    assert.equal(
      merged.components.find((c) => c.id === "usage-credits").usage,
      0,
    );
    assert.match(merged.reason, /OAuth/);
    assert.match(merged.reason, /usage-credits/);
    assert.match(merged.reason, /Source stays automatic/);
    assert.doesNotMatch(merged.reason, /does not persist these plan percentages/i);
    assert.doesNotMatch(merged.reason, /no local meter exists for this source/i);
    assert.doesNotMatch(merged.reason, /Local automatic measurement alongside it/);
  });

  it("accepts Cursor spending-page capacity vs capped component roles", async () => {
    await withMissingCursorLocalState(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [
          {
            id: "cursor-agent",
            status: "measured",
            usage: null,
            limit: null,
            reason: "spending-page capacity/capped split test",
            lastUpdate: "2026-08-31T08:00:00.000Z",
            usageUrl: "https://cursor.com/dashboard/spending",
            components: [
              {
                id: "included-cursor-models",
                label: "Included Cursor Models",
                role: "capacity",
                usage: 14,
                limit: 100,
                unit: "% of included allowance",
              },
              {
                id: "other-models",
                label: "Other Models",
                role: "capacity",
                usage: 24,
                limit: 100,
                unit: "% of included allowance",
              },
              {
                id: "on-demand",
                label: "On-demand spend",
                role: "capped",
                usage: 73.6,
                limit: 75,
                unit: "USD",
              },
              {
                id: "grok-bot",
                label: "Grok Bot (weekly)",
                role: "capped",
                usage: 100,
                limit: 100,
                unit: "% of weekly allowance",
              },
            ],
          },
        ],
      });
      const cursor = snap.sources.find((s) => s.id === "cursor-agent");
      assert.equal(cursor.components.length, 4);
      assert.equal(cursor.usageUrl, "https://cursor.com/dashboard/spending");
      assert.equal(cursor.usage, null);
      assert.equal(cursor.components[0].role, "capacity");
      assert.equal(cursor.components[0].usage, 14);
      assert.equal(cursor.components[2].role, "capped");
      assert.equal(cursor.components[2].limit, 75);
    });
  });

  it("rejects unknown component roles", () => {
    assert.equal(
      validateLocalOverrides({
        sources: [
          {
            id: "cursor-agent",
            status: "measured",
            usage: null,
            lastUpdate: "2026-08-31T08:00:00.000Z",
            components: [
              {
                id: "x",
                label: "X",
                role: "maxed",
                usage: 1,
                limit: 1,
              },
            ],
          },
        ],
      }).ok,
      false,
    );
  });

  it("defaults Cursor usageUrl to the spending page", async () => {
    await withMissingCursorLocalState(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [],
      });
      const cursor = snap.sources.find((s) => s.id === "cursor-agent");
      assert.equal(cursor.usageUrl, "https://cursor.com/dashboard/spending");
    });
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
    // Shape, not a count: the number of meters is whatever the provider shows.
    assert.ok(cursor.components.length > 0);
    for (const c of cursor.components) {
      assert.ok(typeof c.label === "string" && c.label.length > 0);
      assert.ok(c.usage === null || typeof c.usage === "number");
    }
    assert.equal(cursor.usage, null);
    assert.match(cursor.usageUrl, /^https:\/\/cursor\.com\//);
    const capacity = cursor.components.filter((c) => c.role === "capacity");
    const capped = cursor.components.filter((c) => c.role === "capped");
    assert.ok(capacity.length >= 2);
    assert.ok(capped.length >= 2);
    assert.ok(capacity.every((c) => typeof c.usage === "number" && c.usage < 50));
    assert.match(
      await readFile(path.join(ROOT, "site", "dashboard.js"), "utf8"),
      /capacity-callout/,
    );
    assert.match(
      await readFile(path.join(ROOT, "site", "dashboard.js"), "utf8"),
      /Planruimte ruim/,
    );
    // Held at unavailable-with-reason until a routing log renormalised against
    // measured runtimes exists. The previous 6/12 = 50% counted an agent that
    // was measured running gpt-5.5 on OpenAI as local.
    assert.ok(snap.routing);
    assert.equal(snap.routing.today.percent, null);
    assert.equal(snap.routing.rolling7d.percent, null);
    assert.equal(snap.routing.runtimeEvidence, null);
    assert.match(snap.routing.reason, /not runtime evidence/);
    assert.match(
      await readFile(path.join(ROOT, "site", "dashboard.js"), "utf8"),
      /renderRoutingCard/,
    );
    const claude = snap.sources.find((s) => s.id === "claude-code");
    assert.equal(claude.usageUrl, "https://claude.ai/new#settings/usage");
    assert.match(
      await readFile(path.join(ROOT, "site", "dashboard.js"), "utf8"),
      /source-link/,
    );
  });

  it("site marks measured estimated and unavailable distinctly", async () => {
    const html = await readFile(path.join(ROOT, "site", "index.html"), "utf8");
    const css = await readFile(path.join(ROOT, "site", "styles.css"), "utf8");
    const js = await readFile(path.join(ROOT, "site", "dashboard.js"), "utf8");
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/i);
    assert.match(html, /Alles updaten/);
    assert.match(html, /btn-update/);
    assert.match(html, /mac-badge/);
    assert.match(html, /last-updated/);
    assert.match(html, /dashboard\.js\?v=1\.6\.1/);
    assert.match(html, /styles\.css\?v=1\.6\.1/);
    assert.match(html, /Laatst bijgewerkt:/);
    assert.doesNotMatch(js, /meta\.textContent = `Snapshot /);
    assert.doesNotMatch(js, /Dagtempo|Maandtempo/);
    assert.doesNotMatch(html, /Dagtempo|Maandtempo/);
    assert.match(css, /badge-measured/);
    assert.match(css, /badge-estimated/);
    assert.match(css, /badge-unknown/);
    assert.match(css, /badge-live/);
    assert.match(css, /\.btn-update/);
    assert.match(css, /\.mac-badge/);
    assert.match(css, /\.last-updated/);
    assert.match(css, /\.source-freshness/);
    assert.match(css, /\.settings-group/);
    assert.match(css, /-apple-system|system-ui/);
    assert.match(css, /prefers-color-scheme:\s*dark/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(js, /STATUS_LABEL/);
    assert.match(js, /measured/);
    assert.match(js, /estimated/);
    assert.match(js, /unavailable/);
    assert.match(js, /Laatst bijgewerkt:/);
    assert.match(js, /fmtAmsterdamDateTime/);
    assert.match(js, /renderSourceFreshness/);
    assert.match(js, /niet opnieuw gemeten/);
    assert.match(js, /badge-live/);
    assert.match(js, /collectionLabel/);
    assert.match(js, /handleUpdateClick/);
    assert.match(js, /isLocalAppHost/);
    assert.match(js, /Never uses Codex/);
    assert.doesNotMatch(js, /codex exec/i);
    assert.match(js, /Aangehouden — geen runtime-bewijs/);
    assert.match(js, /data-freshness/);
    assert.match(js, /MAC_ONLINE_MINUTES\s*=\s*20/);
    assert.match(js, /Mac online/);
    assert.match(js, /Mac offline \/ in slaap/);
    assert.match(js, /updateMacBadge/);
    assert.match(js, /card-more/);
    assert.match(js, /glanceMeter/);
    assert.match(js, /renderGlancePrimary/);
    assert.match(js, /verouderd/);
    assert.doesNotMatch(js, /badge-manual">stale/);
  });

  it("macPresence uses snapshot age only (no heartbeat)", async () => {
    const { macPresence, MAC_ONLINE_MINUTES } = await import(
      "../site/dashboard.js"
    );
    assert.equal(MAC_ONLINE_MINUTES, 20);
    const now = new Date("2026-09-03T12:00:00.000Z");
    const online = macPresence("2026-09-03T11:50:00.000Z", now);
    assert.equal(online.online, true);
    assert.equal(online.label, "Mac online");
    assert.match(online.title, /Europe\/Amsterdam/);
    const offline = macPresence("2026-09-03T11:30:00.000Z", now);
    assert.equal(offline.online, false);
    assert.equal(offline.label, "Mac offline / in slaap");
    assert.match(offline.title, /Laatste collect/);
    const missing = macPresence(null, now);
    assert.equal(missing.online, false);
    assert.match(missing.label, /Mac offline/);
  });

  it("glanceMeter picks hottest capped meter for home", async () => {
    const { glanceMeter } = await import("../site/dashboard.js");
    const pick = glanceMeter({
      components: [
        { id: "a", role: "capacity", usage: 20, limit: 100, label: "Incl" },
        { id: "b", role: "capped", usage: 98, limit: 100, label: "On-demand" },
        { id: "c", role: "capped", usage: 40, limit: 100, label: "Grok" },
      ],
    });
    assert.equal(pick.id, "b");
    assert.equal(pick.label, "On-demand");
  });
});
