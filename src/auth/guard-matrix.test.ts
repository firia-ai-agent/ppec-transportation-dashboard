import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
/*
 * Next's own two functions for reading a thrown interrupt. They are the ones the app router
 * calls when it turns the throw into a response, so the status asserted per denied cell below
 * is the status the server sends — not a digest string this file made up and then matched
 * against itself. PR-BODY.md carries the same numbers measured with curl against
 * `next build && next start`.
 */
import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";
import {
  ENDPOINTS,
  MOVED_PAGES,
  PAGES,
  ROLE_LADDER,
  homePathFor,
  pageLabel,
  pageOutcome,
  pathOfHref,
  rolesWhoCanOpen,
  whoCanOpenLine,
  type Caller,
} from "./access";
import type { Membership } from "./core";
import { apiAccess, fill, noAccess } from "@/ui/copy";
import { NOT_ON_YOUR_MENU, withNotice } from "@/ui/notice";

/**
 * THE MATRIX: every role × every page, and every role × every endpoint, asked of the server.
 *
 * Each page module and each route handler is imported and **called**, so what is asserted is
 * what the server does, not what a nav rail shows. The ID-swap skill's rule 6 is the reason:
 * hiding a link is not denying a request, and three earlier reviews passed an app where it was.
 *
 * The page list is built by walking src/app, not written out here, so a page added without a row
 * in the access table fails this file (and access.test.ts) before it can be deployed.
 *
 * What a cell asserts, per outcome:
 *  - ALLOW      → the page function returns, i.e. it rendered for that role;
 *  - SIGN_IN    → it threw Next's redirect, to /login;
 *  - NO_ACCESS, caller holds a role → it threw Next's redirect, to **their own home** carrying
 *                 `?notice=not-on-your-menu` (§9.3, Firia/Vera 2026-10-17). The refusal page was
 *                 a dead end on production — a card and no way back — so a person who has a
 *                 screen of their own is put on it and told why. Nothing is loosened: the page
 *                 still does not render for them, and the API cells below still answer 403 to
 *                 the same caller;
 *  - NO_ACCESS, caller holds no role anywhere → **both halves of the answer**, because a status
 *                 code with the page still in the body is not a refusal:
 *                   · the status — Next's own `getAccessFallbackHTTPStatus` on the thrown
 *                     interrupt, which must be exactly 403;
 *                   · the body — the `forbidden.tsx` Next would render for that page, rendered
 *                     to HTML here and held to the no-access card's own words and nothing else:
 *                     none of the sentences the page puts on the screen for a role that may open
 *                     it, no status code, no role key, no site or user id, no name, and not the
 *                     path that was asked for.
 *
 * Mocks, and why each one is honest:
 *  - `@/auth/caller` — the one session reader. Stubbing it is how a role is put on the request;
 *    the reader's own steps (token → active user → memberships, including a disabled user) are
 *    tested against a real database in caller.test.ts, and the site-scoping writes in
 *    idswap.test.ts.
 *  - `@/auth` and `next-auth` — Auth.js's module scope wants `next/server`, which resolves only
 *    inside Next. Nothing here calls into it; the pages reach the session through `getCaller`,
 *    and /login only uses `AuthError` to tell a bad password from a real failure.
 *  - `@/modules/live-map/LiveMapScreen` — a client component that pulls in MapLibre. The page is
 *    being called for its guard, and the pane has its own tests (src/components/map/pane.test.ts).
 *    It replaced #53's own screen component, which is deleted.
 *  - `@/db/exec` — `getNeonDb` throws a sentinel, so "the handler reached the database" is
 *    observable, and a refusal that was supposed to happen first shows up as a 200 or a throw.
 */
const SRC = path.resolve(__dirname, "..");
const REPO = path.resolve(SRC, "..");
const APP = path.join(SRC, "app");

const DB_OPENED = "stub: the handler opened the database";

/** A caller as the one session reader hands it over: a role, and the memberships behind it. */
type Resolved = Caller & { displayName?: string; memberships: readonly Membership[] };

const getCaller = vi.fn<() => Promise<Resolved>>();
const getNeonDb = vi.fn(() => {
  throw new Error(DB_OPENED);
});

vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => null),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: { GET: vi.fn(), POST: vi.fn() },
}));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/modules/live-map/LiveMapScreen", () => ({ default: () => null }));
vi.mock("@/db/exec", () => ({ getNeonDb, runAfterCommit: vi.fn() }));
/*
 * The console shell, as a pass-through. Since Vera's review (2026-10-17 4:19 PM ET) the 403
 * boundaries render the refusal card *inside the app frame* — header, account menu, and this
 * role's own menu — so that a refusal is not a dead end (src/ui/RefusedPage.tsx). On most
 * routes that frame comes from the folder's layout and the boundary is only the card; on the
 * rest the boundary mounts it. What this file reads is the card either way: the body a 403
 * answers with, asserted as an equality so that nothing else can be hiding in it. The frame is
 * chrome — it carries the signed-in person's own name on purpose — and its rules are
 * src/ui/refused-frame.test.ts and e2e/one-menu.spec.ts, which measures it in a browser.
 *
 * It is `async` so that `toHtml` below unwraps it the way it unwraps any server component and
 * reaches the card inside.
 *
 * It does render the one part of the frame that is the refusal's own words: the page header
 * bar's title. The address a refusal is answered at has no row in the access table to read a
 * title from, so the shared component hands the bar this card's heading and the card prints
 * none (#74, and src/ui/refused-frame.test.ts states the wiring) — dropping it here would make
 * the equality below read a refusal that has lost its heading as correct.
 */
vi.mock("@/ui/ConsoleShell", () => ({
  ConsoleShell: async ({ title, children }: { title?: string; children: ReactNode }) => {
    /*
     * The card inside is a server component as well, and `toHtml` below only unwraps the root
     * one — the legacy renderer cannot await a component nested inside markup. So it is
     * resolved here, which is what lets this stand-in put anything *around* the card at all.
     */
    const element = children as ReactElement<unknown>;
    const card =
      isValidElement(element) && typeof element.type === "function"
        ? await (element.type as (props: unknown) => Promise<ReactNode>)(element.props)
        : children;
    return createElement("div", null, title ? createElement("h1", null, title) : null, card);
  },
}));
/*
 * The real `next/link` wants a router from React context that exists only inside Next, and the
 * no-access card and two of the pages hold one. A plain anchor is enough: what is read off the
 * rendered HTML below is the words and the hrefs.
 */
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", props),
}));

/**
 * `useRouter`, and only `useRouter`, for the same reason as `next/link` above: it reads a router
 * out of a React context that exists only inside a mounted Next app, and this file renders page
 * trees with `renderToStaticMarkup`.
 *
 * It became necessary when #73's board started calling it (`plan-routes/board/PlanBoard.tsx`).
 * The *harness* renders `/plan-routes` for a role that may open it — that is how it learns which
 * of the page's own sentences a 403 must not echo back (`protectedPhrasesOf`) — so a client hook
 * throwing in there took out three cells that are about the guard and not about the board at all:
 * `/plan-routes as noRole`, `/plan-preview as noRole` (it redirects there) and the no-role sweep.
 *
 * The rest of the module is the real one, deliberately: `forbidden()`, `redirect()` and
 * `notFound()` are precisely what this file measures, and a stub of those would be a harness
 * marking its own homework. `importOriginal` keeps them.
 */
vi.mock("next/navigation", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/navigation")>();
  const noop = () => {};
  return {
    ...real,
    useRouter: () => ({ push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop }),
  };
});

/**
 * `forbidden()` is gated on the experiment that next.config.ts turns on; Next sets this variable
 * from that config at build time, and there is no Next build around a vitest worker, so it is set
 * here. The config itself is asserted below, because a page that cannot answer 403 is the whole
 * failure mode this guards against.
 */
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";

const SITE = "00000000-0000-7000-8000-000000000001";
const CALLERS: Record<string, Resolved> = {
  director: {
    kind: "STAFF", role: "DIRECTOR", userId: "00000000-0000-7000-8000-0000000000d1",
    displayName: "SYN Dana Director", memberships: [{ siteId: SITE, role: "DIRECTOR" }],
  },
  coordinator: {
    kind: "STAFF", role: "COORDINATOR", userId: "00000000-0000-7000-8000-0000000000c1",
    displayName: "SYN Casey Coordinator", memberships: [{ siteId: SITE, role: "COORDINATOR" }],
  },
  frontDesk: {
    kind: "STAFF", role: "FRONT_DESK", userId: "00000000-0000-7000-8000-0000000000f1",
    displayName: "SYN Frankie FrontDesk", memberships: [{ siteId: SITE, role: "FRONT_DESK" }],
  },
  /*
   * Signed in and a member of nothing — the role was removed, or was never granted. Refused
   * every staff page (there is no row they are in) and never bounced to sign-in, which would
   * only loop them. Their denied cells are the widest set in the table, so leaving them out of
   * this matrix left most of it untested.
   */
  noRole: { kind: "NO_ROLE", userId: "00000000-0000-7000-8000-0000000000e1", displayName: "SYN Nina NoRole", memberships: [] },
  signedOut: { kind: "ANONYMOUS", memberships: [] },
};

/**
 * What a refusal must never echo back, whoever it refuses: the site they belong to, and who
 * they are. Taken from the callers above rather than written out again, so adding a caller
 * extends the check with it.
 */
const IDENTIFIERS = [
  SITE,
  ...Object.values(CALLERS).flatMap((c) => [("userId" in c ? c.userId : undefined), c.displayName]),
].filter((v): v is string => typeof v === "string");

/* ───────────────────────────── the page list, from disk ───────────────────────────── */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** `src/app/(app)/today/page.tsx` → `/today`; `src/app/not-found.tsx` → `/_not-found`. */
function routePathOf(file: string): string {
  const parts = path.relative(APP, file).split(path.sep);
  const base = parts.pop() as string;
  const segments = parts.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  if (base === "not-found.tsx") return "/_not-found";
  return `/${segments.join("/")}`;
}

const pageFiles = walk(APP)
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .filter((f) => ["page.tsx", "not-found.tsx"].includes(path.basename(f)))
  .map((file) => ({ file, path: routePathOf(file) }));

/**
 * What a thrown Next interrupt was: a redirect (and where to), or an HTTP answer — with the
 * status read by Next's own `getAccessFallbackHTTPStatus`, which is what the app router calls to
 * decide the status line. So `{ kind: "http", status: 403 }` below is the response's status, one
 * function away, rather than a digest literal.
 */
function interrupt(error: unknown): { kind: "redirect"; to: string } | { kind: "http"; status: number } | null {
  if (isHTTPAccessFallbackError(error)) return { kind: "http", status: getAccessFallbackHTTPStatus(error) };
  const digest = (error as { digest?: unknown })?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
    return { kind: "redirect", to: digest.split(";")[2] };
  }
  return null;
}

/** Calls the page the way Next calls it, and says what happened. */
async function openPage(file: string): Promise<{ rendered: true } | { rendered: false; interrupt: ReturnType<typeof interrupt> }> {
  const mod = (await import(/* @vite-ignore */ file)) as {
    default: (props: unknown) => Promise<unknown> | unknown;
  };
  try {
    // Every page is handed the props Next hands it; the ones that take none ignore them.
    await mod.default({ searchParams: Promise.resolve({}), params: Promise.resolve({}), children: null });
    return { rendered: true };
  } catch (e) {
    const i = interrupt(e);
    if (!i) throw e;
    return { rendered: false, interrupt: i };
  }
}

/* ──────────────── the body a refusal answers with ──────────────── */

/** An async server component, which the server awaits before it renders what it returned. */
const isAsyncComponent = (type: unknown): boolean =>
  typeof type === "function" && (type as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction";

/** The words a person reads off rendered HTML: tags gone, entities undone, runs collapsed. */
function readable(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Renders a server component tree the way the server does: await the async ones, render the rest. */
async function toHtml(node: unknown): Promise<string> {
  let resolved = node;
  while (isValidElement(resolved) && isAsyncComponent(resolved.type)) {
    resolved = await (resolved.type as (props: unknown) => Promise<unknown>)(resolved.props);
  }
  return renderToStaticMarkup(resolved as ReactElement);
}

/**
 * The `forbidden.tsx` Next would render for this page: the nearest one at or above it, which is
 * how Next resolves a boundary. access.test.ts holds that every role-restricted page has one.
 */
function boundaryFor(file: string): string {
  for (let dir = path.dirname(file); dir.startsWith(APP); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "forbidden.tsx");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no forbidden.tsx at or above ${file}`);
}

/**
 * The sentences this page puts on the screen for a role that *is* allowed to open it — the
 * protected half of the page, in its own words, which is what a refusal must not contain. Read
 * off a real render rather than written out here, so a page that grows new content grows the
 * check with it. Memoised: the same seven pages are asked for once per denied cell.
 */
const phrases = new Map<string, readonly string[]>();
async function protectedPhrasesOf(page: { file: string; path: string }): Promise<readonly string[]> {
  const cached = phrases.get(page.path);
  if (cached) return cached;
  /*
   * A redirect page renders nothing of its own, so the words its 403 must not carry are the
   * *destination* screen's words — which is the stronger question anyway: refused at
   * `/ramp-preview`, do you see any of the ramp iPad?
   */
  const moved = MOVED_PAGES[page.path];
  // `pathOfHref`, because one destination is a *tab* — `/family-texts?tab=for-you` — and the
  // row, and the file, belong to the path in front of the query.
  const subject = moved
    ? (pageFiles.find((f) => f.path === pathOfHref(moved)) as { file: string; path: string })
    : page;
  expect(subject, page.path).toBeDefined();
  const allowed = ROLE_LADDER.find((role) => rolesWhoCanOpen(page.path).includes(role));
  expect(allowed, page.path).toBeDefined();
  getCaller.mockResolvedValue({
    kind: "STAFF", role: allowed as Membership["role"], userId: "00000000-0000-7000-8000-0000000000d1",
    displayName: "SYN Dana Director", memberships: [{ siteId: SITE, role: allowed as Membership["role"] }],
  });
  const mod = (await import(/* @vite-ignore */ subject.file)) as { default: (p: unknown) => Promise<unknown> };
  const html = await toHtml(await mod.default({ searchParams: Promise.resolve({}), params: Promise.resolve({}) }));
  const found = readable(html)
    .split(/[.!?·|•]+/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 12 && phrase.split(" ").length >= 3);
  /*
   * A page with something on it has to have said something, or the leak check below is vacuous.
   * Two screens legitimately say nothing at all now: Family texts and Health hold no data, their
   * title is the frame's page header bar (audit §2 item 1) and the helper line that used to sit
   * under it is deleted (§4 item 9) — so what they render is a link, or nothing. The assertion
   * is therefore "nothing to protect *because* the page is empty", measured on the page's own
   * text rather than assumed: a screen that grows a sentence grows the check with it.
   */
  if (found.length === 0) {
    const left = readable(html).trim();
    expect(
      left.split(/\s+/).filter(Boolean).length,
      `${page.path} rendered a sentence this did not read: ${left}`,
    ).toBeLessThan(3);
  }
  phrases.set(page.path, found);
  return found;
}

/**
 * The second half of a denied cell: what came back in the body.
 *
 * A 403 whose body still carried the page would be a refusal in the status line and a leak
 * everywhere else, so the HTML the refusal answers with is rendered here and held to four
 * things:
 *  1. it is the no-access card, **exactly** — the heading, the line naming who the page is for,
 *    and one way out. Asserted as equality, not as "contains", because equality leaves no room
 *    for anything else to be in there;
 *  2. none of the sentences the page itself shows a role that may open it;
 *  3. no status code, no role key, no site id, no user id and no name;
 *  4. one link, and it goes where this caller *can* go — not back at the page they were refused.
 */
async function expectNothingLeaked(page: { file: string; path: string }, who: string, caller: Resolved) {
  const protectedPhrases = await protectedPhrasesOf(page);
  getCaller.mockResolvedValue(caller);
  const html = await toHtml((await import(/* @vite-ignore */ boundaryFor(page.file))).default({}));
  const words = readable(html);
  const home = homePathFor(caller);
  const cell = `${page.path} as ${who}`;

  /*
   * Two cards, and which one a caller gets is the caller's own: a role refused one page is told
   * who that page is for, and someone who holds no role at any site is told what is true of
   * their account instead (`noRoleHeading`/`noRoleLine`, Vera's copy) — every page refuses them,
   * so naming the roles that could open this one tells them nothing they can act on. Still
   * equality, not "contains", for both: it leaves no room for anything else to be in there.
   */
  const card =
    caller.kind === "NO_ROLE"
      ? `${noAccess.noRoleHeading} ${noAccess.noRoleLine}`
      : `${noAccess.heading} ${whoCanOpenLine(page.path)}`;
  expect({ cell, words }).toEqual({
    cell,
    words: `${card} ${fill(noAccess.back, { page: pageLabel(home) })}`,
  });
  for (const phrase of protectedPhrases) expect({ cell, phrase, words }).toEqual({ cell, phrase, words: expect.not.stringContaining(phrase) });
  expect(words).not.toMatch(/\b(401|403|404)\b/);
  expect(words).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
  for (const id of IDENTIFIERS) expect(html).not.toContain(id);
  expect(words).not.toContain(page.path);
  expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([home]);
}

beforeEach(() => {
  getCaller.mockReset();
  getNeonDb.mockClear();
});

describe("the harness itself works", () => {
  it("found every page on disk and can name each one's route", () => {
    const paths = pageFiles.map((p) => p.path).sort();
    expect(paths).toEqual(
      [
        "/", "/_not-found", "/family-texts", "/health", "/login",
        "/live-map", "/plan-routes", "/ramp-ipad", "/setup", "/today", "/whoami",
        // The refusal card at an address: a session, and then 403 for every one of them.
        "/refusal-check",
        /*
         * The addresses that moved, which are pages too: a guard, then a permanent redirect.
         * Five of them since Firia's 8:36 PM ET ruling — the three renamed screens, plus
         * `/exceptions` and `/approvals`, whose content is part of another screen now.
         */
        ...Object.keys(MOVED_PAGES),
      ].sort(),
    );
  });

  it("every page it found has a row in the access table", () => {
    for (const page of pageFiles) {
      expect(PAGES.map((p) => p.path), page.file).toContain(page.path);
    }
  });

  it("the 403 interrupt is enabled in next.config.ts, or no page could answer 403 at all", () => {
    expect(readFileSync(path.join(REPO, "next.config.ts"), "utf8")).toMatch(
      /experimental:\s*\{\s*authInterrupts:\s*true\s*\}/,
    );
  });
});

describe("every page, for every role and for a signed-out visitor", () => {
  for (const [who, caller] of Object.entries(CALLERS)) {
    for (const page of pageFiles) {
      it(`${page.path} as ${who}`, async () => {
        getCaller.mockResolvedValue(caller);
        const expected = pageOutcome(caller, page.path);
        const result = await openPage(page.file);

        if (page.path === "/") {
          // The entry route always redirects, to wherever this caller's own first page is.
          expect(result).toEqual({ rendered: false, interrupt: { kind: "redirect", to: homePathFor(caller) } });
          return;
        }
        if (page.path === "/refusal-check") {
          /*
           * The refusal card at an address (src/app/refusal-check/page.tsx). Its row is a bare
           * session, so the guard lets every signed-in caller through and sends a signed-out
           * one to sign-in like any other page — and then the body refuses them all, which is
           * the only reason the route exists: the card is otherwise unreachable in a browser
           * for any staff role (§9.3 sends them home instead), so there was no way to look at
           * it. Nothing is read and nothing is rendered, so there is nothing here to leak.
           */
          expect(result).toEqual(
            expected === "SIGN_IN"
              ? { rendered: false, interrupt: { kind: "redirect", to: "/login" } }
              : { rendered: false, interrupt: { kind: "http", status: 403 } },
          );
          return;
        }
        if (expected === "ALLOW") {
          /*
           * The three old addresses are pages whose whole body is a redirect: a caller who may
           * open the destination is sent there, and the guard has already run by then. Everyone
           * else falls through to the SIGN_IN and NO_ACCESS branches below, exactly as on the
           * destination — which is what keeps a redirect from answering "that screen exists".
           */
          const moved = MOVED_PAGES[page.path];
          expect(result).toEqual(
            moved
              ? { rendered: false, interrupt: { kind: "redirect", to: moved } }
              : { rendered: true },
          );
          return;
        }
        if (expected === "SIGN_IN") {
          expect(result).toEqual({ rendered: false, interrupt: { kind: "redirect", to: "/login" } });
          return;
        }
        expect(expected).toBe("NO_ACCESS");
        if (caller.kind === "STAFF") {
          /*
           * A role with pages of its own is moved to the first of them and told why, rather
           * than shown a card it cannot leave (§9.3). The destination is `homePathFor`, which
           * reads the same table that just refused, so it is never a page they would be
           * refused again.
           */
          expect(result).toEqual({
            rendered: false,
            interrupt: {
              kind: "redirect",
              to: withNotice(homePathFor(caller), NOT_ON_YOUR_MENU),
            },
          });
          return;
        }
        // Half one: the status line is a real 403, as Next's own reader reports it.
        expect(result).toEqual({ rendered: false, interrupt: { kind: "http", status: 403 } });
        // Half two: and the body it answers with holds nothing the page would have shown.
        await expectNothingLeaked(page, who, caller);
      });
    }
  }

  /**
   * The front desk, on the four console pages their row does not open. None of them renders —
   * which is the half that matters — and none of them answers with the refusal card either:
   * they land on the live map, their own home since Firia's 3:08 PM ET ruling, with the one
   * line that says why. The page module is still the thing being called, so this is the
   * server's answer and not a rail's.
   */
  it("the front desk is sent home from every console page, never shown a refusal", async () => {
    const home = withNotice(homePathFor(CALLERS.frontDesk), NOT_ON_YOUR_MENU);
    expect(home).toBe("/live-map?notice=not-on-your-menu");
    for (const p of [
      "/today", "/exceptions", "/setup", "/health", "/plan-routes", "/family-texts", "/approvals",
    ]) {
      const page = pageFiles.find((f) => f.path === p) as { file: string; path: string };
      getCaller.mockResolvedValue(CALLERS.frontDesk);
      expect({ p, ...(await openPage(page.file)) }).toEqual({
        p, rendered: false, interrupt: { kind: "redirect", to: home },
      });
    }
  });

  it("a signed-in person with no role anywhere is refused every staff page, body and all", async () => {
    const staffPages = pageFiles.filter((p) => pageOutcome(CALLERS.noRole, p.path) === "NO_ACCESS");
    // Every page that asks for a role at all: the console pages (the founder's redesign adds
    // Family texts and the approvals queue inside it), the three screens that are routes
    // outside that group, the account page, and the three redirects standing in front of them.
    expect(staffPages.map((p) => p.path).sort()).toEqual(
      [
        "/approvals", "/exceptions", "/family-texts", "/health", "/live-map", "/map-preview",
        "/plan-preview", "/plan-routes", "/ramp-ipad", "/ramp-preview", "/setup", "/today",
        "/whoami",
      ],
    );
    for (const page of staffPages) {
      getCaller.mockResolvedValue(CALLERS.noRole);
      expect({ p: page.path, ...(await openPage(page.file)) }).toEqual({
        p: page.path, rendered: false, interrupt: { kind: "http", status: 403 },
      });
      await expectNothingLeaked(page, "noRole", CALLERS.noRole);
    }
  });

  it("the refusal carries the status and no page, with nothing on screen that says 403", async () => {
    /*
     * The two halves of the acceptance bar, said once in one place: the number lives in the
     * status line, the words live on the card, and the two never swap. `forbidden()` is where
     * the status comes from (src/auth/page-guard.ts) and the card is what the boundary renders;
     * neither the guard nor the copy may name a code (no-access.test.ts scans the copy too).
     */
    const page = pageFiles.find((f) => f.path === "/today") as { file: string; path: string };
    // The caller who still gets the card: signed in, no membership anywhere, no home to go to.
    getCaller.mockResolvedValue(CALLERS.noRole);
    const refused = await openPage(page.file);
    expect(refused).toEqual({ rendered: false, interrupt: { kind: "http", status: 403 } });
    getCaller.mockResolvedValue(CALLERS.noRole);
    const body = readable(await toHtml((await import(/* @vite-ignore */ boundaryFor(page.file))).default({})));
    expect(body).toContain(noAccess.noRoleHeading);
    expect(body).not.toMatch(/40\d/);
    expect(readFileSync(path.join(SRC, "auth", "page-guard.ts"), "utf8")).toMatch(/forbidden\(\)/);
  });

  /**
   * The console shell, asked directly — and there are four layouts mounting it now: the `(app)`
   * group, and one each for Plan routes, the live map and the ramp iPad, which are routes
   * outside that group and rendered with no shell (and so no menu) until 2026-10-17.
   *
   * Every one of them must behave the same way: any session in, no session to sign-in, and the
   * *role* left to the page inside. The front desk is the caller that proves the second half —
   * they may not open /plan-routes, and the layout must still let them in so the refusal comes
   * from the page and the no-access card can say who the page is for. The menu these layouts
   * draw is a courtesy either way; src/ui/nav-items.ts filters it with this same table.
   */
  it.each([["(app)"], ["plan-routes"], ["live-map"], ["ramp-ipad"]])(
    "the %s shell lets any session in and leaves the role to the page inside it",
    async (dir) => {
      const layout = path.join(APP, dir, "layout.tsx");
      for (const caller of [CALLERS.director, CALLERS.coordinator, CALLERS.frontDesk, CALLERS.noRole]) {
        getCaller.mockResolvedValue(caller);
        expect({ dir, ...(await openPage(layout)) }).toEqual({ dir, rendered: true });
      }
      getCaller.mockResolvedValue(CALLERS.signedOut);
      expect(await openPage(layout)).toEqual({
        rendered: false,
        interrupt: { kind: "redirect", to: "/login" },
      });
    },
  );
});

/* ───────────────────────────── the endpoints ───────────────────────────── */

const saved = { ...process.env };
const DEMO_ON = { DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC" };

async function callRoute(
  file: string,
  method: "GET" | "POST",
  init: RequestInit & { env?: Record<string, string | undefined> } = {},
): Promise<Response> {
  process.env = { ...saved, ...DEMO_ON, DATABASE_URL: undefined, ...(init.env ?? {}) };
  process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, (req: Request) => Promise<Response>>;
  const handler = mod[method];
  return handler(new Request("https://example.test/called-by-the-matrix", { method, body: init.body }));
}

const ROUTE = (...parts: string[]) => path.join(APP, "api", ...parts, "route.ts");

describe("the session endpoint, for every role and for a signed-out caller", () => {
  /**
   * The one session route, cell by cell. A session route answers two different refusals and the
   * difference is deliberate: **401** means "no usable session" (none, or one whose user is
   * disabled or gone) and **403** means "signed in, this is not your role". A person who was
   * disabled mid-session must be told to sign in, not told their role is wrong.
   */
  const EXPECTED: Record<string, { status: number; error: string } | "reached the db"> = {
    director: "reached the db",
    coordinator: { status: 403, error: apiAccess.notYourRole },
    frontDesk: { status: 403, error: apiAccess.notYourRole },
    noRole: { status: 403, error: apiAccess.notYourRole },
    signedOut: { status: 401, error: apiAccess.signIn },
  };

  /**
   * What an API refusal is allowed to be: the status, and a bare JSON object carrying one plain
   * sentence. Asserted as equality on the parsed body — keys included — so there is no room in
   * it for a page, a role key, an id, or the site id the request named. "No page in the body" is
   * the point: a 403 that answered with HTML would be handing a denied caller a rendered screen.
   */
  async function expectBareRefusal(res: Response, who: string, expected: { status: number; error: string }, named: string) {
    const text = await res.text();
    expect({ who, status: res.status }).toEqual({ who, status: expected.status });
    expect({ who, body: JSON.parse(text) }).toEqual({ who, body: { ok: false, error: expected.error } });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Not a page: no markup of any kind, and nothing of the console in it.
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toContain("<!DOCTYPE");
    // Nor the site id it was handed, which would confirm that id to someone guessing with it.
    expect(text).not.toContain(named);
    expect(text).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
    expect(text).not.toMatch(/\b(400|401|403|404)\b/);
    for (const id of IDENTIFIERS) expect(text).not.toContain(id);
    // And it never reached the data it was refused.
    expect(getNeonDb).not.toHaveBeenCalled();
  }

  it("POST /api/demo/reset is the director's alone: 401 signed out, 403 for every other role", async () => {
    for (const [who, caller] of Object.entries(CALLERS)) {
      getCaller.mockResolvedValue(caller);
      getNeonDb.mockClear();
      const expected = EXPECTED[who];
      if (expected === "reached the db") {
        // Past both guards: the only thing left is the work, and the DB stub says so.
        await expect(callRoute(ROUTE("demo", "reset"), "POST", { body: "{}" })).rejects.toThrow(DB_OPENED);
        continue;
      }
      const res = await callRoute(ROUTE("demo", "reset"), "POST", { body: "{}" });
      await expectBareRefusal(res, who, expected, SITE);
    }
  });

  it("names a site in the body and it is still refused, in the same words, echoing no id back", async () => {
    for (const [who, caller] of Object.entries(CALLERS)) {
      const expected = EXPECTED[who];
      if (expected === "reached the db") continue;
      getCaller.mockResolvedValue(caller);
      getNeonDb.mockClear();
      const res = await callRoute(ROUTE("demo", "reset"), "POST", { body: JSON.stringify({ siteId: SITE }) });
      await expectBareRefusal(res, who, expected, SITE);
    }
  });

  it("the two unguarded server actions take no session, so neither has a cell to deny", () => {
    /*
     * Sign-in must run for someone who has no session by definition, and sign-out must keep
     * working for someone whose role was just removed — so neither is role-gated and there is no
     * refusal of theirs to assert a body for. The access table says so (access.test.ts writes
     * the rows out), and this is the line that would fail the day one of them became a session
     * surface without a guarded refusal to go with it.
     *
     * The approvals decision is the opposite kind and is listed with its guard: it is the "For
     * you" tab's one control, it takes a session, and `APPROVAL_ROLES` is what it answers to
     * (`front-desk-cannot-approve.test.ts` holds the 403). A new action landing here with
     * `auth.kind` anything but `session` is what this list is for.
     */
    const actions = ENDPOINTS.filter((row) => row.kind === "action");
    expect(actions.map((a) => [a.path, a.auth.kind])).toEqual([
      ["action:approval-decision", "session"],
      ["action:sign-in", "auth-endpoint"],
      ["action:sign-out", "public"],
    ]);
  });
});

/**
 * The session guard's own refusals, which no route reaches for us: a session route is the only
 * thing it will vouch for, so a cron, queue or Auth.js path handed to it is refused — and so is
 * a path that has no row in the table at all, which is what a route added without a row looks
 * like from in here. Both are a bare 403 for every caller, a director included: the status says
 * no and the body carries one sentence.
 */
describe("the session guard refuses the routes a session must not open", () => {
  const nonSession = ENDPOINTS.filter((e) => e.auth.kind !== "session" && e.auth.kind !== "public").map((e) => e.path);

  it.each([...nonSession, "/api/added-without-a-row"])("%s", async (route) => {
    const { requireApiSession } = await import("@/auth/api-guard");
    for (const [who, caller] of Object.entries(CALLERS)) {
      getCaller.mockResolvedValue(caller);
      const guard = await requireApiSession(route);
      expect({ route, who, ok: guard.ok }).toEqual({ route, who, ok: false });
      if (guard.ok) continue;
      const text = await guard.response.text();
      expect({ route, who, status: guard.response.status }).toEqual({ route, who, status: 403 });
      expect(JSON.parse(text)).toEqual({ ok: false, error: apiAccess.notYourRole });
      // Bare: no markup, no route path, no role key, no code, nothing of the caller.
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toContain(route);
      expect(text).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|\b403\b/);
      for (const id of IDENTIFIERS) expect(text).not.toContain(id);
    }
  });
});

describe("the cron endpoints keep the cron secret, and a session is not a way in", () => {
  const secret = "test-cron-".padEnd(32, "x");

  it.each([
    ["sweep", ROUTE("cron", "sweep")],
    ["delay probe", ROUTE("probe", "delay")],
  ])("%s answers 401 without the bearer secret, whoever is signed in", async (_name, file) => {
    for (const caller of Object.values(CALLERS)) {
      getCaller.mockResolvedValue(caller);
      getNeonDb.mockClear();
      const res = await callRoute(file, "GET", { env: { CRON_SECRET: secret } });
      expect(res.status).toBe(401);
      expect(getNeonDb).not.toHaveBeenCalled();
      // The session reader is not even consulted: these routes do not take a session.
      expect(getCaller).not.toHaveBeenCalled();
      /*
       * And the refusal is bare: no secret, no markup, no sweep result and no id. These two
       * routes claim jobs and send the outbox, so their 401 is the one body with real work
       * behind it to leak.
       */
      const text = await res.text();
      expect(text).not.toContain(secret);
      expect(text.length).toBeLessThan(200);
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|claimed|outbox|postgres/i);
      for (const id of IDENTIFIERS) expect(text).not.toContain(id);
    }
  });

  it.each([
    ["sweep", ROUTE("cron", "sweep")],
    ["delay probe", ROUTE("probe", "delay")],
  ])("%s still fails closed when the secret is unset, which is when a session would be tempting", async (_name, file) => {
    getCaller.mockResolvedValue(CALLERS.director);
    const res = await callRoute(file, "GET", { env: { CRON_SECRET: undefined } });
    expect(res.status).toBe(401);
    expect(getCaller).not.toHaveBeenCalled();
  });
});

describe("the queue endpoints are the platform's, and a session is not a way in", () => {
  it.each([
    ["timer", ROUTE("queues", "timer")],
    ["outbox", ROUTE("queues", "outbox")],
    ["delay probe consumer", ROUTE("queues", "delay-probe")],
  ])("%s refuses a hand-rolled POST and never runs its handler", async (_name, file) => {
    for (const caller of Object.values(CALLERS)) {
      getCaller.mockResolvedValue(caller);
      getNeonDb.mockClear();
      // A plain POST, exactly what a signed-in person with the URL could send. The queue
      // callback refuses it: the message headers the platform sends are not there.
      const res = await callRoute(file, "POST", { body: JSON.stringify({ jobId: "j1", messageId: "m1" }) });
      expect({ caller: caller.kind, ok: res.ok }).toEqual({ caller: caller.kind, ok: false });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(getNeonDb).not.toHaveBeenCalled();
      expect(getCaller).not.toHaveBeenCalled();
      // The platform's own refusal, and it is bare too: a shape complaint, no page, no data.
      const text = await res.text();
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
      for (const id of IDENTIFIERS) expect(text).not.toContain(id);
    }
  });
});

describe("the two deliberately open endpoints", () => {
  it("the deployment probe answers anyone, and carries no site data (it is an OPEN QUESTION in the PR)", async () => {
    for (const caller of Object.values(CALLERS)) {
      getCaller.mockResolvedValue(caller);
      const res = await callRoute(ROUTE("health"), "GET");
      expect(res.status).toBe(200);
      const body = await res.text();
      for (const secretish of ["password", "AUTH_SECRET", "CRON_SECRET", "postgres://"]) {
        expect(body).not.toContain(secretish);
      }
    }
  });

  it("Auth.js's own handlers stay reachable, because sign-in has to be", () => {
    // Not invoked here: calling it would be testing next-auth, and it must answer a caller who
    // has no session by definition. Its row in the access table says `auth-endpoint`, and
    // access.test.ts holds the file to that row.
    const source = readFileSync(path.join(APP, "api", "auth", "[...nextauth]", "route.ts"), "utf8");
    expect(source).toMatch(/export const \{ GET, POST \} = handlers/);
  });
});
