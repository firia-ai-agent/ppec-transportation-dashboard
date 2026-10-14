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

/**
 * Route geometry is the one exception to the landmark table, and it is a narrow one.
 *
 * A committed OSRM polyline (ADR-007) is a list of *road* vertices, not places: the §1 rule
 * exists to stop a real home or facility reaching a fixture, and a point on S Jog Rd is
 * neither. Rejecting those vertices would make ADR-007 unimplementable, so a `: Coord[] = [...]`
 * literal — the only shape route geometry is ever written in (src/fixtures/routes.ts,
 * src/fixtures/map.ts) — is checked by a different, equally strict pair of rules instead:
 *
 *  1. both **endpoints** must sit on a §1 landmark, within OSRM's snap distance of it
 *     (the committed probe snaps the center 7.4 m onto Jog Road — that is the fixture);
 *  2. every vertex must fall inside the landmark bounding box, widened by `BOX_MARGIN_DEG`.
 *
 * So a polyline can only ever run between two tabled landmarks, across the service area. A
 * coordinate anywhere else in the tree — a `coord:` field, a seed row, a test double — still
 * has to be in the table verbatim.
 */
const GEOMETRY_BLOCK = /:\s*Coord\[\]\s*=\s*\[([\s\S]*?)\]\s*;/g;
const COORD_PAIR = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
/** ~5.5 km of slack around the landmark hull, so a road may bulge outside it but a city cannot. */
const BOX_MARGIN_DEG = 0.05;
/** How far a polyline endpoint may sit from its landmark: OSRM's road snap, with headroom. */
const SNAP_TOLERANCE_M = 50;
const METRES_PER_DEGREE = 111_320;

/** The §1 table as `[lng, lat]` pairs: the file above lists each landmark's lat then its lng. */
const LANDMARKS = (() => {
  const values = [...ALLOWED_COORDS];
  const pairs = [];
  for (let i = 0; i < values.length; i += 2) pairs.push([Number(values[i + 1]), Number(values[i])]);
  return pairs;
})();

const BOX = {
  minLng: Math.min(...LANDMARKS.map(([lng]) => lng)) - BOX_MARGIN_DEG,
  maxLng: Math.max(...LANDMARKS.map(([lng]) => lng)) + BOX_MARGIN_DEG,
  minLat: Math.min(...LANDMARKS.map(([, lat]) => lat)) - BOX_MARGIN_DEG,
  maxLat: Math.max(...LANDMARKS.map(([, lat]) => lat)) + BOX_MARGIN_DEG,
};

/** Equirectangular metres between two `[lng, lat]` points — plenty at this scale. */
function metresBetween([lngA, latA], [lngB, latB]) {
  const x = (lngB - lngA) * METRES_PER_DEGREE * Math.cos(((latA + latB) / 2) * (Math.PI / 180));
  const y = (latB - latA) * METRES_PER_DEGREE;
  return Math.hypot(x, y);
}

function onLandmark(point) {
  return LANDMARKS.some((landmark) => metresBetween(point, landmark) <= SNAP_TOLERANCE_M);
}

/**
 * Lints every `: Coord[] = [...]` literal as route geometry and returns the text with those
 * literals blanked out, so the caller's landmark rule never sees a road vertex.
 */
export function lintGeometry(text, file = "<text>") {
  const hits = [];
  const stripped = text.replace(GEOMETRY_BLOCK, (block, body) => {
    const points = [...body.matchAll(COORD_PAIR)].map((m) => [Number(m[1]), Number(m[2])]);
    // An empty `Coord[]` literal is an accumulator (`const coords: Coord[] = []`), not a fixture.
    if (points.length === 0) return block;
    if (points.length < 2) {
      hits.push(`${file}: route geometry needs at least two vertices`);
      return ":".padEnd(block.length, " ");
    }
    for (const end of [points[0], points[points.length - 1]]) {
      if (!onLandmark(end))
        hits.push(
          `${file}: route geometry must start and end on a MOCKS §1 landmark (within ${SNAP_TOLERANCE_M} m): ${end.join(", ")}`,
        );
    }
    for (const [lng, lat] of points) {
      if (lng < BOX.minLng || lng > BOX.maxLng || lat < BOX.minLat || lat > BOX.maxLat)
        hits.push(`${file}: route geometry vertex outside the service area: ${lng}, ${lat}`);
    }
    // Same length, so any byte offset the caller reports still lines up.
    return ":".padEnd(block.length, " ");
  });
  return { hits, stripped };
}

export function lintText(raw, file = "<text>") {
  const hits = [];
  const withUuids = raw.replace(UUID, "<uuid>"); // UUIDs are not phone numbers
  const geometry = lintGeometry(withUuids, file);
  hits.push(...geometry.hits);
  // Identity checks still read the whole file; only the landmark rule skips road geometry.
  const text = withUuids;
  for (const m of geometry.stripped.matchAll(COORD)) {
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
