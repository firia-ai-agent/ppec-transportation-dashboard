import { describe, expect, it } from "vitest";
import { humanizeAge } from "./age";
import { gpsFreshnessLabel } from "./states";

/**
 * The boundaries Vera's review names: 0, 59, 60, 119, 3599, 3600, 3900. The rule under test is
 * "never raw seconds over 60" — above a minute the string must carry a minute or hour unit.
 */
describe("humanizeAge", () => {
  it.each([
    [0, "0 s"],
    [1, "1 s"],
    [12, "12 s"],
    [59, "59 s"],
    [60, "1 min"],
    [119, "1 min"],
    [120, "2 min"],
    [240, "4 min"],
    [3599, "59 min"],
    [3600, "1 h"],
    [3900, "1 h 5 min"],
    [7260, "2 h 1 min"],
  ])("%i s reads %s", (seconds, expected) => {
    expect(humanizeAge(seconds)).toBe(expected);
  });

  it("reads exactly '1 h' at 3600 s, never '1 h 0 min' (Vera's answer, 2026-10-14)", () => {
    expect(humanizeAge(3600)).toBe("1 h");
    expect(humanizeAge(7200)).toBe("2 h");
    // Zero minutes are dropped on every whole hour, and only there.
    for (let hours = 1; hours <= 6; hours += 1) {
      expect(humanizeAge(hours * 3600)).toBe(`${hours} h`);
      expect(humanizeAge(hours * 3600 + 60)).toBe(`${hours} h 1 min`);
    }
    expect(humanizeAge(3659)).toBe("1 h");
    expect(humanizeAge(3660)).toBe("1 h 1 min");
  });

  it("never prints raw seconds once the age passes a minute", () => {
    for (let seconds = 60; seconds <= 7200; seconds += 7) {
      const text = humanizeAge(seconds);
      expect(text, `${seconds} s`).not.toMatch(/\d+ s$/);
      expect(text, `${seconds} s`).toMatch(/\d+ (?:min|h)\b/);
    }
  });

  it("prints seconds for every age below a minute", () => {
    for (let seconds = 0; seconds < 60; seconds += 1) {
      expect(humanizeAge(seconds)).toBe(`${seconds} s`);
    }
  });

  it("clamps a negative age and refuses to print NaN", () => {
    expect(humanizeAge(-5)).toBe("0 s");
    expect(humanizeAge(Number.NaN)).toBe("0 s");
    expect(humanizeAge(Number.POSITIVE_INFINITY)).toBe("0 s");
  });

  it("truncates rather than rounds, so an age never reads older than it is", () => {
    expect(humanizeAge(59.9)).toBe("59 s");
    expect(humanizeAge(179.9)).toBe("2 min");
  });
});

/** §3 GPS chips are the first consumer: the band comes from the age, the age is humanized. */
describe("gpsFreshnessLabel", () => {
  it.each([
    [12, "Live · 12 s"],
    [59, "Live · 59 s"],
    [60, "Last seen 1 min"],
    [179, "Last seen 2 min"],
    [240, "Stale · 4 min · ETA texts paused"],
    [599, "Stale · 9 min · ETA texts paused"],
    [660, "No signal · 11 min"],
    [3900, "No signal · 1 h 5 min"],
  ])("%i s reads %s", (seconds, expected) => {
    expect(gpsFreshnessLabel(seconds)).toBe(expected);
  });

  it("leaves no {age} placeholder unfilled in any band", () => {
    for (const seconds of [0, 59, 60, 119, 179, 180, 3599, 3600, 3900]) {
      expect(gpsFreshnessLabel(seconds)).not.toMatch(/\{age\}/);
    }
  });
});
