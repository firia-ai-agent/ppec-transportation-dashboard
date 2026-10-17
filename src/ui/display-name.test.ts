import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { demoLogins, roleNames } from "./copy";
import { personName, shortName, withoutSyntheticMarker } from "./display-name";

/**
 * "Dana", not "SYN Dana Director" (Vera's review, 2026-10-17).
 *
 * The three demo accounts are seeded with the synthetic prefix and the role in their stored
 * name, which is right in the database and wrong in a header. The accounts themselves are the
 * fixture here — not three strings written out again — so a renamed demo account is tested as
 * it is, not as this file remembers it.
 */
describe("the name the header shows", () => {
  // The person out of the row: the marker off the front, the role off the back, the first and
  // family names left. (`shortName` below is what a screen then prints.)
  it.each(DEMO_ACCOUNTS.map((a) => [a.name, a.name.split(" ").slice(1, -1).join(" ")] as const))(
    "%s reads as %s",
    (stored, expected) => {
      expect(personName(stored)).toBe(expected);
    },
  );

  it("drops the synthetic prefix and the role, and nothing else", () => {
    expect(personName("SYN Dana Director")).toBe("Dana");
    expect(personName("SYN Casey Coordinator")).toBe("Casey");
    expect(personName("SYN Frankie FrontDesk")).toBe("Frankie");
    // A middle name or a last initial is part of the person, so it stays.
    expect(personName("SYN Ana P. Coordinator")).toBe("Ana P.");
    // Nothing to strip is not a reason to change the name.
    expect(personName("Dana")).toBe("Dana");
  });

  /**
   * The browser-test session has no user row behind it, so its display name *is* a role's own
   * words (src/auth/caller.ts, `demoLogins`). Stripping those would leave an empty header, so
   * the last thing standing is kept whatever it is.
   */
  it.each(Object.keys(demoLogins.roles) as Array<keyof typeof demoLogins.roles>)(
    "keeps %s's own title, which is the whole name that session has",
    (role) => {
      const title = demoLogins.roles[role].title;
      expect(personName(title)).toBe(title);
      expect(personName(roleNames[role].one)).toBe(roleNames[role].one);
    },
  );

  it("is quiet about an empty or blank name rather than throwing", () => {
    expect(personName("")).toBe("");
    expect(personName("   ")).toBe("");
  });
});

/**
 * THE NAME THE CONSOLE SHOWS — "Dana M." (the founder's mockups, png/shell-flow-1440.png).
 *
 * One function for the three places a person is named: the identity menu, the avatar's
 * initials, and the account page. Everything it has to get right is below, including the two
 * names it must not invent anything for.
 */
describe("shortName", () => {
  it("is a first name and a family initial", () => {
    expect(shortName("SYN Dana Mercer Director")).toBe("Dana M.");
    expect(shortName("SYN Casey Ruiz Coordinator")).toBe("Casey R.");
    expect(shortName("SYN Frankie Lowell FrontDesk")).toBe("Frankie L.");
  });

  it("is what the three demo accounts actually render as", () => {
    expect(DEMO_ACCOUNTS.map((a) => shortName(a.name))).toEqual([
      "Dana M.",
      "Casey R.",
      "Frankie L.",
    ]);
  });

  it("keeps an initial that is already one, rather than making it 'Dana M'", () => {
    expect(shortName("Dana M.")).toBe("Dana M.");
  });

  it("says a one-word name as it is, rather than as an initial of nothing", () => {
    // The browser-test session's whole display name is the role's own word (src/auth/caller.ts).
    expect(shortName("Director")).toBe("Director");
    expect(shortName("SYN Dana Director")).toBe("Dana");
    expect(shortName("")).toBe("");
  });

  it("never carries the synthetic marker or the role", () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(shortName(account.name)).not.toMatch(/\bSYN\b/);
      expect(shortName(account.name).toLowerCase()).not.toMatch(/director|coordinator|desk/);
    }
  });
});

/**
 * The same marker, off a seeded *provider*: "SYN Palm Lift Transport" was on Plan routes three
 * times, in the line that says who is driving each van (the founder's walk, 2026-10-17).
 */
describe("withoutSyntheticMarker", () => {
  it("drops the marker and keeps the whole name under it", () => {
    expect(withoutSyntheticMarker("SYN Palm Lift Transport")).toBe("Palm Lift Transport");
    expect(withoutSyntheticMarker("SYN Greenacres center fleet")).toBe("Greenacres center fleet");
    expect(withoutSyntheticMarker("Palm Lift Transport")).toBe("Palm Lift Transport");
  });

  it("drops nothing else: a name that begins with another word keeps it", () => {
    expect(withoutSyntheticMarker("SYNERGY Transit")).toBe("SYNERGY Transit");
  });
});
