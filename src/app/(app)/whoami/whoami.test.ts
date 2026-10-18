import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES } from "@/auth/access";
import { roleNames, whoami } from "@/ui/copy";
import { accountLines, shortName } from "@/ui/display-name";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";

/**
 * THE ACCOUNT PAGE — "Dana M. · Director", inside the frame.
 *
 * Vera's walk of PR #71 read this page as: no header, no menu, "SYN Dana Director", and
 * "DIRECTOR at site 01900000-0000-7000-8000-00000000000a". Four separate faults in three lines
 * — a screen outside the app's own frame, a database row's name on a screen, a role *key*
 * (COPY-GUIDE §2 bars those everywhere), and an internal id a founder would read out in front
 * of a customer.
 *
 * Read off the source, because the page is a server component behind `requirePage` and there is
 * no session, no router and no database in node. What the browser then renders is
 * e2e/rework-frame.spec.ts, which walks this address for all three roles at both widths.
 */
const HERE = __dirname;
const page = readFileSync(path.join(HERE, "page.tsx"), "utf8");

describe("the account page is in the frame", () => {
  it("lives inside the group whose layout mounts the console shell", () => {
    const row = PAGES.find((p) => p.kind === "page" && p.path === "/whoami");
    expect(row).toBeDefined();
    expect((row as { file: string }).file).toBe("src/app/(app)/whoami/page.tsx");
    // The old route is gone, not left behind answering with no menu on it.
    expect(existsSync(path.resolve(HERE, "..", "..", "whoami", "page.tsx"))).toBe(false);
  });

  it("brings no `main` of its own: the shell above it is the page's main landmark (§9)", () => {
    expect(page).not.toMatch(/<main\b/);
  });

  it("has a 403 boundary beside it, like every other guarded page", () => {
    const boundary = readFileSync(path.join(HERE, "forbidden.tsx"), "utf8");
    expect(boundary).toContain('<RefusedPage path="/whoami" />');
  });
});

describe("it says who you are in one line", () => {
  it("uses the one name helper the shell and the phone avatar use", () => {
    expect(page).toMatch(/accountLines\(caller\.displayName/);
    // And that helper is what turns the stored row into the words: "Dana M.", not "SYN Dana…".
    expect(shortName(DEMO_ACCOUNTS[0].name)).toBe("Dana M.");
    expect(`${shortName(DEMO_ACCOUNTS[0].name)}${whoami.separator}${roleNames.DIRECTOR.one}`).toBe(
      "Dana M. · Director",
    );
  });

  it("says the role in the plain words the rest of the app uses, never the enum", () => {
    expect(page).toMatch(/roleNames\[caller\.role\]\.one/);
    for (const key of Object.keys(roleNames)) {
      expect(page, `the role key ${key} is on the screen`).not.toContain(`"${key}"`);
    }
  });

  it("prints no membership list, no site id and no UUID", () => {
    // The code, not the comments: the file explains what the guard already read, and saying so
    // is the opposite of rendering it.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/memberships/);
    expect(code).not.toMatch(/siteId/i);
    // The copy entry that carried both is gone, so nothing can render it again.
    expect(whoami).not.toHaveProperty("membership");
    expect(Object.values(whoami).join(" ")).not.toMatch(/\{role\}|\{siteId\}/);
  });

  it("keeps the way out: Sign out is on it", () => {
    expect(page).toMatch(/<SignOutButton \/>/);
  });

  it("is titled 'Signed in' and joins the two halves with the §3 middle dot", () => {
    expect(whoami.heading).toBe("Signed in");
    expect(whoami.separator).toBe(" · ");
  });

  /**
   * "DIRECTOR · DIRECTOR" — the line Vera read here — had two causes and both are fixed.
   *
   * The first was the session: the browser-test session had no user row behind it, so its whole
   * display name *was* a role's title (src/auth/caller.ts). It is named from the demo staff
   * roster now, so the two halves of this line are a person and a role again.
   *
   * The second is the rule, and it is still needed for any session that has no name at all: a
   * name that is only a role is said once. It lives in `accountLines` rather than in this page,
   * because the rail's account block and the phone's avatar have exactly the same question to
   * answer and three copies of one rule is three places to break it.
   */
  it("says a name that is only a role once", () => {
    expect(accountLines("Director", roleNames.DIRECTOR.one)).toEqual({
      name: roleNames.DIRECTOR.one,
      role: null,
    });
    expect(accountLines("", roleNames.DIRECTOR.one)).toEqual({
      name: roleNames.DIRECTOR.one,
      role: null,
    });
    // The page prints the second half only when the helper gives it one.
    expect(page).toMatch(/lines\.role \?/);
  });

  /** The session the browser checks run as is a named person now, not a role twice over. */
  it.each(DEMO_ACCOUNTS)("names $role as a person beside their role", (account) => {
    const role = roleNames[account.role].one;
    const lines = accountLines(account.name, role);
    expect(lines.role).toBe(role);
    expect(lines.name).not.toBe(role);
    expect(`${lines.name}${whoami.separator}${lines.role}`).not.toMatch(
      new RegExp(`^${role}\\s*·\\s*${role}$`),
    );
  });
});
