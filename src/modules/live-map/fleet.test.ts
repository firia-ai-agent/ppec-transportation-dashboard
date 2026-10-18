/**
 * THE DEMO HAS EXACTLY 3 VANS.
 *
 * Layer 2 (behaviour), per /workspace/ppec-redesign/MOCKUP-TEST-CONTRACT.md. The rule is a named
 * ruling and it is quoted where it is asserted:
 *
 * > **Firia, 2026-10-18:** the demo has exactly 3 vans — #73's seed removes the spare van and
 * > makes Van 3 a generic van. The map must not draw a 4th "reserve" van, and nothing on this
 * > branch may reference slot 4 or V4 for the map.
 *
 * Vera's 12:30 AM ET walk is why it needs a test rather than a comment. The map used to read
 * `DEMO_RUNS` — #53's *four*-run fixture — and drop the fourth at render time, by whether its
 * device happened to be bound. A fleet that is three vans because one of them is invisible is
 * one fixture edit away from being four, and nothing would have failed.
 *
 * So these assert the fleet at the source and at the screen's own data: three entries, three
 * vans out of the day at any instant of the clock, and no V4 anywhere in the module.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_RUN_SECONDS } from "@/fixtures/replays";
import { liveDayAt } from "./day";
import { LIVE_FLEET, LIVE_FLEET_SIZE, LIVE_FLEET_VEHICLE_IDS, VAN_3_ROUTE } from "./fleet";

describe("the fleet is three vans (Firia, 2026-10-18)", () => {
  it("has exactly three entries", () => {
    expect(LIVE_FLEET).toHaveLength(3);
    expect(LIVE_FLEET_SIZE).toBe(3);
  });

  it("is Van 1, Van 2 and Van 3, in the order they are numbered on screen", () => {
    expect([...LIVE_FLEET_VEHICLE_IDS]).toEqual(["V1", "V2", "V3"]);
  });

  /* No spare, no reserve, no slot 4 — named one at a time, so a fourth van fails on the van. */
  it("has no fourth van and no slot 4", () => {
    expect(LIVE_FLEET_VEHICLE_IDS).not.toContain("V4");
    expect(LIVE_FLEET[3]).toBeUndefined();
    expect(new Set(LIVE_FLEET_VEHICLE_IDS).size).toBe(3);
  });

  /*
   * Van 3 is a GENERIC van, which is the half of the ruling a count cannot catch. #53's third
   * run was `route2-substitute`: the reserve van's road, given route 2's own geometry so the two
   * could not drift. Van 3 drives route 1 now — a real run with nobody on it once the spare is
   * gone — so no two vans share a line and png/live-map.png's three separate roads are three.
   */
  it("gives Van 3 a road of its own rather than the substitute's", () => {
    expect(VAN_3_ROUTE.vehicleId).toBe("V3");
    expect(VAN_3_ROUTE.id).not.toMatch(/substitute/);
    const roads = LIVE_FLEET.map((van) => van.spec.route.id);
    expect(new Set(roads).size, `two vans share a road: ${roads.join(", ")}`).toBe(3);
  });

  it("drives three distinct geometries, so no van's line hides under another's", () => {
    const shapes = LIVE_FLEET.map((van) => JSON.stringify(van.spec.route.stops.map((s) => s.id)));
    expect(new Set(shapes).size).toBe(3);
  });
});

describe("the screen's own day yields three vans, at every instant of the clock", () => {
  /*
   * Walked rather than sampled: the old fleet was three vans *at render time* because the fourth
   * was filtered, and the filter depended on the clock. If a fourth van can ever appear, it
   * appears at some second of the day, so every second of the day is where this looks.
   */
  it("never draws more or fewer than three, anywhere in the run", () => {
    for (let seconds = 0; seconds <= DEMO_RUN_SECONDS; seconds += 15) {
      const day = liveDayAt(seconds, { tween: true });
      expect(day.vans, `at ${seconds}s`).toHaveLength(3);
      expect(day.counts.all, `at ${seconds}s`).toBe(3);
      expect(day.vans.map((van) => van.number).sort(), `at ${seconds}s`).toEqual([1, 2, 3]);
    }
  });

  it("numbers them 1, 2, 3 with no gap, whatever order the list is sorted into", () => {
    const day = liveDayAt(830, { tween: true });
    expect([...day.vans].sort((a, b) => a.number - b.number).map((v) => v.id)).toEqual([
      "V1",
      "V2",
      "V3",
    ]);
  });

  /* The feed names a van by its number too, so a fourth could not sneak in through that door. */
  it("never names a fourth van in the Auto texts feed", () => {
    for (let seconds = 0; seconds <= DEMO_RUN_SECONDS; seconds += 30) {
      for (const row of liveDayAt(seconds, { tween: true, familyLabels: true }).feed) {
        expect([1, 2, 3], `at ${seconds}s`).toContain(row.vanNumber);
      }
    }
  });
});

/**
 * And the module says nothing about a fourth van at all.
 *
 * "The map must not draw a 4th van" is a rule about the screen; "nothing on this branch may
 * reference slot 4 or V4 for the map" is a rule about the code, and only a grep can hold it.
 * This reads every source file of the live map and fails on a V4 or a fourth colour slot —
 * including in a comment, because a comment is where the next person looks for permission.
 */
describe("no part of the live map references slot 4", () => {
  const DIR = __dirname;
  const sources = readdirSync(DIR)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
    .map((f) => ({ file: f, text: readFileSync(path.join(DIR, f), "utf8") }));

  it("has sources to scan, so a broken walk cannot pass silently", () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  it.each(["V4", "van4", "route2-substitute", "SUBSTITUTE_ROUTE", "DEMO_RUNS"])(
    "names no %s",
    (needle) => {
      const offenders = sources
        .filter(({ text }) => text.includes(needle))
        // fleet.ts and day.ts explain in prose why they do NOT read the four-run fixture; the
        // explanation is the one place the name is allowed, and only inside a comment.
        .filter(({ text }) => {
          const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
          return code.includes(needle);
        })
        .map(({ file }) => file);
      expect(offenders, `${needle} is referenced in live-map code`).toEqual([]);
    },
  );
});
