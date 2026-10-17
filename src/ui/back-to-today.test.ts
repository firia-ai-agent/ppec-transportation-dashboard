import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fill, nav } from "./copy";
import { pageLabel, rolesWhoCanOpen, type Caller } from "@/auth/access";

/**
 * THE WAY BACK from the three screens that have no rail (src/ui/BackToToday.tsx).
 *
 * Plan routes, the live map and the ramp iPad are full-screen routes outside the console
 * layout, so none of them renders the nav rail and none of them had a link to the board
 * (Firia, 2026-10-17). What this file holds is the two things that can go wrong with such a
 * link: it can offer a role a page that role's row in the access table refuses, and it can
 * become three copies that drift.
 *
 * Rendered for real with `renderToStaticMarkup`; `next/link` is stubbed to a plain anchor
 * because the real one wants a router from React context that only exists inside Next. No
 * session is read — the component takes the caller the page's own guard already resolved — so
 * there is no token to decode and no database to open here.
 */
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", props),
}));

const CALLERS = {
  director: { kind: "STAFF", role: "DIRECTOR", userId: "u-d" },
  coordinator: { kind: "STAFF", role: "COORDINATOR", userId: "u-c" },
  frontDesk: { kind: "STAFF", role: "FRONT_DESK", userId: "u-f" },
  noRole: { kind: "NO_ROLE", userId: "u-n" },
  anonymous: { kind: "ANONYMOUS" },
} satisfies Record<string, Caller>;

async function render(caller: Caller): Promise<string> {
  const { BackToToday } = await import("./BackToToday");
  return renderToStaticMarkup(createElement(BackToToday, { caller }));
}

/** The three rail-less routes the link is rendered on, and their page files. */
const SCREENS = [
  { path: "/plan-routes", file: "plan-routes/page.tsx" },
  { path: "/live-map", file: "live-map/page.tsx" },
  { path: "/ramp-ipad", file: "ramp-ipad/page.tsx" },
] as const;

const APP = path.resolve(__dirname, "..", "app");

describe("the link itself", () => {
  it("says the board's own words, and goes to the board", async () => {
    const html = await render(CALLERS.director);
    expect(html).toContain(fill(nav.backTo, { page: pageLabel("/today") }));
    expect(html).toContain('href="/today"');
    // The destination is named by its row in the access table, which is `nav.today`, so the
    // link cannot call the board something the board does not call itself.
    expect(fill(nav.backTo, { page: pageLabel("/today") })).toBe(`Back to ${nav.today}`);
    expect(pageLabel("/today")).toBe(nav.today);
  });

  it("is one link and nothing else: no second nav landmark on these screens", async () => {
    const html = await render(CALLERS.director);
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<nav\b/);
  });
});

/**
 * The access table decides, not this component.
 *
 * The board is the two console roles' page, so the front desk — whose own surface is the ramp
 * iPad the link would sit on — is offered nothing rather than a link to a 403. The filter *is*
 * `canOpenPage`, the same function the rail filters with and the guard answers from, which is
 * why this suite can assert the outcome role by role without a second list of roles anywhere.
 *
 * Hiding is not denying (the ID-swap rule): /today checks the table again on the server for
 * every request, and guard-matrix.test.ts asks it directly, with no browser involved.
 */
describe("it respects the role access table", () => {
  it("offers the link to every role whose own row opens the board", async () => {
    const allowed = rolesWhoCanOpen("/today");
    expect(allowed).toContain("DIRECTOR");
    expect(allowed).toContain("COORDINATOR");
    for (const caller of [CALLERS.director, CALLERS.coordinator]) {
      expect(await render(caller)).toContain('href="/today"');
    }
  });

  it("renders nothing at all for a role the board is not open to", async () => {
    expect(rolesWhoCanOpen("/today")).not.toContain("FRONT_DESK");
    for (const caller of [CALLERS.frontDesk, CALLERS.noRole, CALLERS.anonymous]) {
      expect(await render(caller)).toBe("");
    }
  });
});

/**
 * One component, three screens.
 *
 * The point of the change was a single link, not a paragraph of JSX pasted three times — so
 * each of the three pages renders `BackToToday` and none of them writes the words, the href or
 * the role check itself. Read off the page files, because that is the only place the mistake
 * could be made.
 */
describe("the three screens render the one component", () => {
  const source = (file: string): string => readFileSync(path.join(APP, file), "utf8");

  it("has the three page files it claims to read", () => {
    for (const screen of SCREENS) {
      expect(readdirSync(APP)).toContain(screen.file.split("/")[0]);
      expect(source(screen.file)).toMatch(/export default async function/);
    }
  });

  it("each one renders BackToToday with the caller its own guard returned", () => {
    for (const { path: route, file } of SCREENS) {
      const text = source(file);
      expect(text, file).toMatch(/import BackToToday from "@\/ui\/BackToToday"/);
      expect(text, file).toMatch(/<BackToToday caller=\{caller\} \/>/);
      expect(text, file).toContain(`const caller = await requirePage("${route}")`);
    }
  });

  it("and none of them writes the link's words, its address or its own role check", () => {
    for (const { file } of SCREENS) {
      const text = source(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/Back to/);
      expect(text, file).not.toMatch(/nav\.backTo/);
      expect(text, file).not.toMatch(/canOpenPage\(caller, "\/today"\)/);
    }
  });
});
