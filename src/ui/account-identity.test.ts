import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import type { ResolvedCaller } from "@/auth/caller";
import { ConsoleShell } from "./ConsoleShell";
import { fill, identity, roleNames } from "./copy";
import { initialsOf, shortName } from "./display-name";
import type { RailAccount } from "./NavRail";

/**
 * WHO THE FRAME SAYS YOU ARE — the same two letters in every disc, for every role.
 *
 * Three surfaces draw the account: the block at the foot of the rail, the 36 px disc at the
 * trailing end of the page header bar below 768, and /whoami. All three are handed one object,
 * built once in src/ui/ConsoleShell.tsx out of the caller's **stored name** — so the initials
 * are the person's, never the role's and never a letter somebody typed.
 *
 * Vera, 2026-10-17 8:46 PM ET, asked for this to be checked for the front desk in particular:
 * their account is "SYN Frankie Lowell FrontDesk" in the demo roster, which must read "Frankie
 * L." with "FL" beside it — not "F", not "FD", and not the role. It is asserted here for all
 * three accounts, through the function the screens actually call rather than against a list of
 * expected strings written twice.
 */
const SITE = "00000000-0000-7000-8000-000000000001";

/** The caller as the one session reader hands it over, for a demo account. */
function callerFor(account: (typeof DEMO_ACCOUNTS)[number]): ResolvedCaller {
  return {
    kind: "STAFF",
    role: account.role,
    userId: account.id,
    displayName: account.name,
    memberships: [{ siteId: SITE, role: account.role }],
  };
}

/** What the shell hands the rail and the page header: one account object, built once. */
function accountOf(caller: ResolvedCaller): RailAccount | null {
  const element = ConsoleShell({ caller, children: null }) as ReactElement<{
    account: RailAccount | null;
  }>;
  return element.props.account;
}

describe("the account the frame is given", () => {
  it.each(DEMO_ACCOUNTS.map((a) => [a.role, a] as const))(
    "names %s as the person in the roster, with their own initials",
    (_role, account) => {
      const name = shortName(account.name);
      expect(accountOf(callerFor(account))).toEqual({
        name,
        role: roleNames[account.role].one,
        initials: initialsOf(name),
        label: fill(identity.account, { name, role: roleNames[account.role].one }),
        href: "/whoami",
      });
    },
  );

  /**
   * The three, written out once — because every other assertion here is built from the helper
   * and would agree with itself if the helper were wrong. This is the one place that says what
   * a person reads: Frankie L. is "FL", not "F" and not "FD".
   */
  it("is DM, CR and FL on the screen", () => {
    expect(DEMO_ACCOUNTS.map((a) => accountOf(callerFor(a))?.initials)).toEqual([
      "DM",
      "CR",
      "FL",
    ]);
    expect(DEMO_ACCOUNTS.map((a) => accountOf(callerFor(a))?.name)).toEqual([
      "Dana M.",
      "Casey R.",
      "Frankie L.",
    ]);
  });

  /** Two letters at most: a disc is a disc, whatever the stored name turns out to be. */
  it.each(DEMO_ACCOUNTS.map((a) => [a.role, a] as const))(
    "gives %s no more than two letters, both from their name",
    (_role, account) => {
      const initials = accountOf(callerFor(account))?.initials ?? "";
      expect(initials).toMatch(/^[A-Z]{1,2}$/);
      const name = shortName(account.name).replace(/[^A-Za-z]/g, "").toUpperCase();
      for (const letter of initials) expect(name).toContain(letter);
    },
  );

  /**
   * A session with no person behind it — a role for a whole name — says the role once and shows
   * the letter that role starts with. Nothing is invented, and nothing reads "Director ·
   * Director" (`accountLines`, src/ui/display-name.ts).
   */
  it("says a nameless session's role once, and never twice", () => {
    const account = accountOf({
      kind: "STAFF",
      role: "DIRECTOR",
      displayName: roleNames.DIRECTOR.one,
      memberships: [],
    });
    expect(account).toMatchObject({ name: roleNames.DIRECTOR.one, role: null, initials: "D" });
  });

  it("draws no account at all for a caller with no name", () => {
    expect(accountOf({ kind: "ANONYMOUS", memberships: [] })).toBeNull();
  });
});

/**
 * AND NOBODY ELSE DECIDES INITIALS. The letters are `initialsOf`'s, which is built on the name
 * a screen shows — so a surface cannot grow its own rule, and a role key can never become a
 * monogram ("FD" for the front desk, which is a label for a database and not a person).
 */
describe("the one rule for initials", () => {
  const UI = __dirname;
  const SRC = path.resolve(UI, "..");

  function walkSrc(dir: string = SRC): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walkSrc(full);
      return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
    });
  }

  it("is called in exactly one place, and that place is the shell", () => {
    const callers = walkSrc().filter(
      (file) =>
        file !== path.join(UI, "display-name.ts") &&
        /\binitialsOf\(/.test(readFileSync(file, "utf8")),
    );
    expect(callers.map((f) => path.relative(SRC, f))).toEqual(["ui/ConsoleShell.tsx"]);
  });

  it("takes the name, not the role, as its input", () => {
    const shell = readFileSync(path.join(UI, "ConsoleShell.tsx"), "utf8");
    expect(shell).toMatch(/initialsOf\(lines\.name\)/);
    expect(shell).not.toMatch(/initialsOf\(\s*(?:caller\.)?role/);
    // ...and no surface writes a monogram of its own.
    for (const file of walkSrc()) {
      const source = readFileSync(file, "utf8");
      expect(source, path.relative(SRC, file)).not.toMatch(/initials[:=]\s*"[A-Z]{1,3}"/);
    }
  });
});
