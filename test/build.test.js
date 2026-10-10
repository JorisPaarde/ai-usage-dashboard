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
    await access(path.join(DIST, "dashboard.js"));
    await access(path.join(DIST, "app.js"));
    await access(path.join(DIST, "d", "1.9.0.js"));
    await access(path.join(DIST, "go.html"));
    const indexHtml = await readFile(path.join(DIST, "index.html"), "utf8");
    assert.match(indexHtml, /d\/1\.9\.0\.js/);
    assert.match(indexHtml, /styles\.css\?v=1\.9\.0/);
    assert.match(indexHtml, /Laatst bijgewerkt:/);
    assert.match(indexHtml, /mac-badge/);
    assert.match(indexHtml, /Alles updaten/);
    assert.doesNotMatch(indexHtml, /src="\.\/app\.js"/);
    const goHtml = await readFile(path.join(DIST, "go.html"), "utf8");
    assert.match(goHtml, /Laatst bijgewerkt:/);
    assert.match(goHtml, /d\/1\.9\.0\.js/);
    const latest = await readFile(path.join(DIST, "data", "latest.json"), "utf8");
    const meta = JSON.parse(
      await readFile(path.join(DIST, "data", "build-meta.json"), "utf8"),
    );
    assert.equal(JSON.parse(latest).version, "1.9.0");
    assert.equal(meta.version, "1.9.0");
    // The built site must not ship a local percentage while the metric is held.
    assert.ok(JSON.parse(latest).routing);
    assert.equal(JSON.parse(latest).routing.today.percent, null);
    assert.equal(JSON.parse(latest).routing.runtimeEvidence, null);
    assert.match(JSON.parse(latest).routing.reason, /not runtime evidence/);
    const appJs = await readFile(path.join(DIST, "dashboard.js"), "utf8");
    assert.match(appJs, /renderRoutingCard/);
    assert.match(appJs, /Local share/);
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

  it("hosted workflows must never run the collector", async () => {
    const { code, out, err } = await run("node", [
      "scripts/assert-no-hosted-meter.js",
    ]);
    assert.equal(code, 0, err || out);
    assert.match(out, /assert-no-hosted-meter: ok/);
    const collectYml = await readFile(
      path.join(ROOT, ".github", "workflows", "collect.yml"),
      "utf8",
    );
    assert.doesNotMatch(collectYml, /^\s*schedule\s*:/m);
    assert.doesNotMatch(collectYml, /npm\s+run\s+collect/);
    assert.match(collectYml, /npm run check/);
  });

  it("local Mac app helpers are retired; mac-snapshot LaunchAgent is present", async () => {
    await assert.rejects(() =>
      access(path.join(ROOT, "scripts", "local-app-server.js")),
    );
    await assert.rejects(() =>
      access(path.join(ROOT, "scripts", "install-local-app.sh")),
    );
    await access(path.join(ROOT, "scripts", "mac-snapshot.sh"));
    await access(
      path.join(
        ROOT,
        "docs",
        "nl.jpwebcreation.ai-usage-dashboard.plist.example",
      ),
    );
    const pkg = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    );
    assert.equal(pkg.scripts.app, undefined);
    assert.equal(pkg.scripts["collect:mac"], "node collector/index.js --mac");
    const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
    assert.doesNotMatch(readme, /npm run app|local-app-server|\/api\/collect/);
    assert.match(readme, /mac-snapshot\.sh/);
    const macSh = await readFile(
      path.join(ROOT, "scripts", "mac-snapshot.sh"),
      "utf8",
    );
    assert.match(macSh, /mkdir "\$LOCK"/);
    assert.match(macSh, /npm run collect:mac/);
    assert.match(macSh, /npm run check/);
    assert.match(macSh, /git add data\/mac-sources\.json/);
    assert.doesNotMatch(macSh, /git add data\/latest\.json/);
    assert.match(macSh, /git reset --hard origin\/main/);
    assert.match(macSh, /git rebase origin\/main/);
  });

  it("box snapshot pushes via gh auth without a token env var", async () => {
    const src = await readFile(
      path.join(ROOT, "scripts", "box-snapshot.sh"),
      "utf8",
    );
    assert.match(src, /set -euo pipefail/);
    assert.match(src, /\$\{HOME\}\/\.local\/bin/);
    assert.match(src, /flock -n 9/);
    assert.match(src, /\.box-snapshot\.lock/);
    assert.match(src, /gh auth status/);
    assert.match(src, /git fetch origin main/);
    assert.match(src, /git reset --hard origin\/main/);
    assert.doesNotMatch(src, /git merge --ff-only/);
    assert.doesNotMatch(src, /mkdir "\$LOCK"/);
    assert.match(src, /npm run collect \|\| ! npm run routing/);
    assert.match(src, /npm run check/);
    assert.match(src, /git add data\/latest\.json data\/routing\.json/);
    assert.match(src, /git push origin HEAD:main/);
    assert.match(src, /No snapshot change/);
    assert.match(src, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(src, /\.claude-oauth-token/);
    assert.match(src, /ai-usage-dashboard\/env/);
    assert.doesNotMatch(src, /AI_USAGE_GH_TOKEN/);
    assert.doesNotMatch(src, /AI_USAGE_GH_BRANCH/);
    // One-time setup may be mentioned in comments; must not run on each tick.
    assert.doesNotMatch(src, /^\s*gh auth setup-git/m);
    assert.doesNotMatch(src, /x-access-token|Bearer \$\{/);
  });

});
