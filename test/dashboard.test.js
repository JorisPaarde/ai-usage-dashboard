import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSnapshot,
  emptySource,
  assertHonestSource,
  assertPublishableSnapshot,
  validateLocalOverrides,
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
import * as openai from "../collector/adapters/openai-buzz.js";
import * as claudeCode from "../collector/adapters/claude-code.js";
import { poolsFromSnapshot, verdictForPool } from "../collector/lib/routing.js";
import { EventEmitter } from "node:events";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Keep collectSnapshot override tests hermetic: stub Claude credentials and
 * prepaid API keys so automatic collectors stay unavailable unless mocked.
 */
async function withMissingLocalCollectorSecrets(fn) {
  const prevClaudeCredentials = process.env.CLAUDE_CREDENTIALS_PATH;
  process.env.CLAUDE_CREDENTIALS_PATH = path.join(
    ROOT,
    "test",
    "fixtures",
    "missing-claude-credentials.json",
  );
  const prevOpenrouter = process.env.OPENROUTER_API_KEY;
  const prevOpenrouterMgmt = process.env.OPENROUTER_MANAGEMENT_KEY;
  const prevSail = process.env.SAIL_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  delete process.env.SAIL_API_KEY;
  try {
    return await fn();
  } finally {
    if (prevClaudeCredentials === undefined) delete process.env.CLAUDE_CREDENTIALS_PATH;
    else process.env.CLAUDE_CREDENTIALS_PATH = prevClaudeCredentials;
    if (prevOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenrouter;
    if (prevOpenrouterMgmt === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
    else process.env.OPENROUTER_MANAGEMENT_KEY = prevOpenrouterMgmt;
    if (prevSail === undefined) delete process.env.SAIL_API_KEY;
    else process.env.SAIL_API_KEY = prevSail;
  }
}

describe("schema", () => {
  it("requires every SOURCE_IDS entry and unknown reasons", () => {
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
        emptySource({ id: "openrouter", status: "estimated", reason: "guess" }),
      ),
    );
  });

  it("SOURCE_IDS is the four remaining collectors", () => {
    assert.deepEqual(SOURCE_IDS, [
      "openai-buzz",
      "claude-code",
      "openrouter",
      "sail",
    ]);
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
    assert.equal(dailyCapFromWeekly(50), 7.1);
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
    assert.equal(r.usage, null);
    assert.equal(r.limit, null);
    assert.equal(r.unit, "mixed (see components)");
    assert.equal(r.components.length, 2);
    assert.equal(r.components[0].id, "five-hour");
    assert.equal(r.components[0].usage, 15);
    assert.equal(r.components[1].id, "weekly");
    assert.equal(r.components[1].usage, 2);
    assert.match(r.reason, /Live from the signed-in Codex account/);
    assert.match(r.reason, /Weekly 2%/);
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

  it("openai componentsFromLimits builds five-hour and weekly capacity bars", () => {
    const components = openai.componentsFromLimits({
      observedAt: "2026-08-31T13:13:25.000Z",
      primary: { usedPercent: 15, windowMinutes: 300, resetsAt: 1788199791 },
      secondary: { usedPercent: 2, windowMinutes: 10080, resetsAt: 1788786591 },
    });
    assert.equal(components.length, 2);
    assert.equal(components[0].id, "five-hour");
    assert.equal(components[0].role, "capacity");
    assert.equal(components[0].usage, 15);
    assert.equal(components[0].limit, 100);
    assert.equal(components[1].id, "weekly");
    assert.equal(components[1].usage, 2);

    // Ids follow windowDurationMins, not primary/secondary order.
    const swapped = openai.componentsFromLimits({
      observedAt: "2026-08-31T13:13:25.000Z",
      primary: { usedPercent: 9, windowMinutes: 10080, resetsAt: 1788786591 },
      secondary: { usedPercent: 22, windowMinutes: 300, resetsAt: 1788199791 },
    });
    assert.equal(swapped[0].id, "weekly");
    assert.equal(swapped[0].usage, 9);
    assert.equal(swapped[1].id, "five-hour");
    assert.equal(swapped[1].usage, 22);
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
    assert.match(r.reason, /missing or not logged in/i);

    const empty = await openai.collect({
      queryLive: async () => null,
      listFiles: async () => [],
    });
    assert.equal(empty.status, "unknown");
    assert.equal(empty.usage, null);
    assert.match(empty.reason, /missing or not logged in/i);
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
    assert.equal(r.usage, null);
    assert.equal(r.limit, null);
    assert.equal(r.unit, "mixed (see components)");
    assert.equal(r.components.length, 2);
    assert.equal(r.components[0].id, "five-hour");
    assert.equal(r.components[0].usage, 100);
    assert.equal(r.components[1].id, "weekly");
    assert.equal(r.components[1].usage, 16);
    assert.match(r.reason, /weekly window is 16% used/);
    assert.match(r.reason, /codex missing or not logged in/i);
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
    assert.equal(r.usage, null);
    assert.equal(r.components[0].id, "five-hour");
    assert.equal(r.components[0].usage, 44);
  });

  it("openai automatic measurement ignores a non-supplement manual seed", () => {
    const base = normalizeSource({
      id: "openai-buzz",
      status: "measured",
      collectionMode: "automatic",
      reason: "Live from the signed-in Codex account.",
      usage: null,
      limit: null,
      unit: "mixed (see components)",
      lastUpdate: "2026-09-02T08:00:00.000Z",
      components: [
        {
          id: "five-hour",
          label: "5-hour",
          role: "capacity",
          usage: 15,
          limit: 100,
          unit: "% of 5-hour Codex limit",
        },
        {
          id: "weekly",
          label: "Weekly",
          role: "capacity",
          usage: 2,
          limit: 100,
          unit: "% of weekly Codex limit",
        },
      ],
    });
    const merged = applyOverride(
      base,
      {
        id: "openai-buzz",
        status: "measured",
        collectionMode: "manual",
        usage: null,
        lastUpdate: "2026-08-31T13:59:14.000Z",
        reason: "stale manual seed",
        components: [
          {
            id: "five-hour",
            label: "5-hour",
            role: "capacity",
            usage: 99,
            limit: 100,
            unit: "% of 5-hour Codex limit",
          },
        ],
      },
      new Date("2026-09-02T08:00:00.000Z"),
    );
    assert.equal(merged.collectionMode, "automatic");
    assert.equal(merged.components.length, 2);
    assert.equal(merged.components[0].usage, 15);
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

  it("claude-code falls back to Haiku rate-limit headers on oauth/usage 403 only", async () => {
    const reset5h = Math.floor(Date.parse("2026-09-02T18:00:00.000Z") / 1000);
    const reset7d = Math.floor(Date.parse("2026-09-09T12:00:00.000Z") / 1000);
    const headerMap = {
      "anthropic-ratelimit-unified-5h-utilization": "0.14",
      "anthropic-ratelimit-unified-5h-reset": String(reset5h),
      "anthropic-ratelimit-unified-7d-utilization": "0.08",
      "anthropic-ratelimit-unified-7d-reset": String(reset7d),
    };
    const fromHeaders = claudeCode.parseUnifiedRateLimitHeaders({
      get: (name) => headerMap[name] ?? null,
    });
    assert.ok(fromHeaders);
    assert.equal(fromHeaders.source, "haiku");
    assert.equal(fromHeaders.components[0].id, "session");
    assert.equal(fromHeaders.components[0].usage, 14);
    assert.equal(fromHeaders.components[1].id, "weekly-all-models");
    assert.equal(fromHeaders.components[1].usage, 8);

    let haikuCalls = 0;
    let cached;
    const r = await claudeCode.collect({
      listFiles: async () => [],
      readToken: async () => "sk-ant-oat-SETUP-TOKEN",
      queryOauth: async () => ({ ok: false, status: 403 }),
      queryHaikuHeaders: async ({ token }) => {
        haikuCalls += 1;
        assert.equal(token, "sk-ant-oat-SETUP-TOKEN");
        return { ok: true, oauth: fromHeaders };
      },
      readOauthCache: async () => null,
      writeOauthCache: async (value) => {
        cached = value;
      },
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    assert.equal(haikuCalls, 1);
    assert.equal(r.status, "measured");
    assert.equal(r.collectionMode, "automatic");
    assert.equal(r.usage, null);
    assert.equal(r.unit, "mixed (see components)");
    assert.equal(r.components.length, 2);
    assert.equal(r.components[0].id, "session");
    assert.equal(r.components[0].usage, 14);
    assert.equal(r.components[0].resetDate, "2026-09-02T18:00:00.000Z");
    assert.equal(r.components[1].id, "weekly-all-models");
    assert.equal(r.components[1].usage, 8);
    assert.equal(r.components[1].resetDate, "2026-09-09T12:00:00.000Z");
    assert.match(r.reason, /source=haiku/);
    assert.equal(cached?.oauth?.source, "haiku");
    assert.doesNotMatch(JSON.stringify(r), /sk-ant-oat-SETUP/);

    let haikuOn401 = 0;
    const on401 = await claudeCode.collect({
      listFiles: async () => [],
      readToken: async () => "sk-ant-oat-SETUP-TOKEN",
      queryOauth: async () => ({ ok: false, status: 401 }),
      queryHaikuHeaders: async () => {
        haikuOn401 += 1;
        return { ok: true, oauth: fromHeaders };
      },
      readOauthCache: async () => null,
      writeOauthCache: async () => {},
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    assert.equal(haikuOn401, 0);
    assert.equal(on401.status, "unknown");
    assert.match(on401.reason, /401/);
  });

  it("readClaudeOauthToken prefers CLAUDE_CODE_OAUTH_TOKEN over credentials file", async () => {
    const token = await claudeCode.readClaudeOauthToken({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "  sk-ant-oat-FROM-ENV  " },
      credentialsPath: path.join(ROOT, "test", "fixtures", "missing-claude-credentials.json"),
      readText: async () => {
        throw new Error("credentials must not be read when env is set");
      },
    });
    assert.equal(token, "sk-ant-oat-FROM-ENV");
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
    assert.equal(
      verdictForPool(
        routing.pools.claude,
        new Date("2026-09-02T12:45:00.000Z"),
      ).verdict,
      "ok",
    );
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
            id: "openrouter",
            status: "measured",
            usage: 7,
            limit: 100,
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
    await withMissingLocalCollectorSecrets(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [],
      });
      assert.equal(validateSnapshot(snap).ok, true);
      assert.equal(snap.version, "1.8.0");
      assert.equal(snap.sources.length, SOURCE_IDS.length);
      for (const s of snap.sources) {
        assertHonestSource(s);
        if (s.status === "unknown") assert.equal(s.usage, null);
      }
      const openaiSrc = snap.sources.find((s) => s.id === "openai-buzz");
      assert.equal(openaiSrc.name, "OpenAI (ChatGPT/Codex)");
      assert.equal(openaiSrc.unit, "mixed (see components)");
      assert.equal(openaiSrc.usageUrl, "https://chatgpt.com/#settings/Usage");
      const orSrc = snap.sources.find((s) => s.id === "openrouter");
      assert.equal(orSrc.status, "unknown");
      assert.equal(orSrc.usage, null);
      assert.equal(orSrc.usageUrl, "https://openrouter.ai/workspaces/default");
      const sailSrc = snap.sources.find((s) => s.id === "sail");
      assert.equal(sailSrc.status, "unknown");
      assert.equal(sailSrc.usage, null);
      assert.equal(sailSrc.usageUrl, "https://app.sailresearch.com/usage");
    });
  });

  it("normalizeSource keeps OpenAI mixed unit from meta", () => {
    const src = normalizeSource({
      id: "openai-buzz",
      status: "unknown",
      reason: "test",
      usage: null,
    });
    assert.equal(src.name, "OpenAI (ChatGPT/Codex)");
    assert.equal(src.unit, "mixed (see components)");
    assert.equal(src.usageUrl, "https://chatgpt.com/#settings/Usage");
  });

  it("applies schema-validated local overrides into aggregate only", async () => {
    const check = validateLocalOverrides({
      sources: [
        {
          id: "sail",
          status: "estimated",
          usage: 42,
          reason: "manual UI read",
          lastUpdate: "2026-08-31T08:00:00.000Z",
        },
      ],
    });
    assert.equal(check.ok, true);

    const bad = validateLocalOverrides({
      sources: [{ id: "sail", status: "unknown", usage: 1 }],
    });
    assert.equal(bad.ok, false);

    await withMissingLocalCollectorSecrets(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [
          {
            id: "sail",
            status: "estimated",
            usage: 42,
            limit: 100,
            reason: "manual UI read",
            lastUpdate: "2026-08-31T08:00:00.000Z",
          },
        ],
      });
      const sail = snap.sources.find((s) => s.id === "sail");
      assert.equal(sail.status, "estimated");
      assert.equal(sail.usage, 42);
      assert.equal(sail.limit, 100);
      assert.match(sail.reason, /manual UI read/);
      assert.equal(sail.pace.daily, null);
      assert.equal(sail.pace.monthly, null);
    });
  });

  it("stamps every manual override with how old the reading is", () => {
    const base = normalizeSource({
      id: "openrouter",
      status: "unknown",
      reason: "no key",
      usage: null,
    });
    const fresh = applyOverride(
      base,
      {
        id: "openrouter",
        status: "measured",
        usage: 20,
        limit: 100,
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
        id: "openrouter",
        status: "measured",
        usage: 20,
        limit: 100,
        reason: "read from the workspace",
        lastUpdate: "2026-08-30T10:00:00.000Z",
      },
      new Date("2026-08-31T12:00:00.000Z"),
    );
    assert.match(stale.reason, /^STALE: |\bSTALE: /);
    assert.equal(stale.usage, 20);
  });

  it("refuses to let a manual override overwrite an automatic measurement", () => {
    const base = normalizeSource({
      id: "openai-buzz",
      status: "measured",
      collectionMode: "automatic",
      reason: "read from the Codex session log",
      usage: null,
      limit: null,
      unit: "mixed (see components)",
      lastUpdate: "2026-08-31T10:34:53.019Z",
      components: [
        {
          id: "five-hour",
          label: "5-hour",
          role: "capacity",
          usage: 100,
          limit: 100,
          unit: "% of 5-hour Codex limit",
        },
      ],
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
    assert.equal(merged.usage, null);
    assert.equal(merged.components[0].usage, 100);
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

  it("accepts OpenAI capacity vs OpenRouter capped component roles", async () => {
    await withMissingLocalCollectorSecrets(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [
          {
            id: "openai-buzz",
            status: "measured",
            usage: null,
            limit: null,
            reason: "capacity/capped split test",
            lastUpdate: "2026-08-31T08:00:00.000Z",
            usageUrl: "https://chatgpt.com/#settings/Usage",
            components: [
              {
                id: "five-hour",
                label: "5-hour",
                role: "capacity",
                usage: 15,
                limit: 100,
                unit: "% of 5-hour Codex limit",
              },
              {
                id: "weekly",
                label: "Weekly",
                role: "capacity",
                usage: 2,
                limit: 100,
                unit: "% of weekly Codex limit",
              },
            ],
          },
          {
            id: "openrouter",
            status: "measured",
            usage: null,
            limit: null,
            reason: "capped credits test",
            lastUpdate: "2026-08-31T08:00:00.000Z",
            components: [
              {
                id: "credits",
                label: "Credits",
                role: "capped",
                usage: 12.5,
                limit: 50,
                unit: "USD",
              },
            ],
          },
        ],
      });
      const openaiSrc = snap.sources.find((s) => s.id === "openai-buzz");
      assert.equal(openaiSrc.components.length, 2);
      assert.equal(openaiSrc.usageUrl, "https://chatgpt.com/#settings/Usage");
      assert.equal(openaiSrc.usage, null);
      assert.equal(openaiSrc.components[0].role, "capacity");
      assert.equal(openaiSrc.components[0].usage, 15);
      const orSrc = snap.sources.find((s) => s.id === "openrouter");
      assert.equal(orSrc.components[0].role, "capped");
      assert.equal(orSrc.components[0].limit, 50);
    });
  });

  it("rejects unknown component roles", () => {
    assert.equal(
      validateLocalOverrides({
        sources: [
          {
            id: "openai-buzz",
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

  it("defaults OpenAI usageUrl to the ChatGPT usage page", async () => {
    await withMissingLocalCollectorSecrets(async () => {
      const snap = await collectSnapshot(new Date("2026-08-31T10:00:00Z"), {
        overrides: [],
      });
      const openaiSrc = snap.sources.find((s) => s.id === "openai-buzz");
      assert.equal(openaiSrc.usageUrl, "https://chatgpt.com/#settings/Usage");
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
              id === "openai-buzz"
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
    assert.equal(snap.version, "1.8.0");
    assert.equal(snap.sources.length, SOURCE_IDS.length);
    for (const s of snap.sources) {
      if (s.status === "unknown") assert.equal(s.usage, null);
    }
    const openaiSrc = snap.sources.find((s) => s.id === "openai-buzz");
    assert.equal(openaiSrc.name, "OpenAI (ChatGPT/Codex)");
    // Seed may still carry a pre-components unit until the box's first collect.
    assert.equal(typeof openaiSrc.unit, "string");
    assert.match(openaiSrc.usageUrl, /^https:\/\/chatgpt\.com\//);
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
    const openrouter = snap.sources.find((s) => s.id === "openrouter");
    assert.equal(openrouter.usageUrl, "https://openrouter.ai/workspaces/default");
    assert.equal(openrouter.usage, null);
    const sail = snap.sources.find((s) => s.id === "sail");
    assert.equal(sail.usageUrl, "https://app.sailresearch.com/usage");
    assert.equal(sail.usage, null);
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
    assert.match(html, /dashboard\.js\?v=1\.8\.0/);
    assert.match(html, /styles\.css\?v=1\.8\.0/);
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
    assert.match(js, /Box online/);
    assert.match(js, /Box offline/);
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
    assert.equal(online.label, "Box online");
    assert.match(online.title, /Europe\/Amsterdam/);
    const offline = macPresence("2026-09-03T11:30:00.000Z", now);
    assert.equal(offline.online, false);
    assert.equal(offline.label, "Box offline");
    assert.match(offline.title, /Laatste collect/);
    const missing = macPresence(null, now);
    assert.equal(missing.online, false);
    assert.match(missing.label, /Box offline/);
  });

  it("glanceMeter picks hottest capped meter for home", async () => {
    const { glanceMeter } = await import("../site/dashboard.js");
    const pick = glanceMeter({
      components: [
        { id: "a", role: "capacity", usage: 20, limit: 100, label: "Incl" },
        { id: "b", role: "capped", usage: 98, limit: 100, label: "On-demand" },
        { id: "c", role: "capped", usage: 40, limit: 100, label: "Credits" },
      ],
    });
    assert.equal(pick.id, "b");
    assert.equal(pick.label, "On-demand");
  });
});
