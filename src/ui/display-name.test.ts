import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { demoLogins, roleNames } from "./copy";
import { personName } from "./display-name";

/**
 * "Dana", not "SYN Dana Director" (Vera's review, 2026-10-17).
 *
 * The three demo accounts are seeded with the synthetic prefix and the role in their stored
 * name, which is right in the database and wrong in a header. The accounts themselves are the
 * fixture here — not three strings written out again — so a renamed demo account is tested as
 * it is, not as this file remembers it.
 */
describe("the name the header shows", () => {
  it.each(DEMO_ACCOUNTS.map((a) => [a.name, a.name.split(" ")[1]] as const))(
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
