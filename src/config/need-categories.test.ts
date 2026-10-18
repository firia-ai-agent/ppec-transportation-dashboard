import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_OF_PANEL_FLAG, FLAG_OF_CATEGORY, NEED_CATEGORY, PANEL_CATEGORIES } from "./equipment";

/**
 * Veri + Firia's gate (a), 2026-10-17 7:27 PM ET: the three need categories the board writes are
 * **exported constants**, and a literal of one anywhere else fails the build.
 *
 * Why it is worth a test of its own. Four things have to agree about the string in
 * `ops.transport_need_item.category` — the child panel, the write path, the planner that reads
 * it back as a flag, and the seed that writes the first set — and the failure when they do not
 * is the worst kind: a Save that writes a row and changes nothing on screen, with no error
 * anywhere. One typo in one of four places is all it takes, and only a scan catches it.
 */

const SRC = path.join(__dirname, "..");
const MODULE = path.join(SRC, "config", "equipment.ts");

/**
 * Files allowed to contain the word `OXYGEN` in quotes, because they are a **different
 * vocabulary** that happens to share it: `RejectReason` — why a van cannot take a child — is
 * `LIFT | WHEELCHAIR | OXYGEN | CAR_SEAT | SEAT`, and none of these files reads or writes a
 * need item. The two unambiguous categories (`WHEELCHAIR_SECUREMENT`, `CAR_SEAT_OR_BOOSTER`) are
 * allowed nowhere outside the module.
 */
const REJECT_REASON_FILES = new Set([
  path.join(SRC, "domain", "plan", "fit.ts"),
  path.join(SRC, "domain", "plan", "fit.test.ts"),
  path.join(SRC, "ui", "copy.ts"),
  // The words a refused drop puts on a card, keyed by `RejectReason` and by nothing else
  // (S1, 2026-10-18): this file names the reasons to assert their copy, and reads no need item.
  path.join(SRC, "app", "plan-routes", "board", "lines.test.ts"),
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const scanned = walk(SRC).filter((file) => file !== MODULE && file !== __filename);

/**
 * Every quoted occurrence of a string in **code**, with the line it is on.
 *
 * Comment lines are skipped: naming a category in a sentence about why it exists is the
 * documentation this gate wants more of, not the duplication it is there to stop. What it
 * catches is a category in a string — in an argument, an array, an object, a comparison.
 */
function quotedHits(file: string, value: string): string[] {
  const needle = new RegExp(`["'\`]${value}["'\`]`);
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
    .filter((line) => needle.test(line));
}

describe("gate (a): one list of need categories, and no literal anywhere else", () => {
  it("exports the three the board writes", () => {
    expect(NEED_CATEGORY.wheelchair).toBe("WHEELCHAIR_SECUREMENT");
    expect(NEED_CATEGORY.carSeat).toBe("CAR_SEAT_OR_BOOSTER");
    expect(NEED_CATEGORY.oxygen).toBe("OXYGEN");
    expect([...PANEL_CATEGORIES]).toEqual([
      NEED_CATEGORY.wheelchair,
      NEED_CATEGORY.carSeat,
      NEED_CATEGORY.oxygen,
    ]);
  });

  it("maps each of them to the flag the placement function counts, and back", () => {
    expect(FLAG_OF_CATEGORY[NEED_CATEGORY.wheelchair]).toBe("wheelchair");
    expect(FLAG_OF_CATEGORY[NEED_CATEGORY.carSeat]).toBe("carSeat");
    expect(FLAG_OF_CATEGORY[NEED_CATEGORY.harness]).toBe("carSeat");
    expect(FLAG_OF_CATEGORY[NEED_CATEGORY.oxygen]).toBe("oxygen");
    expect(CATEGORY_OF_PANEL_FLAG).toEqual({
      wheelchair: NEED_CATEGORY.wheelchair,
      carSeat: NEED_CATEGORY.carSeat,
      oxygen: NEED_CATEGORY.oxygen,
    });
  });

  it("finds no literal `WHEELCHAIR_SECUREMENT` or `CAR_SEAT_OR_BOOSTER` outside the module", () => {
    const offenders = scanned
      .map((file) => ({
        file: path.relative(SRC, file),
        hits: [
          ...quotedHits(file, NEED_CATEGORY.wheelchair),
          ...quotedHits(file, NEED_CATEGORY.carSeat),
        ],
      }))
      .filter((found) => found.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("finds no literal `OXYGEN` outside the module and the reject-reason vocabulary", () => {
    const offenders = scanned
      .filter((file) => !REJECT_REASON_FILES.has(file))
      .map((file) => ({ file: path.relative(SRC, file), hits: quotedHits(file, NEED_CATEGORY.oxygen) }))
      .filter((found) => found.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("scans a real tree, so the scan itself cannot pass by finding nothing", () => {
    expect(scanned.length).toBeGreaterThan(100);
    // And the grep works: the module it excludes really does hold all three.
    const inModule = readFileSync(MODULE, "utf8");
    for (const category of Object.values(NEED_CATEGORY)) {
      expect(inModule, category).toContain(`"${category}"`);
    }
  });
});
