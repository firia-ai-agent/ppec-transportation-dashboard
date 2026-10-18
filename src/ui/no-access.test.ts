import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserLock, type LucideIcon } from "lucide-react";
import { fill, liveMap, nav, noAccess, rampIpad, roleNames } from "./copy";
import { sourceModes, vocabularies } from "./states";
import { whoCanOpenLine, type Caller } from "@/auth/access";

/**
 * The no-access page: what a signed-in person sees when a page is not part of their role.
 *
 * It is rendered for real with `renderToStaticMarkup`. `getCaller` is stubbed, so no token is
 * decoded and no database is opened, and `next/link` is stubbed to a plain anchor because the
 * real one wants a router from React context that exists only inside Next. What is asserted is
 * this card's own structure and words — the status code it arrives with is the guard's job and
 * guard-matrix.test.ts holds that, role by role, against the real pages.
 */
const getCaller = vi.fn<() => Promise<Caller>>();

vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", props),
}));

const CALLERS = {
  frontDesk: { kind: "STAFF", role: "FRONT_DESK", userId: "u-f" },
  coordinator: { kind: "STAFF", role: "COORDINATOR", userId: "u-c" },
  noRole: { kind: "NO_ROLE", userId: "u-n" },
} satisfies Record<string, Caller>;

beforeEach(() => getCaller.mockReset());

async function render(caller: Caller, props: { path?: string } = {}): Promise<string> {
  getCaller.mockResolvedValue(caller);
  const { NoAccess } = await import("./NoAccess");
  return renderToStaticMarkup(await NoAccess(props));
}

/** React escapes `'` in a text node, so the copy has to be escaped to be found in the markup. */
function escapeApostrophes(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

describe("the copy lives in src/ui/copy.ts", () => {
  it("says the heading the copy lead fixed, word for word", () => {
    expect(noAccess.heading).toBe("This page isn't part of your role");
  });

  it("says it without apology, blame, a code or a route", () => {
    for (const line of Object.values(noAccess)) {
      expect(line).not.toMatch(/sorry|error|denied|forbidden|403|401|\//i);
      /*
       * And no role *key*, which is the thing a person cannot read: the database's
       * `DIRECTOR`/`COORDINATOR`/`FRONT_DESK`, not the everyday nouns. "Ask a director to add
       * you." is Vera's line for the no-role caller, and `roleNames` holds the same words for
       * the `{who}` line — COPY-GUIDE §2 bans enum names on screen, not the word director.
       */
      expect(line).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
    }
  });

  it("says Vera's two lines for an account with no role at all", () => {
    expect(noAccess.noRoleHeading).toBe("Your account isn't set up for a site yet");
    expect(noAccess.noRoleLine).toBe("Ask a director to add you.");
  });

  it("names the roles in a person's words, never the database's", () => {
    expect(roleNames.DIRECTOR.many).toBe("directors");
    expect(roleNames.COORDINATOR.many).toBe("coordinators");
    expect(roleNames.FRONT_DESK.many).toBe("front desk staff");
    expect(whoCanOpenLine("/today")).toBe("Directors and coordinators can open this.");
  });

  it("holds no copy of its own in the component", () => {
    const source = readFileSync(path.join(__dirname, "NoAccess.tsx"), "utf8");
    expect(source).toMatch(/from "\.\/copy"/);
    expect(source).toMatch(/noAccess\.heading/);
    // Every word on the card arrives through an expression (copy.test.ts scans for the rest).
    expect(source).not.toMatch(/>[A-Za-z]{2}/);
  });
});

describe("the card", () => {
  /*
   * An h2, not an h1 — and the page it is on has exactly one h1, which is the frame's page
   * header bar (src/ui/PageHeader.tsx, audit §2 item 1). The card is the answer *inside* a
   * page, so a second title on the screen would be two titles.
   */
  it("is one h2, carrying the heading, and no h1 of its own", async () => {
    const html = await render(CALLERS.frontDesk, { path: "/today" });
    expect(html).toContain(`${escapeApostrophes(noAccess.heading)}</h2>`);
    expect(html.match(/<h2/g)).toHaveLength(1);
    expect(html.match(/<h1/g), "the card's title is the frame's, not a second one").toBeNull();
  });

  it("says who the page is for, generated from the access table", async () => {
    const html = await render(CALLERS.frontDesk, { path: "/today" });
    expect(html).toContain("Directors and coordinators can open this.");
  });

  it("says it for each page, in that page's own answer", async () => {
    for (const [page, line] of [
      ["/exceptions", "Directors and coordinators can open this."],
      ["/ramp-ipad", "Directors, coordinators and front desk staff can open this."],
    ] as const) {
      expect(await render(CALLERS.frontDesk, { path: page })).toContain(line);
    }
  });

  it("carries one icon, and it is not an icon §3 or §7.1 gives a state meaning to", async () => {
    const html = await render(CALLERS.frontDesk, { path: "/today" });
    expect(html.match(/<svg/g)).toHaveLength(1);
    const used = new Map<LucideIcon, string>();
    for (const [vocabulary, states] of Object.entries(vocabularies)) {
      for (const [state, descriptor] of Object.entries(states)) used.set(descriptor.icon, `${vocabulary}.${state}`);
    }
    for (const [mode, descriptor] of Object.entries(sourceModes)) used.set(descriptor.icon, `source_mode.${mode}`);
    expect(used.size).toBeGreaterThan(30);
    expect(used.get(UserLock)).toBeUndefined();
    expect(readFileSync(path.join(__dirname, "NoAccess.tsx"), "utf8")).toMatch(/UserLock/);
  });

  it("offers one way out: the first page this person's own role can open", async () => {
    // The live map, since Firia's final ruling of 2026-10-17 3:08 PM ET made it the front
    // desk's home. The card reads `homePathFor`, so it moved with it.
    const frontDesk = await render(CALLERS.frontDesk, { path: "/today" });
    expect(frontDesk).toContain(`href="/live-map"`);
    expect(frontDesk).toContain(fill(noAccess.back, { page: liveMap.heading }));
    expect(frontDesk.match(/<a /g)).toHaveLength(1);

    // A coordinator can be refused a page too (a director-only one, when there is one), and
    // their way out is the board.
    const coordinator = await render(CALLERS.coordinator, { path: "/today" });
    expect(coordinator).toContain(`href="/today"`);
    expect(coordinator).toContain(fill(noAccess.back, { page: nav.today }));
  });

  it("tells a signed-in person with no role at all what is true of their account, and who can fix it", async () => {
    /*
     * The widest denied row in the table: every page refuses them, so the refusal is not about
     * the page. They get Vera's fallback — and they get it whether a page was named or not,
     * because naming the roles that could open it would tell them nothing they can act on.
     */
    for (const props of [{}, { path: "/today" }, { path: "/ramp-ipad" }]) {
      const html = await render(CALLERS.noRole, props);
      expect(html).toContain(escapeApostrophes(noAccess.noRoleHeading));
      expect(html).toContain(noAccess.noRoleLine);
      expect(html).not.toContain(escapeApostrophes(noAccess.heading));
      expect(html).not.toContain("can open this");
      // One way out, as on every other render of this card.
      expect(html).toContain(`href="/login"`);
      expect(html.match(/<a /g)).toHaveLength(1);
    }
  });

  it("shows the fallback to nobody else: a role refused one page still gets the role card", async () => {
    for (const caller of [CALLERS.frontDesk, CALLERS.coordinator]) {
      const html = await render(caller, { path: "/today" });
      expect(html).toContain(escapeApostrophes(noAccess.heading));
      expect(html).toContain("Directors and coordinators can open this.");
      expect(html).not.toContain(escapeApostrophes(noAccess.noRoleHeading));
      expect(html).not.toContain(noAccess.noRoleLine);
    }
  });

  it("shows no status code, no role key and no route path", async () => {
    for (const caller of Object.values(CALLERS)) {
      for (const page of ["/today", "/exceptions", "/setup", "/health"]) {
        const html = await render(caller, { path: page });
        // The words on the card: every tag stripped, so what is left is what a person reads.
        const words = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        expect({ page, words }).toEqual({ page, words: expect.not.stringMatching(/403|401|\//) });
        expect(words).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
        expect(words).not.toMatch(page);
        // The one path in the markup at all is the href of the way out — where they *can* go.
        const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        expect(hrefs).toEqual([caller.kind === "STAFF" && caller.role === "FRONT_DESK" ? "/live-map" : caller.kind === "STAFF" ? "/today" : "/login"]);
      }
    }
  });

  it("reads the session once, through the one reader", async () => {
    await render(CALLERS.frontDesk, { path: "/today" });
    expect(getCaller).toHaveBeenCalledTimes(1);
  });
});

describe("the DEMO bar and the Simulated chip, from the one place that mounts them", () => {
  const source = readFileSync(path.join(__dirname, "NoAccess.tsx"), "utf8");

  it("come from the root layout, which is above this card on this route like every other", () => {
    // `DemoBar` is the bar plus the one session read that decides whether it draws its control.
    expect(readFileSync(path.join(__dirname, "..", "app", "layout.tsx"), "utf8")).toMatch(/<DemoBar \/>/);
    // And the card mounts none of them itself: one bar and one chip per screen (NFR-09).
    expect(source).not.toMatch(/DemoBar|DemoBanner|ScreenSource|SourceBadge/);
  });
});

describe("it sits on the sign-in shell, in brand tokens", () => {
  const css = readFileSync(path.join(__dirname, "NoAccess.module.css"), "utf8");

  it("composes the card, the page frame and the heading from login.module.css", () => {
    for (const className of ["page", "card", "heading"]) {
      expect(css).toMatch(
        new RegExp(`\\.${className} \\{\\s*composes: ${className} from "\\.\\./app/login/login\\.module\\.css";`),
      );
    }
  });

  it("styles every colour through a token (no-hex.test.ts covers the literals)", () => {
    expect(css).toMatch(/color: var\(--color-ink-muted\)/);
    expect(css).toMatch(/color: var\(--color-brand\)/);
    expect(css).toMatch(/min-height: var\(--target-console\)/);
    // Nothing removes the underline: colour is never the only cue (§9).
    expect(css).not.toMatch(/text-decoration/);
  });
});
