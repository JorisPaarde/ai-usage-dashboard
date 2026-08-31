import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptySource, SOURCE_IDS } from "../collector/lib/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      resolve({ code, out, err });
    });
  });
}

describe("build", () => {
  before(async () => {
    await rm(DIST, { recursive: true, force: true });
  });

  after(async () => {
    // leave dist for manual inspection after npm run check
  });

  it("emits dist with site assets and snapshot, no overrides leak", async () => {
    const { code, err, out } = await run("node", ["scripts/build.js"]);
    assert.equal(code, 0, err || out);
    await access(path.join(DIST, "index.html"));
    await access(path.join(DIST, "styles.css"));
    await access(path.join(DIST, "app.js"));
    const latest = await readFile(path.join(DIST, "data", "latest.json"), "utf8");
    const meta = JSON.parse(
      await readFile(path.join(DIST, "data", "build-meta.json"), "utf8"),
    );
    assert.equal(JSON.parse(latest).version, "1.2.2");
    assert.equal(meta.version, "1.2.2");
    await assert.rejects(() =>
      access(path.join(DIST, "data", "local-overrides.json")),
    );
    const html = await readFile(path.join(DIST, "index.html"), "utf8");
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/i);
  });

  it("rejects dishonest source records on publish boundary", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "ai-usage-bad-"));
    const badPath = path.join(tmp, "latest.json");
    const bad = {
      version: "1.1.0",
      generatedAt: "2026-08-31T10:00:00.000Z",
      timezone: "Europe/Amsterdam",
      sources: SOURCE_IDS.map((id) =>
        emptySource({
          id,
          status: "unknown",
          reason: "n/a",
          usage: id === "openai-buzz" ? 99 : null,
        }),
      ),
    };
    await writeFile(badPath, `${JSON.stringify(bad, null, 2)}\n`);
    const { code, err } = await run("node", ["scripts/build.js"], {
      AI_USAGE_SNAPSHOT_PATH: badPath,
    });
    assert.notEqual(code, 0);
    assert.match(err, /fail closed|dishonest|unknown sources must not/i);
  });
});
