import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Age } from "./Age";
import { humanizeAge, spokenAge } from "./age";
import { age, fill } from "./copy";
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

/**
 * §9: the short units are for the eye only. "12 s" is read out as "twelve ess" and "4 min" as
 * "four min", so the same age is written again in full words for a screen reader. The two must
 * never disagree, and the words are singular at exactly one.
 */
describe("spokenAge", () => {
  it.each([
    [0, "0 seconds"],
    [1, "1 second"],
    [2, "2 seconds"],
    [12, "12 seconds"],
    [59, "59 seconds"],
    [60, "1 minute"],
    [119, "1 minute"],
    [120, "2 minutes"],
    [240, "4 minutes"],
    [3599, "59 minutes"],
    [3600, "1 hour"],
    [3660, "1 hour 1 minute"],
    [3900, "1 hour 5 minutes"],
    [7200, "2 hours"],
    [7260, "2 hours 1 minute"],
    [7620, "2 hours 7 minutes"],
  ])("%i s is spoken as %s", (seconds, expected) => {
    expect(spokenAge(seconds)).toBe(expected);
  });

  it("says the unit in full words, never the abbreviation", () => {
    for (let seconds = 0; seconds <= 7600; seconds += 7) {
      const spoken = spokenAge(seconds);
      expect(spoken, `${seconds} s`).toMatch(/\b(?:seconds?|minutes?|hours?)\b/);
      expect(spoken, `${seconds} s`).not.toMatch(/\b(?:s|min|h)\b/);
    }
  });

  it("is singular at exactly one and plural everywhere else", () => {
    expect(spokenAge(1)).toBe(fill(age.spoken.second, { n: 1 }));
    expect(spokenAge(60)).toBe(fill(age.spoken.minute, { n: 1 }));
    expect(spokenAge(3600)).toBe(fill(age.spoken.hour, { h: 1 }));
    for (const seconds of [0, 2, 30, 120, 7200]) {
      expect(spokenAge(seconds)).toMatch(/\b(?:seconds|minutes|hours)\b/);
    }
  });

  it("clamps, truncates and refuses NaN exactly as the visible form does", () => {
    expect(spokenAge(-5)).toBe("0 seconds");
    expect(spokenAge(Number.NaN)).toBe("0 seconds");
    expect(spokenAge(Number.POSITIVE_INFINITY)).toBe("0 seconds");
    expect(spokenAge(59.9)).toBe("59 seconds");
    expect(spokenAge(179.9)).toBe("2 minutes");
  });

  it("changes band on the same second as the visible form, so the two never disagree", () => {
    for (let seconds = 0; seconds <= 7600; seconds += 1) {
      const visible = humanizeAge(seconds);
      const spoken = spokenAge(seconds);
      // Same numbers, in the same order, in both strings.
      expect(spoken.match(/\d+/g), `${seconds} s`).toEqual(visible.match(/\d+/g));
    }
  });

  it("every spoken template is a word, and the words are the only place they are written", () => {
    expect(age.spoken).toEqual({
      second: "{n} second",
      seconds: "{n} seconds",
      minute: "{n} minute",
      minutes: "{n} minutes",
      hour: "{h} hour",
      hours: "{h} hours",
      separator: " ",
    });
  });
});

/** The pair on screen: short form for the eye, full words for the ear, announced once. */
describe("<Age>", () => {
  it("shows the short form and hides it from the screen reader", () => {
    const html = renderToStaticMarkup(Age({ seconds: 12 }));
    expect(html).toContain(`<span aria-hidden="true">${humanizeAge(12)}</span>`);
  });

  it("puts the full words in the sr-only utility the rest of the app uses", () => {
    const html = renderToStaticMarkup(Age({ seconds: 3900 }));
    expect(html).toContain(`<span class="srOnly">${spokenAge(3900)}</span>`);
    expect(html).toContain("1 hour 5 minutes");
  });

  it("announces the age exactly once: the visible half is always aria-hidden", () => {
    for (const seconds of [0, 1, 59, 60, 3600, 3900]) {
      const html = renderToStaticMarkup(Age({ seconds }));
      expect(html.match(/aria-hidden="true"/g), `${seconds} s`).toHaveLength(1);
      expect(html.match(/class="srOnly"/g), `${seconds} s`).toHaveLength(1);
    }
  });

  it("passes a caller's class through to the wrapper only", () => {
    const html = renderToStaticMarkup(Age({ seconds: 12, className: "tabularNums" }));
    expect(html).toMatch(/^<span class="tabularNums">/);
  });
});
