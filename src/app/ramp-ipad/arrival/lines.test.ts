import { describe, expect, it } from "vitest";
import { vanArrival } from "@/ui/copy";
import { shortName } from "@/ui/display-name";
import {
  confirmLabel,
  plannedLine,
  riderVerdict,
  shortfallBanner,
  shortfallLines,
  shortThing,
  whatsOn,
} from "./lines";

/**
 * EVERY LINE THE RAMP SAYS, as the spec and the mockup write them.
 *
 * The banner is the one the work order quotes word for word — "Mia R. won't fit · 1 car seat
 * short" (png/ramp-arrival.png) — so it is asserted as the whole sentence and not as two
 * fragments: the screen draws the halves on two lines and `shortfallBanner` is what they say
 * read together. The name goes through the one name helper (src/ui/display-name.ts), so a stored
 * row's whole name never reaches the banner.
 */

describe("the won't-fit banner", () => {
  it("is “Mia R. won’t fit · 1 car seat short”", () => {
    expect(shortfallBanner("Mia Ramirez", { reason: "CAR_SEAT", short: 1 })).toBe(
      "Mia R. won’t fit · 1 car seat short",
    );
  });

  it("is the two halves the screen draws, joined by the middle dot", () => {
    const lines = shortfallLines("Mia Ramirez", { reason: "CAR_SEAT", short: 1 });
    expect(lines).toEqual({ who: "Mia R. won’t fit", short: "1 car seat short" });
    expect(shortfallBanner("Mia Ramirez", { reason: "CAR_SEAT", short: 1 })).toBe(
      `${lines.who} · ${lines.short}`,
    );
  });

  it("shortens a name that is already short, and never prints a role or the SYN marker", () => {
    expect(shortfallBanner("Mia R.", { reason: "CAR_SEAT", short: 1 })).toContain("Mia R.");
    expect(shortfallBanner("SYN Mia Ramirez", { reason: "CAR_SEAT", short: 1 })).toContain("Mia R.");
    expect(shortfallBanner("SYN Mia Ramirez", { reason: "CAR_SEAT", short: 1 })).not.toContain("SYN");
    expect(shortName("SYN Mia Ramirez")).toBe("Mia R.");
  });

  it("counts more than one, and says the lift rather than counting to one", () => {
    expect(shortfallBanner("Mia Ramirez", { reason: "SEAT", short: 2 })).toBe(
      "Mia R. won’t fit · 2 seats short",
    );
    expect(shortfallBanner("Mia Ramirez", { reason: "LIFT", short: 1 })).toBe(
      `Mia R. won’t fit · ${vanArrival.noLift}`,
    );
  });
});

describe("a rider's own chip", () => {
  it("is the mockup's small ok chip when they fit, and names the gap when they do not", () => {
    expect(riderVerdict(null)).toEqual({ label: vanArrival.fits, tone: "ok" });
    expect(riderVerdict("CAR_SEAT")).toEqual({ label: "Car seat", tone: "crit" });
    expect(riderVerdict("WHEELCHAIR")).toEqual({ label: "Wheelchair spot", tone: "crit" });
    expect(shortThing("CAR_SEAT", 2)).toBe("2 car seats");
  });
});

describe("the counters and the card", () => {
  it("says what the saved plan needs, and never calls it a default", () => {
    expect(plannedLine(3)).toBe("Planned 3");
    expect(plannedLine(0)).toBe("Planned 0");
    expect(plannedLine(3)).not.toMatch(/Default/);
  });

  it("names the van the front desk is standing in front of", () => {
    expect(whatsOn("Van 1")).toBe("What’s on Van 1?");
    expect(confirmLabel("Van 1")).toBe("Confirm Van 1");
  });
});
