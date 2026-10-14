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

export function lintText(text, file = "<text>") {
  const hits = [];
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
