#!/usr/bin/env node
/**
 * Copy static site + latest snapshot into dist/ for GitHub Pages.
 */
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSnapshot } from "../collector/lib/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SITE = path.join(ROOT, "site");
const DATA = path.join(ROOT, "data", "latest.json");

async function build() {
  const raw = await readFile(DATA, "utf8");
  const snapshot = JSON.parse(raw);
  const check = validateSnapshot(snapshot);
  if (!check.ok) {
    throw new Error(`Refusing to publish invalid snapshot: ${check.errors.join("; ")}`);
  }
  if (/sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]+/i.test(raw)) {
    throw new Error("Refusing to publish data that looks like secrets");
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(SITE, DIST, { recursive: true });
  await mkdir(path.join(DIST, "data"), { recursive: true });
  await writeFile(path.join(DIST, "data", "latest.json"), `${JSON.stringify(snapshot, null, 2)}\n`);

  // Package version stamp for the site footer.
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  await writeFile(
    path.join(DIST, "data", "build-meta.json"),
    `${JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );

  console.log(`Built ${DIST} (v${pkg.version})`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
