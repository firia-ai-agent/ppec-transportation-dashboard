import { describe, expect, it } from "vitest";
import { canOpenPage } from "@/auth/access";
import { deriveReadiness, type DayFacts } from "@/domain/day/readiness";
import { fill, healthNow, nav } from "@/ui/copy";
import {
  RIGHT_NOW_TILES,
  rightNowTiles,
  unreadRightNow,
  vanOnScreen,
  type RightNowFacts,
  type RightNowTile,
} from "./right-now";

/**
 * The four Right now tiles, as words and as counts.
 *
 * png/health-demo-1440.png and png/health-demo-390.png name the four tiles and nothing else.
 * Firia ruling 2026-10-17: Health = four Right-now tiles on Today.
 */

function facts(over: Partial<RightNowFacts> = {}): RightNowFacts {
  return {
    read: true,
    placed: 0,
    toPlace: 0,
    vansChecked: 0,
    vans: 0,
    uncheckedVans: [],
    lateVans: [],
    needsYou: 0,
    ...over,
  };
}

function tile(of: RightNowFacts, key: RightNowTile["key"]): RightNowTile {
  const found = rightNowTiles(of).find((t) => t.key === key);
  if (!found) throw new Error(`no ${key}`);
  return found;
}

describe("the four tiles", () => {
  /**
   * png/health-demo-1440.png, png/health-demo-390.png: Kids placed, Vans checked, Running late,
   * Needs you, under the heading "Right now". The tabs are Board | Health.
   */
  it("uses the mockup's words, in the mockup's order", () => {
    expect(healthNow.rightNow).toBe("Right now");
    expect(healthNow.board).toBe("Board");
    expect(healthNow.health).toBe("Health");
    expect(healthNow.kidsPlaced).toBe("Kids placed");
    expect(healthNow.vansChecked).toBe("Vans checked");
    expect(healthNow.runningLate).toBe("Running late");
    expect(healthNow.needsYou).toBe("Needs you");
    expect(healthNow.all).toBe("All");
    expect(healthNow.none).toBe("None");
    // Firia, 2026-10-18: the Vans checked chip counts the work when more than one van is open.
    expect(healthNow.toCheck).toBe("{n} to check");
    expect(rightNowTiles(facts()).map((t) => t.label)).toEqual([
      "Kids placed",
      "Vans checked",
      "Running late",
      "Needs you",
    ]);
    expect(rightNowTiles(facts()).map((t) => t.key)).toEqual([...RIGHT_NOW_TILES]);
  });

  /** Firia ruling 2026-10-17: Health = four Right-now tiles on Today. A fifth tile is the screen the ruling closed. */
  it("is exactly four, and the two savings rows are not among them", () => {
    expect(RIGHT_NOW_TILES).toHaveLength(4);
    expect(rightNowTiles(facts()).map((t) => t.key)).not.toEqual(
      expect.arrayContaining(["HOURS_SAVED", "MONEY_SAVED"]),
    );
  });

  /**
   * png/health-demo-1440.png: Kids placed and Vans checked are fractions; Running late and
   * Needs you are a single number.
   */
  it("writes a fraction on the two tiles the mockup writes as a fraction", () => {
    const tiles = rightNowTiles(facts({ placed: 12, toPlace: 12, vansChecked: 2, vans: 3 }));
    expect(tiles.find((t) => t.key === "KIDS_PLACED")?.outOf).toBe(12);
    expect(tiles.find((t) => t.key === "VANS_CHECKED")?.outOf).toBe(3);
    expect(tiles.find((t) => t.key === "RUNNING_LATE")?.outOf).toBeNull();
    expect(tiles.find((t) => t.key === "NEEDS_YOU")?.outOf).toBeNull();
  });
});

describe("kids placed", () => {
  /** png/health-demo-1440.png: 12/12 and the pill "All" when every child is in a van. */
  it("says All only when every child the plan is seating is in a van", () => {
    const done = tile(facts({ placed: 12, toPlace: 12 }), "KIDS_PLACED");
    expect(done.count).toBe(12);
    expect(done.outOf).toBe(12);
    expect(done.pill).toEqual({ text: healthNow.all, kind: "all" });

    const short = tile(facts({ placed: 11, toPlace: 12 }), "KIDS_PLACED");
    expect(short.count).toBe(11);
    expect(short.pill).toBeNull();
  });

  it("does not say All about a plan that has nobody to seat", () => {
    const pill = tile(facts({ placed: 0, toPlace: 0 }), "KIDS_PLACED").pill;
    // png/health-demo-1440.png, png/health-demo-390.png: a tile at 0 still shows a pill.
    expect(pill).toEqual({ text: healthNow.none, kind: "none" });
    expect(pill?.text).not.toBe(healthNow.all);
  });
});

describe("vans checked", () => {
  /**
   * The tile and the step strip are one count.
   *
   * Firia ruling 2026-10-17: the tile numbers come from the same day facts as the step strip.
   * "Vans checked 2/3" agrees with "Van setup 2/3 checked".
   */
  it("agrees with the step strip's van setup, including the van that is still open", () => {
    const day: DayFacts = {
      date: "2026-10-17",
      leg: "AM",
      read: true,
      vans: 3,
      vansChecked: 2,
      planSavedAt: null,
    };
    const readiness = deriveReadiness(day);
    const vans = tile(
      facts({
        vansChecked: day.vansChecked,
        vans: day.vans,
        uncheckedVans: ["Van 3"],
      }),
      "VANS_CHECKED",
    );
    expect(vans.count).toBe(readiness.setup.checked);
    expect(vans.outOf).toBe(readiness.setup.total);
    // png/health-demo-1440.png: the pill names the van that is not checked.
    expect(vans.pill).toEqual({ text: "Van 3", kind: "van" });
  });

  it("says All once every van is checked, and names nobody", () => {
    const vans = tile(facts({ vansChecked: 3, vans: 3, uncheckedVans: [] }), "VANS_CHECKED");
    expect(vans.pill).toEqual({ text: healthNow.all, kind: "all" });
  });

  /**
   * Firia, 2026-10-18: the chip counts the vans still to check, and names one only when it is
   * the last one. The big number is the fraction in every case — only the chip changes.
   */
  describe("the chip, as the work comes down", () => {
    const THREE_VANS = ["Van 1", "Van 2", "Van 3"] as const;

    it.each([
      { checked: 0, chip: { text: "3 to check", kind: "count" } },
      { checked: 1, chip: { text: "2 to check", kind: "count" } },
      { checked: 2, chip: { text: "Van 3", kind: "van" } },
      { checked: 3, chip: { text: "All", kind: "all" } },
    ] as const)("$checked of 3 checked reads $chip.text", ({ checked, chip }) => {
      const vans = tile(
        facts({ vansChecked: checked, vans: 3, uncheckedVans: THREE_VANS.slice(checked) }),
        "VANS_CHECKED",
      );
      expect(vans.pill).toEqual(chip);
      // The number is untouched by the chip: 0/3, 1/3, 2/3, 3/3.
      expect(vans.count).toBe(checked);
      expect(vans.outOf).toBe(3);
    });

    /**
     * The bug this fixes: at 0 of 3 the chip said "Van 1", which reads as though Van 1 were the
     * only one left when all three are open. A name is a claim about one van, so it waits until
     * one van is all there is.
     */
    it("names no van while more than one is open", () => {
      for (const checked of [0, 1]) {
        const vans = tile(
          facts({ vansChecked: checked, vans: 3, uncheckedVans: THREE_VANS.slice(checked) }),
          "VANS_CHECKED",
        );
        expect(vans.pill?.text, `${checked} of 3`).not.toMatch(/Van/);
        expect(vans.pill?.text, `${checked} of 3`).toBe(fill(healthNow.toCheck, { n: 3 - checked }));
      }
    });

    /** Two vans, one checked: the other one is the last, so it is named. */
    it("names the last van of two", () => {
      const vans = tile(
        facts({ vansChecked: 1, vans: 2, uncheckedVans: ["Van 2"] }),
        "VANS_CHECKED",
      );
      expect(vans.pill).toEqual({ text: "Van 2", kind: "van" });
      expect(vans.count).toBe(1);
      expect(vans.outOf).toBe(2);
    });

    /**
     * One left and the fleet row the unchecked query could not name: the chip counts it rather
     * than pointing at nothing. It never says All, and never shows an empty chip.
     */
    it("counts the last van when its name was not read", () => {
      const vans = tile(facts({ vansChecked: 2, vans: 3, uncheckedVans: [] }), "VANS_CHECKED");
      expect(vans.pill).toEqual({ text: "1 to check", kind: "count" });
    });
  });

  /** A site with no vans is not a site that has finished checking them. */
  it("does not say All when the site has no vans", () => {
    const pill = tile(facts({ vansChecked: 0, vans: 0 }), "VANS_CHECKED").pill;
    // png/health-demo-1440.png, png/health-demo-390.png: a tile at 0 still shows a pill.
    expect(pill).toEqual({ text: healthNow.none, kind: "none" });
    expect(pill?.text).not.toBe(healthNow.all);
  });
});

describe("running late", () => {
  /** png/health-demo-1440.png: the number is the vans, and the pill names the one that is late. */
  it("counts late vans and names the first of them", () => {
    const one = tile(facts({ lateVans: ["Van 2"] }), "RUNNING_LATE");
    expect(one.count).toBe(1);
    expect(one.outOf).toBeNull();
    expect(one.pill).toEqual({ text: "Van 2", kind: "van" });

    const two = tile(facts({ lateVans: ["Van 2", "Van 3"] }), "RUNNING_LATE");
    expect(two.count).toBe(2);
    expect(two.pill?.text).toBe("Van 2");
  });

  it("says None when nobody is late", () => {
    const none = tile(facts({ lateVans: [] }), "RUNNING_LATE");
    expect(none.count).toBe(0);
    // png/health-demo-1440.png, png/health-demo-390.png: a tile at 0 still shows a pill.
    expect(none.pill).toEqual({ text: healthNow.none, kind: "none" });
  });
});

describe("needs you", () => {
  /**
   * png/health-demo-1440.png: the pill says "Family texts", which is where a NEEDS_PERSON task
   * is read (docs/DATA-MODEL.md, StaffAlert: it shows in For you, inside Family texts).
   */
  it("counts open needs-a-person tasks and points at Family texts", () => {
    const needs = tile(facts({ needsYou: 2 }), "NEEDS_YOU");
    expect(needs.count).toBe(2);
    expect(needs.pill).toEqual({ text: nav.familyTexts, kind: "family" });
    expect(needs.pill?.text).toBe("Family texts");
  });

  it("says None when nothing is waiting", () => {
    // png/health-demo-1440.png, png/health-demo-390.png: a tile at 0 still shows a pill.
    expect(tile(facts({ needsYou: 0 }), "NEEDS_YOU").pill).toEqual({
      text: healthNow.none,
      kind: "none",
    });
  });
});

describe("a day that could not be read", () => {
  /** The browser check has no site, and a failed query must not become "All". */
  it("is zeros and a None pill, on every tile", () => {
    for (const t of rightNowTiles(unreadRightNow())) {
      expect(t.count, t.key).toBe(0);
      // png/health-demo-1440.png, png/health-demo-390.png: a tile at 0 still shows a pill.
      expect(t.pill, t.key).toEqual({ text: healthNow.none, kind: "none" });
      expect(t.pill?.text, t.key).not.toBe(healthNow.all);
      if (t.key === "KIDS_PLACED" || t.key === "VANS_CHECKED") expect(t.outOf).toBe(0);
    }
  });
});

describe("a van's name on a pill", () => {
  /** The code the row is stored under is not the word on the screen. */
  it("says Van 3 for a row labelled with its code, and leaves Van 3 alone", () => {
    expect(vanOnScreen("V3 substitute van")).toBe("Van 3");
    expect(vanOnScreen("V2")).toBe("Van 2");
    expect(vanOnScreen("Van 3")).toBe("Van 3");
    expect(vanOnScreen("V3 substitute van")).not.toMatch(/\bV\d\b/);
  });
});

describe("who can open it", () => {
  /**
   * Health is a tab on Today, so it is Today's door.
   *
   * docs/DATA-MODEL.md: the front desk keeps Live map and Ramp iPad only.
   * Firia ruling 2026-10-17: Health = four Right-now tiles on Today.
   */
  it("is open to the director and the coordinator, and not to the front desk", () => {
    expect(canOpenPage({ kind: "STAFF", role: "DIRECTOR" }, "/today")).toBe(true);
    expect(canOpenPage({ kind: "STAFF", role: "COORDINATOR" }, "/today")).toBe(true);
    expect(canOpenPage({ kind: "STAFF", role: "FRONT_DESK" }, "/today")).toBe(false);
  });
});
