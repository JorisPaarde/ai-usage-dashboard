#!/usr/bin/env node
/**
 * Local Mac app server for on-demand collect + viewing the dashboard.
 *
 * Binds 127.0.0.1 only. Serves the built site (or site/ + data/) and exposes:
 *   GET  /api/health  → { ok, collect: true }
 *   POST /api/collect → kickstarts the LaunchAgent (or runs local-snapshot.sh)
 *
 * NEVER invokes Codex, Grok, cloud agents, or browser bots.
 * NEVER call this from github.io (HTTPS → HTTP localhost is blocked).
 * Open http://127.0.0.1:8787/ for the on-demand collect button path.
 *
 * No secrets on the wire. Collector itself stays LLM-free.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HOST = process.env.AI_USAGE_APP_HOST || "127.0.0.1";
const PORT = Number(process.env.AI_USAGE_APP_PORT || 8787);
const LABEL = "nl.jpwebcreation.ai-usage-dashboard";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let collectBusy = false;

async function resolveStaticRoot() {
  const dist = path.join(ROOT, "dist");
  try {
    await access(path.join(dist, "index.html"));
    return dist;
  } catch {
    return path.join(ROOT, "site");
  }
}

async function readBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/**
 * Prefer kickstarting the installed LaunchAgent (same path as the schedule).
 * Fall back to running local-snapshot.sh directly in this checkout.
 * Never shells out to `codex`, agents, or browsers.
 */
function triggerCollect() {
  return new Promise((resolve) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const target = uid != null ? `gui/${uid}/${LABEL}` : LABEL;
    const child = spawn("launchctl", ["kickstart", "-k", target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => {
      runSnapshotScript().then(resolve);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          via: "launchctl",
          message: "LaunchAgent collect gestart.",
        });
        return;
      }
      runSnapshotScript().then(resolve);
    });
  });
}

function runSnapshotScript() {
  return new Promise((resolve) => {
    const script = path.join(ROOT, "scripts", "local-snapshot.sh");
    const child = spawn("/bin/sh", [script], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("error", (e) => {
      resolve({
        ok: false,
        via: "script",
        message: e.message || "local-snapshot failed to start",
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        via: "script",
        message:
          code === 0
            ? "local-snapshot voltooid."
            : `local-snapshot exit ${code}: ${(err || out).trim().slice(0, 240)}`,
      });
    });
  });
}

async function serveFile(res, filePath) {
  const data = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control":
      ext === ".html" || ext === ".json" ? "no-store" : "public, max-age=60",
  });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (url.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      collect: true,
      host: HOST,
      port: PORT,
      busy: collectBusy,
    });
    return;
  }

  if (url.pathname === "/api/collect" && req.method === "POST") {
    try {
      await readBody(req);
    } catch {
      json(res, 413, { ok: false, message: "body too large" });
      return;
    }
    if (collectBusy) {
      json(res, 409, { ok: false, message: "Collect al bezig." });
      return;
    }
    collectBusy = true;
    try {
      const result = await triggerCollect();
      json(res, result.ok ? 202 : 500, result);
    } finally {
      collectBusy = false;
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { ok: false, message: "method not allowed" });
    return;
  }

  const root = await resolveStaticRoot();
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  let filePath = path.join(root, rel);
  if (root.endsWith(`${path.sep}site`) && rel.startsWith("/data/")) {
    filePath = path.join(ROOT, rel.slice(1));
  }
  const resolved = path.resolve(filePath);
  const allowedRoots = [path.resolve(root), path.join(ROOT, "data")];
  if (
    !allowedRoots.some(
      (base) => resolved === base || resolved.startsWith(base + path.sep),
    )
  ) {
    json(res, 403, { ok: false, message: "forbidden" });
    return;
  }
  try {
    const st = await stat(resolved);
    if (!st.isFile()) {
      json(res, 404, { ok: false, message: "not found" });
      return;
    }
    await serveFile(res, resolved);
  } catch {
    json(res, 404, { ok: false, message: "not found" });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    json(res, 500, { ok: false, message: "internal error" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`AI Usage local app http://${HOST}:${PORT}/`);
  console.log(
    `Collect: POST http://${HOST}:${PORT}/api/collect (LaunchAgent / local-snapshot only)`,
  );
});
