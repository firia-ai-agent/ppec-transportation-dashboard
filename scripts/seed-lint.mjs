#!/usr/bin/env node
// Seed linter (synthetic-seed-data-rules, ADR-015). Scans src/, fixtures/, scripts/ for
// identities outside the synthetic allowlists. Exit 1 on any hit.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "fixtures", "scripts"];
const SKIP = /node_modules|\.next|seed-lint/;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const ALLOWED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net"]);
const PHONE = /\+?1?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})\b/g;

// Full UUIDs and UUID prefixes (fixture ids are built from a template literal: see src/modules/demo/fixtures).
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}/gi;

/**
 * Landmark-only coordinates (MOCKS-AND-DEMO §1 "a seed linter rejects any coordinate not in this
 * table", ADR-015). Any number with two integer digits and 4+ decimals is read as a coordinate.
 * The list is the §1 table plus the center / depot point.
 */
const COORD = /-?\d{2}\.\d{4,}/g;
const ALLOWED_COORDS = new Set([
  "26.645352", "-80.145541",  // center, 2216 Jog Rd (also ops.site depot)
  "26.622639", "-80.145953",  // Greenacres Branch Library
  "26.652165", "-80.164767",  // Okeeheelee Park
  "26.607061", "-80.135511",  // Greenacres City Hall
  "26.602482", "-80.080532",  // John Prince Park
  "26.613772", "-80.085865",  // Palm Beach State College, Lake Worth
  "26.584699", "-80.052871",  // Lantana Public Library
  "26.535418", "-80.095675",  // Boynton Beach Mall
  "26.646683", "-80.208099",  // Mall at Wellington Green
  "26.667739", "-80.069543",  // Palm Beach Zoo (fault-scenario detour)
]);

export function lintText(raw, file = "<text>") {
  const hits = [];
  const text = raw.replace(UUID, "<uuid>"); // UUIDs are not phone numbers
  for (const m of text.matchAll(COORD)) {
    if (!ALLOWED_COORDS.has(m[0])) hits.push(`${file}: coordinate not in the MOCKS §1 landmark table: ${m[0]}`);
  }
  for (const m of text.matchAll(EMAIL)) {
    const d = m[1].toLowerCase();
    if (!ALLOWED_EMAIL_DOMAINS.has(d) && !d.endsWith(".example") && d !== "users.noreply.github.com")
      hits.push(`${file}: email domain not allowed: ${d}`);
  }
  for (const m of text.matchAll(PHONE)) {
    const [, , exch, line] = m;
    if (!(exch === "555" && /^01\d\d$/.test(line))) hits.push(`${file}: phone outside 555-01xx: ${m[0].trim()}`);
  }
  return hits;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json|csv|sql)$/.test(p) && !/\.test\./.test(p)) out.push(p);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = [];
  for (const r of ROOTS) if (existsSync(r)) walk(r, files);
  const hits = files.flatMap((f) => lintText(readFileSync(f, "utf8"), f));
  if (hits.length) {
    console.error(hits.join("\n"));
    process.exit(1);
  }
  console.log(`seed-lint: ${files.length} files clean`);
}
