import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err || out}`));
    });
  });
}

describe("build", () => {
  before(async () => {
    await rm(DIST, { recursive: true, force: true });
  });

  after(async () => {
    // leave dist for manual inspection after npm run check; cleanup only on failure path
  });

  it("emits dist with site assets and snapshot", async () => {
    await run("node", ["scripts/build.js"]);
    await access(path.join(DIST, "index.html"));
    await access(path.join(DIST, "styles.css"));
    await access(path.join(DIST, "app.js"));
    const latest = await readFile(path.join(DIST, "data", "latest.json"), "utf8");
    const meta = JSON.parse(
      await readFile(path.join(DIST, "data", "build-meta.json"), "utf8"),
    );
    assert.equal(JSON.parse(latest).version, "1.0.0");
    assert.equal(meta.version, "1.0.0");
  });
});
