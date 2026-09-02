#!/usr/bin/env node
/**
 * Fail closed if any GitHub Actions workflow would run the local collector.
 * Hosted runners cannot measure authenticated desktop usage; only the Mac
 * LaunchAgent (scripts/local-snapshot.sh) may publish live meters.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

/** Steps that would meter or rewrite the public snapshot on a hosted runner. */
const FORBIDDEN = [
  /npm\s+run\s+collect\b/,
  /node\s+collector\b/,
  /local-snapshot\.sh/,
  /install-launch-agent\.sh/,
];

/** Drop YAML comments so documentation cannot trip the guard. */
function withoutComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const hash = line.indexOf("#");
      if (hash === -1) return line;
      // Keep # inside quoted strings roughly; for our workflows comments are line-leading or trailing prose.
      const before = line.slice(0, hash);
      if ((before.match(/"/g) || []).length % 2 === 1) return line;
      return before;
    })
    .join("\n");
}

async function main() {
  const files = (await readdir(WORKFLOWS)).filter((f) => /\.ya?ml$/i.test(f));
  const violations = [];
  for (const file of files) {
    const raw = await readFile(path.join(WORKFLOWS, file), "utf8");
    const text = withoutComments(raw);
    for (const re of FORBIDDEN) {
      if (re.test(text)) {
        violations.push(`${file} matches ${re}`);
      }
    }
    // Scheduled collect-as-meter is forbidden; validate-only schedules are also
    // discouraged — collect.yml must stay workflow_dispatch-only.
    if (file === "collect.yml" && /^\s*schedule\s*:/m.test(text)) {
      violations.push("collect.yml must not use schedule: (validate-only)");
    }
  }
  if (violations.length) {
    console.error("Hosted workflows must not run the collector:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`assert-no-hosted-meter: ok (${files.length} workflow files)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
