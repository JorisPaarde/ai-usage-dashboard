#!/usr/bin/env node
/**
 * Copy static site + latest snapshot into dist/ for GitHub Pages.
 * Fail closed: invalid, dishonest, or secret-looking snapshots refuse publish.
 * Never copies data/local-overrides.json into dist/.
 */
import { cp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublishableSnapshot } from "../collector/lib/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SITE = path.join(ROOT, "site");
const DATA = process.env.AI_USAGE_SNAPSHOT_PATH
  ? path.resolve(process.env.AI_USAGE_SNAPSHOT_PATH)
  : path.join(ROOT, "data", "latest.json");
const OVERRIDES = path.join(ROOT, "data", "local-overrides.json");

const SECRET_RE =
  /sk-[a-zA-Z0-9]{10,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._-]+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|@[\w.-]+\.(com|nl|ai)\b/i;

/** Match site/dashboard.js Amsterdam stamp (nl-NL, 24h). */
function fmtAmsterdamDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function prepareIndexHtml(html, { version, generatedAt, timezone }) {
  const tz = timezone || "Europe/Amsterdam";
  const stamp = fmtAmsterdamDateTime(generatedAt);
  const label = `Laatst bijgewerkt: ${stamp} ${tz}`;
  // Path-versioned script avoids query-string strippers and stale ./app.js caches.
  const scriptSrc = `./d/${version}.js`;
  return html
    .replace(
      /href="\.\/styles\.css(?:\?v=[^"]*)?"/,
      `href="./styles.css?v=${version}"`,
    )
    .replace(
      /src="\.\/(?:app|dashboard)\.js(?:\?v=[^"]*)?"/,
      `src="${scriptSrc}"`,
    )
    .replace(
      /(<p class="last-updated" id="snapshot-meta")([^>]*)>([^<]*)</,
      `$1 data-generated-at="${generatedAt || ""}"$2>${label}<`,
    );
}

async function build() {
  let raw;
  try {
    raw = await readFile(DATA, "utf8");
  } catch (e) {
    throw new Error(
      `Cannot read ${DATA} (fail closed): ${e instanceof Error ? e.message : e}`,
    );
  }

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `data/latest.json is not valid JSON (fail closed): ${e instanceof Error ? e.message : e}`,
    );
  }

  try {
    assertPublishableSnapshot(snapshot);
  } catch (e) {
    throw new Error(
      `Refusing to publish dishonest or invalid snapshot (fail closed): ${e instanceof Error ? e.message : e}`,
    );
  }

  if (SECRET_RE.test(raw)) {
    throw new Error("Refusing to publish data that looks like secrets or emails (fail closed)");
  }

  // Safety: overrides file must never land in dist/.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(SITE, DIST, { recursive: true });
  await mkdir(path.join(DIST, "data"), { recursive: true });
  await writeFile(
    path.join(DIST, "data", "latest.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );

  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const dashboardJs = await readFile(path.join(DIST, "dashboard.js"));
  await mkdir(path.join(DIST, "d"), { recursive: true });
  await writeFile(path.join(DIST, "d", `${pkg.version}.js`), dashboardJs);

  const indexPath = path.join(DIST, "index.html");
  let indexHtml = await readFile(indexPath, "utf8");
  indexHtml = prepareIndexHtml(indexHtml, {
    version: pkg.version,
    generatedAt: snapshot.generatedAt,
    timezone: snapshot.timezone,
  });
  await writeFile(indexPath, indexHtml);
  // Cold path: never previously cached under this filename (browser+CDN).
  await writeFile(path.join(DIST, "go.html"), indexHtml);

  await writeFile(
    path.join(DIST, "data", "build-meta.json"),
    `${JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );

  try {
    await access(path.join(DIST, "data", "local-overrides.json"));
    throw new Error("local-overrides.json leaked into dist/ (fail closed)");
  } catch (e) {
    if (e && e.message?.includes("leaked")) throw e;
    // ENOENT expected
  }

  // Extra guard if someone left overrides next to site by mistake — not copied above.
  void OVERRIDES;

  console.log(`Built ${DIST} (v${pkg.version})`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
