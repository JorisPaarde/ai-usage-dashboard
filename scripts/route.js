#!/usr/bin/env node
/**
 * route() — pick a lane for one task and dispatch it.
 *
 * The routing decision is a lookup, so it lives in code and costs no tokens.
 * Order of operations matters: measure first, then decide. Waiting for the
 * 15-minute tick would let a decision rest on a quarter-hour-old reading, and
 * a pool can go from comfortable to full inside that window.
 *
 *   1. collect            fresh measurement (skip with --no-collect)
 *   2. routing.json       capacity facts per pool
 *   3. verdicts           computed now, against each pool's own maxAge
 *   4. pick               lane order filtered by task.quality
 *   5. dispatch           via the configured command
 *   6. on quota error     block that pool, retry the next candidate
 *   7. runlog             one line per attempt, outside the repo
 *
 * Dispatch is intentionally a thin shim: Buzz has no agent-invocation step
 * (block/buzz#3871), so the command that wakes an agent is configured rather
 * than assumed. Verify it once against buzz-cli, then it never changes.
 *
 * Usage:
 *   node scripts/route.js --task task.json            # plan only (default)
 *   node scripts/route.js --task task.json --execute  # plan and dispatch
 *   echo '{...}' | node scripts/route.js --execute
 *
 * Env:
 *   AI_ROUTER_DISPATCH_CMD  command template; {agent} and {taskFile} are
 *                           substituted. Required for --execute.
 *   AI_ROUTER_STATE_DIR     default ~/.config/ai-usage-dashboard
 */
import { readFile, writeFile, mkdir, appendFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSnapshot, writeSnapshot } from "../collector/index.js";
import { poolsFromSnapshot, verdictsFor } from "../collector/lib/routing.js";
import { validateTask, pickPool, candidatesFor } from "../collector/lib/lanes.js";
import { writeRouting, ROUTING_FILE } from "./write-routing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STATE_DIR =
  process.env.AI_ROUTER_STATE_DIR ||
  path.join(os.homedir(), ".config", "ai-usage-dashboard");
export const BLOCKS_FILE = path.join(STATE_DIR, "pool-blocks.json");
/** Outside the repo on purpose: task text may name clients, and data/ is published. */
export const RUNLOG_FILE = path.join(STATE_DIR, "runlog.jsonl");

/** A provider saying "no more" — the one signal that can never be stale. */
export const QUOTA_RE =
  /\b429\b|rate[ _-]?limit|usage limit|quota|out of credit|insufficient (?:credit|balance)|too many requests/i;

/** How long a pool stays blocked when the provider gave no reset time. */
export const DEFAULT_BLOCK_MINUTES = 60;

export async function loadBlocks(file = BLOCKS_FILE) {
  try {
    await access(file);
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupt block file must not silently unblock a pool.
    return {};
  }
}

/**
 * Record an observed quota error. This is the reactive trigger: it outranks
 * every measurement, including one taken seconds ago.
 * @param {string} pool
 * @param {string} reason
 */
export async function blockPool(pool, reason, opts = {}) {
  const file = opts.file || BLOCKS_FILE;
  const now = opts.now || new Date();
  const minutes = opts.minutes ?? DEFAULT_BLOCK_MINUTES;
  const blocks = await loadBlocks(file);
  blocks[pool] = {
    until: new Date(now.getTime() + minutes * 60000).toISOString(),
    reason,
    observedAt: now.toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(blocks, null, 2)}\n`, "utf8");
  return blocks;
}

/**
 * @param {object} entry
 */
export async function appendRunlog(entry, file = RUNLOG_FILE) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Run the configured dispatch command for one agent.
 * @param {{agent: string, taskFile: string, template: string}} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runDispatch({ agent, taskFile, template }) {
  const cmd = template
    .replaceAll("{agent}", agent)
    .replaceAll("{taskFile}", taskFile);
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Plan a route for one task. Pure given (task, facts, blocks, now).
 * @param {object} task
 * @param {object} facts
 * @param {Date} now
 * @param {object} blocks
 */
export function planRoute(task, facts, now = new Date(), blocks = {}) {
  const check = validateTask(task);
  if (!check.ok) {
    throw new Error(`Unroutable task (fail closed): ${check.errors.join("; ")}`);
  }
  const verdicts = verdictsFor(facts, now, blocks);
  const pick = pickPool(task, verdicts, facts.pools);
  return {
    taskId: task.id,
    type: task.type,
    quality: task.quality,
    decidedAt: now.toISOString(),
    pool: pick.pool,
    agent: pick.agent,
    reason: pick.reason,
    considered: pick.considered,
    fallbackOrder: candidatesFor(task).filter((p) => p !== pick.pool),
    verdicts,
  };
}

function parseArgs(argv) {
  const args = { execute: false, collect: true, taskFile: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--no-collect") args.collect = false;
    else if (a === "--task") args.taskFile = argv[++i];
    else if (a === "--json") args.json = argv[++i];
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function loadTask(args) {
  if (args.taskFile) return JSON.parse(await readFile(args.taskFile, "utf8"));
  if (args.json) return JSON.parse(args.json);
  const text = await readStdin();
  if (!text) throw new Error("No task given (--task file, --json, or stdin).");
  return JSON.parse(text);
}

/**
 * Full run: measure, decide, dispatch, retry on quota error, log.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const task = await loadTask(args);

  if (args.collect) {
    const snapshot = await collectSnapshot();
    await writeSnapshot(snapshot);
  }
  await writeRouting();

  const facts = JSON.parse(await readFile(ROUTING_FILE, "utf8"));
  const blocks = await loadBlocks();
  const now = new Date();
  const plan = planRoute(task, facts, now, blocks);

  if (!args.execute) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (!plan.pool) {
    await appendRunlog({ ...plan, outcome: "no-lane" });
    console.error(plan.reason);
    process.exitCode = 2;
    return plan;
  }

  const template = process.env.AI_ROUTER_DISPATCH_CMD;
  if (!template) {
    throw new Error(
      "AI_ROUTER_DISPATCH_CMD is not set. Set the command that wakes a Buzz " +
        "agent, using {agent} and {taskFile}, e.g. " +
        "'buzz-cli agent invoke --agent {agent} --input {taskFile}'.",
    );
  }

  const taskFile = path.join(STATE_DIR, `task-${task.id}.json`);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(taskFile, `${JSON.stringify(task, null, 2)}\n`, "utf8");

  const order = [plan.pool, ...plan.fallbackOrder];
  let lastResult = null;
  for (const pool of order) {
    const agent = facts.pools[pool]?.agent;
    if (!agent) continue;
    const startedAt = Date.now();
    const result = await runDispatch({ agent, taskFile, template });
    const durationMs = Date.now() - startedAt;
    const combined = `${result.stdout}\n${result.stderr}`;
    const quota = result.code !== 0 && QUOTA_RE.test(combined);

    await appendRunlog({
      taskId: task.id,
      type: task.type,
      quality: task.quality,
      pool,
      agent,
      decidedAt: plan.decidedAt,
      reason: pool === plan.pool ? plan.reason : `Fallback after ${lastResult?.pool} hit quota.`,
      verdict: plan.verdicts[pool]?.verdict ?? null,
      exitCode: result.code,
      durationMs,
      outcome: result.code === 0 ? "ok" : quota ? "quota" : "error",
    });

    if (result.code === 0) {
      console.log(`Dispatched ${task.id} to ${agent} (${pool}).`);
      return { ...plan, dispatchedTo: pool, outcome: "ok" };
    }
    lastResult = { pool, result };
    if (!quota) {
      console.error(`Dispatch to ${agent} failed (exit ${result.code}).`);
      process.exitCode = 1;
      return { ...plan, dispatchedTo: pool, outcome: "error" };
    }
    await blockPool(pool, `Dispatch to ${agent} returned a quota error.`, { now });
    console.error(`${pool} is out of quota; trying the next lane.`);
  }

  console.error("Every lane in the fallback order returned a quota error.");
  process.exitCode = 2;
  return { ...plan, outcome: "exhausted" };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

void ROOT;
