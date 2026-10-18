import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_STAFF,
  API,
  ENDPOINTS,
  LAYOUT,
  MOVED_PAGES,
  PAGES,
  POLICY,
  ROLE_LADDER,
  apiOutcome,
  canSeeNavItem,
  foundersQuestions,
  HOME_ORDER,
  homePathFor,
  mapViewerOf,
  mostCapable,
  pageLabel,
  pageOutcome,
  pathOfHref,
  rolesWhoCanOpen,
  whoCanOpenLine,
  type Caller,
} from "./access";
import { canOpenLiveMap, canOpenRampIpad } from "@/domain/access/map-view";
import { menuItems, navItems, navItemsFor } from "@/ui/nav-items";
import { noAccess } from "@/ui/copy";

/**
 * The access table against the filesystem.
 *
 * The point of these tests is that the table cannot fall behind the app. Everything here starts
 * from a `readdirSync` walk, never from a list written by hand, so a new page, a new route or a
 * new server action fails this file until it has a row — which is what makes "every surface is
 * guarded" a property of the build and not of whoever reviewed the pull request.
 *
 * What the walk finds, and what each kind must then prove:
 *  - `page.tsx` — a row, a `requirePage("<its path>")` call unless the row is public, and a
 *    `forbidden.tsx` beside it so the refusal is a 403 with words on it;
 *  - `layout.tsx` — a row (the console shell guards sign-in for everything inside it);
 *  - `route.ts` — a row, and the guard its row names: the shared session guard, the cron secret,
 *    the queue callback, or the webhook signature;
 *  - `"use server"` — a row, because a server action is a POST endpoint with no URL of its own.
 */
const SRC = path.resolve(__dirname, "..");
const REPO = path.resolve(SRC, "..");
const APP = path.join(SRC, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Repo-relative, posix-separated, the way the table writes a file. */
function rel(file: string): string {
  return path.relative(REPO, file).split(path.sep).join("/");
}

const appFiles = walk(APP).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

/**
 * Next's file conventions, split by what they are to a guard:
 *  - a surface answers a request, so it needs a row (`not-found.tsx` is a page like any other);
 *  - a boundary is what a guard *renders*, so it needs a page to belong to, not a row;
 *  - the rest are conventions this app does not use yet. They are named so that adding one
 *    fails this file: a new `error.tsx` or `default.tsx` that renders data would otherwise
 *    arrive with no row and no guard, and nothing here would notice.
 */
const SURFACE = ["page.tsx", "layout.tsx", "route.ts", "not-found.tsx"];
const BOUNDARY = ["forbidden.tsx"];
const UNUSED_CONVENTIONS = [
  "default.tsx", "error.tsx", "global-error.tsx", "global-not-found.tsx", "loading.tsx",
  "template.tsx", "unauthorized.tsx", "route.tsx", "page.ts", "layout.ts", "not-found.ts",
];

const surfaceFiles = {
  pages: appFiles.filter((f) => ["page.tsx", "not-found.tsx"].includes(path.basename(f))).map(rel),
  layouts: appFiles.filter((f) => path.basename(f) === "layout.tsx").map(rel),
  routes: appFiles.filter((f) => path.basename(f) === "route.ts").map(rel),
  /** The 403 boundaries. Not surfaces of their own: they are the answer a guard renders. */
  forbidden: appFiles.filter((f) => path.basename(f) === "forbidden.tsx").map(rel),
};

/** Every file under src/ that declares a server action. */
const actionFiles = walk(SRC)
  .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .filter((f) => /"use server"/.test(readFileSync(f, "utf8")))
  .map(rel);

const ROLES = ROLE_LADDER;
const callers: Record<string, Caller> = {
  director: { kind: "STAFF", role: "DIRECTOR", userId: "u-d" },
  coordinator: { kind: "STAFF", role: "COORDINATOR", userId: "u-c" },
  frontDesk: { kind: "STAFF", role: "FRONT_DESK", userId: "u-f" },
  noRole: { kind: "NO_ROLE", userId: "u-n" },
  signedOut: { kind: "ANONYMOUS" },
};

describe("the walk itself works", () => {
  it("finds the surfaces it claims to scan", () => {
    expect(surfaceFiles.pages.length).toBeGreaterThanOrEqual(9);
    expect(surfaceFiles.routes.length).toBeGreaterThanOrEqual(8);
    expect(surfaceFiles.layouts).toEqual(
      expect.arrayContaining([
        "src/app/layout.tsx",
        "src/app/(app)/layout.tsx",
        // The three screens outside that group carry the same shell from a layout of their own.
        "src/app/plan-routes/layout.tsx",
        "src/app/live-map/layout.tsx",
        "src/app/ramp-ipad/layout.tsx",
      ]),
    );
    expect(actionFiles).toEqual(expect.arrayContaining(["src/app/login/page.tsx", "src/ui/SignOutButton.tsx"]));
  });

  it("knows about every Next file convention it finds, so a new kind cannot arrive unguarded", () => {
    const unrecognised = appFiles
      .map((f) => path.basename(f))
      .filter((base) => UNUSED_CONVENTIONS.includes(base));
    expect(unrecognised).toEqual([]);
    expect([...SURFACE, ...BOUNDARY]).toContain("forbidden.tsx");
  });
});

describe("every surface in the filesystem has exactly one row", () => {
  it("every page, layout and route file is in the table, and every row's file exists", () => {
    const fromDisk = [...surfaceFiles.pages, ...surfaceFiles.layouts, ...surfaceFiles.routes].sort();
    const inTable = [
      ...PAGES.map((p) => p.file),
      ...ENDPOINTS.filter((e) => e.kind === "route").map((e) => e.file),
    ].sort();
    expect(inTable).toEqual(fromDisk);
    for (const row of POLICY) expect(existsSync(path.join(REPO, row.file)), row.file).toBe(true);
  });

  it("every server action is in the table as an action", () => {
    const declared = [...new Set(ENDPOINTS.filter((e) => e.kind === "action").map((e) => e.file))].sort();
    expect(declared).toEqual([...actionFiles].sort());
  });

  it("no path is claimed twice", () => {
    const paths = POLICY.map((row) => row.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

/**
 * The three addresses that moved. Vera's review (2026-10-17): no "preview" in any menu label or
 * address. The screens are at `/plan-routes`, `/live-map` and `/ramp-ipad`; the old addresses
 * still answer, because a URL that has been read out loud in a demo and bookmarked does not get
 * to start 404ing.
 *
 * What is asserted here is the pair, not the redirect alone: both ends have a row, the old row
 * is open to exactly the roles the new one is, and the redirect is permanent and happens *after*
 * the guard. A redirect that ran before the guard would answer "that screen exists" to a role
 * that may not open it.
 */
describe("the addresses that moved", () => {
  /** The three that are the same screen renamed, as opposed to a screen that became a tab. */
  const RENAMED = ["/plan-preview", "/map-preview", "/ramp-preview"];

  it("has no \"preview\" left in any address a screen is reached at, or any label", () => {
    const destinations = PAGES.filter((p) => p.kind === "page" && !(p.path in MOVED_PAGES));
    for (const row of destinations) {
      expect(row.path, row.file).not.toMatch(/preview/i);
      expect(row.label ?? "", row.file).not.toMatch(/preview/i);
    }
    // And the labels on the renamed rows are the destinations' labels, so there is no second
    // name for a screen hiding on an old address either.
    for (const from of RENAMED) {
      expect(pageLabel(from), from).toBe(pageLabel(MOVED_PAGES[from]));
      expect(pageLabel(from), from).not.toMatch(/preview/i);
    }
  });

  /**
   * Five pairs: the three renamed screens, and the two that became part of another screen
   * (Firia, 2026-10-17 8:36 PM ET). `/approvals` lands on a *tab* — `?tab=for-you` — so the row
   * at the other end is looked up by the path inside that address.
   */
  it("is these five pairs, with both ends in the table", () => {
    expect(MOVED_PAGES).toEqual({
      "/plan-preview": "/plan-routes",
      "/map-preview": "/live-map",
      "/ramp-preview": "/ramp-ipad",
      "/exceptions": "/today",
      "/approvals": "/family-texts?tab=for-you",
    });
    for (const [from, to] of Object.entries(MOVED_PAGES)) {
      expect(PAGES.map((p) => p.path), from).toContain(from);
      expect(PAGES.map((p) => p.path), to).toContain(pathOfHref(to));
    }
  });

  it("sends only a caller who could open the destination, and refuses everyone else the same way", () => {
    for (const [from, href] of Object.entries(MOVED_PAGES)) {
      const to = pathOfHref(href);
      expect(rolesWhoCanOpen(from), from).toEqual(rolesWhoCanOpen(to));
      for (const caller of Object.values(callers)) {
        expect({ from, outcome: pageOutcome(caller, from) }).toEqual({
          from,
          outcome: pageOutcome(caller, to),
        });
      }
    }
  });

  /**
   * THE FRONT DESK ENDS ON A SCREEN THEY CAN SEE — never on "For you", never on a 403.
   *
   * Their row opens neither of the two pages that moved, so the guard answers before the
   * redirect does and sends them to their own home (§9.3). The assertion is the whole chain:
   * refused at the old address, home is the live map, and the live map is a page they may open.
   */
  it("leaves the front desk on their own home, not on the destination", () => {
    for (const from of ["/exceptions", "/approvals"]) {
      expect(pageOutcome(callers.frontDesk, from), from).toBe("NO_ACCESS");
      const home = homePathFor(callers.frontDesk);
      expect(home).toBe("/live-map");
      expect(pageOutcome(callers.frontDesk, home)).toBe("ALLOW");
    }
  });

  it("redirects permanently, and only after the guard has run", () => {
    for (const [from, to] of Object.entries(MOVED_PAGES)) {
      const row = PAGES.find((p) => p.path === from);
      expect(row, from).toBeDefined();
      const source = readFileSync(path.join(REPO, row!.file), "utf8");
      // 308, not 307: the old address is not coming back.
      expect(source, from).toContain("permanentRedirect");
      expect(source, from).not.toMatch(/\bredirect\(/);
      // The destination is read from this table, so a redirect cannot point off it.
      expect(source, from).toContain(`MOVED_PAGES["${from}"]`);
      expect(source, from).not.toContain(`"${to}"`);
      // Guard first. Both calls are in the one function body, so compare their positions.
      const guardAt = source.indexOf(`requirePage("${from}")`);
      const redirectAt = source.indexOf("permanentRedirect(");
      expect(guardAt, from).toBeGreaterThan(-1);
      expect(redirectAt, from).toBeGreaterThan(guardAt);
    }
  });

  /**
   * A redirect is never a destination: not on the menu, and not anybody's home. The second half
   * is the one that would bite — "send them home" is where the guard puts a role that may not
   * open what they asked for (§9.3), and a home that redirects is a bounce rather than a
   * screen. `/exceptions` was in that order until this PR; it is not now.
   */
  it("keeps the moved addresses off the menu and out of every role's home", () => {
    for (const from of Object.keys(MOVED_PAGES)) {
      expect(menuItems.map((i) => i.href), from).not.toContain(from);
      for (const caller of Object.values(callers)) expect(homePathFor(caller), from).not.toBe(from);
      expect(HOME_ORDER, from).not.toContain(from);
    }
  });
});

describe("every guarded page calls the guard, with its own path", () => {
  it.each(PAGES.filter((p) => p.kind === "page" && !("public" in p.access)))(
    "$path guards on the server",
    (row) => {
      const source = readFileSync(path.join(REPO, row.file), "utf8");
      expect(source).toMatch(/from "@\/auth\/page-guard"/);
      expect(source).toContain(`requirePage("${row.path}")`);
      // A session read must never be answered from a static render.
      expect(source).toMatch(/export const dynamic = "force-dynamic"/);
    },
  );

  /**
   * Every layout that mounts the console shell guards sign-in for everything inside it, and
   * names its own row to do it. Four of them: the `(app)` group, and one each for the three
   * screens that are routes outside it (`/plan-routes`, `/live-map`, `/ramp-ipad`), which until
   * 2026-10-17 rendered with no shell and so no menu at all.
   *
   * The row key is read from the table and the file from the row, so a layout that guards with
   * someone else's key — or with no key — fails here rather than shipping.
   */
  const LAYOUT_KEYS = Object.fromEntries(Object.entries(LAYOUT).map(([key, path]) => [path, key]));

  it.each(PAGES.filter((p) => p.kind === "layout" && p.path !== LAYOUT.root))(
    "$file guards sign-in with its own row",
    (row) => {
      const source = readFileSync(path.join(REPO, row.file), "utf8");
      expect(source).toContain(`requirePage(LAYOUT.${LAYOUT_KEYS[row.path]})`);
      expect(source).toMatch(/export const dynamic = "force-dynamic"/);
      // A session and nothing more: the role belongs to the page inside, so the refusal is
      // rendered by the page that was asked for and can say who that page is for.
      expect(row.access).toEqual({ signedIn: true });
    },
  );

  it("a public page holds no guard, and there are only four of them", () => {
    const publicPages = PAGES.filter((p) => "public" in p.access).map((p) => p.path);
    expect(publicPages).toEqual([LAYOUT.root, "/", "/login", "/_not-found"]);
  });
});

describe("every role-restricted page has a 403 boundary beside it", () => {
  it.each(PAGES.filter((p) => p.kind === "page" && "roles" in p.access))(
    "$path renders the no-access card on a refusal",
    (row) => {
      const boundary = path.join(REPO, path.dirname(row.file), "forbidden.tsx");
      expect(existsSync(boundary), `missing ${rel(boundary)}`).toBe(true);
      const source = readFileSync(boundary, "utf8");
      // It names its own page, which is where the "who can open this" line comes from. The
      // frame around the card is the shared component's (src/ui/refused-frame.test.ts).
      expect(source).toContain(`<RefusedPage path="${row.path}" />`);
    },
  );

  it("every boundary names a path the table holds", () => {
    for (const file of surfaceFiles.forbidden) {
      const named = /<RefusedPage path="([^"]+)"/.exec(readFileSync(path.join(REPO, file), "utf8"))?.[1];
      // The root boundary names no page on purpose: it is the refusal with no page to name.
      if (!named) {
        expect(file).toBe("src/app/forbidden.tsx");
        continue;
      }
      expect(PAGES.map((p) => p.path)).toContain(named);
    }
  });
});

describe("every route enforces the auth its row names", () => {
  it.each(ENDPOINTS.filter((e) => e.kind === "route"))("$path", (row) => {
    const source = readFileSync(path.join(REPO, row.file), "utf8");
    if (row.auth.kind === "session") {
      expect(source).toMatch(/requireApiSession\(API\.\w+\)/);
    } else if (row.auth.kind === "cron-secret") {
      expect(source).toMatch(/cronAuthorized\(req\.headers\.get\("authorization"\), process\.env\.CRON_SECRET\)/);
      // A session must not be a second way in.
      expect(source).not.toMatch(/requireApiSession|getCaller|auth\(\)/);
    } else if (row.auth.kind === "queue-callback") {
      expect(source).toMatch(/handleCallback\(/);
      expect(source).not.toMatch(/requireApiSession|getCaller|auth\(\)/);
    } else if (row.auth.kind === "signature-webhook") {
      /*
       * The HMAC over the raw body, keyed by the environment variable the row names — built from
       * the row, so renaming either the header or the secret in the table and not in the handler
       * fails here rather than shipping a webhook nobody verifies.
       */
      expect(source).toMatch(
        new RegExp(`verifySimWebhook\\(raw, req\\.headers\\.get\\(SIM_SIGNATURE_HEADER\\), process\\.env\\.${row.auth.secretEnv}\\)`),
      );
      // A session must not be a second way in, exactly as on the cron and queue rows.
      expect(source).not.toMatch(/requireApiSession|getCaller|auth\(\)/);
    }
  });

  /**
   * The signature is checked before anything else the handler does. Not a style point: everything
   * below this line reads or writes something — the preview refusal, the form parse, the pepper,
   * the database handle, the ingest that inserts a message, a consent event and a staff task — so
   * a check that moved down would turn an unsigned post into a side effect.
   */
  it.each(ENDPOINTS.filter((e) => e.kind === "route" && e.auth.kind === "signature-webhook"))(
    "$path verifies the signature before it parses, reads or writes anything",
    (row) => {
      const source = readFileSync(path.join(REPO, row.file), "utf8");
      const body = source.slice(source.indexOf("export async function POST"));
      const verifyAt = body.indexOf("verifySimWebhook");
      expect(verifyAt).toBeGreaterThan(-1);
      for (const later of ["previewSkip", "parseInboundForm", "HMAC_PEPPER", "getNeonDb", "ingestInbound", "Transport"]) {
        expect({ later, before: body.indexOf(later) > verifyAt }, later).toEqual({ later, before: true });
      }
      // And the raw body is read exactly once, so the bytes that were signed are the bytes used.
      expect(body.match(/req\.text\(\)/g)).toHaveLength(1);
    },
  );

  it("no route writes an /api/ path of its own: they name their row through API", () => {
    for (const row of ENDPOINTS.filter((e) => e.kind === "route")) {
      const source = readFileSync(path.join(REPO, row.file), "utf8");
      const literals = [...source.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]);
      expect(literals, row.file).toEqual([]);
    }
    expect(Object.values(API)).toContain("/api/demo/reset");
  });
});

describe("the policy itself, written out so a silent widening fails", () => {
  it("is exactly this", () => {
    const written = Object.fromEntries(
      PAGES.filter((p) => p.kind === "page").map((p) => [
        p.path,
        "roles" in p.access ? [...p.access.roles].join("+") : "signedIn" in p.access ? "SIGNED_IN" : "PUBLIC",
      ]),
    );
    expect(written).toEqual({
      "/": "PUBLIC",
      "/login": "PUBLIC",
      "/_not-found": "PUBLIC",
      /*
       * The refusal card at an address: a session and nothing more, and then `forbidden()` for
       * every one of them. It grants no access to anything — there is nothing behind it — and
       * it is the only page whose policy is a bare session (src/app/refusal-check/page.tsx).
       */
      "/refusal-check": "SIGNED_IN",
      "/today": "DIRECTOR+COORDINATOR",
      "/exceptions": "DIRECTOR+COORDINATOR",
      // The founder's redesign (REDESIGN-SPEC §0, §9.2): the family thread, and the approvals
      // queue inside it. Both mirror /exceptions — the two console roles, not the front desk.
      "/family-texts": "DIRECTOR+COORDINATOR",
      "/approvals": "DIRECTOR+COORDINATOR",
      "/setup": "DIRECTOR+COORDINATOR",
      "/health": "DIRECTOR+COORDINATOR",
      "/plan-routes": "DIRECTOR+COORDINATOR",
      "/whoami": "DIRECTOR+COORDINATOR+FRONT_DESK",
      "/live-map": "DIRECTOR+COORDINATOR+FRONT_DESK",
      "/ramp-ipad": "DIRECTOR+COORDINATOR+FRONT_DESK",
      // The three old addresses, still answering as permanent redirects, each behind the same
      // roles as the screen it sends you to.
      "/plan-preview": "DIRECTOR+COORDINATOR",
      "/map-preview": "DIRECTOR+COORDINATOR+FRONT_DESK",
      "/ramp-preview": "DIRECTOR+COORDINATOR+FRONT_DESK",
    });
  });

  it("is exactly this for the endpoints, with the auth each one uses", () => {
    const written = Object.fromEntries(
      ENDPOINTS.map((e) => [
        e.path,
        e.auth.kind === "session" ? `session:${[...e.auth.roles].join("+")}` : e.auth.kind,
      ]),
    );
    expect(written).toEqual({
      "/api/auth/[...nextauth]": "auth-endpoint",
      "/api/health": "public",
      "/api/cron/sweep": "cron-secret",
      "/api/probe/delay": "cron-secret",
      "/api/demo/reset": "session:DIRECTOR",
      "/api/plan": "session:DIRECTOR+COORDINATOR",
      "/api/plan/save": "session:DIRECTOR+COORDINATOR",
      // One child moved, and one child's three need answers: the same two roles the board is
      // open to, because both are decisions about what the day is planned against.
      "/api/plan/place": "session:DIRECTOR+COORDINATOR",
      "/api/children/[token]/needs": "session:DIRECTOR+COORDINATOR",
      // Counting what is on a van is the front desk's own job (§2), and the step strip is read by
      // every role that has a surface at all.
      "/api/vans/[id]/setup": "session:DIRECTOR+COORDINATOR+FRONT_DESK",
      "/api/queues/timer": "queue-callback",
      "/api/queues/outbox": "queue-callback",
      "/api/queues/agent": "queue-callback",
      "/api/queues/delay-probe": "queue-callback",
      "/api/webhooks/sms": "signature-webhook",
      "/api/sim/phones/[number]/messages": "session:DIRECTOR+COORDINATOR",
      /*
       * The one control on the "For you" tab. `APPROVAL_ROLES` — the named constant, not the
       * roles of a page — which is Veri's merge blocker: `/exceptions` is being redesigned away,
       * and a permission read off a route is a permission a route change can move.
       */
      "action:approval-decision": "session:DIRECTOR+COORDINATOR",
      "action:sign-in": "auth-endpoint",
      "action:sign-out": "public",
    });
  });

  it("the site-scoped endpoints are the ones that take an id", () => {
    const scoped = ENDPOINTS.filter((e) => e.auth.kind === "session" && e.auth.siteScoped).map((e) => e.path);
    expect(scoped).toEqual([
      "/api/demo/reset",
      "/api/sim/phones/[number]/messages",
      // The approval decision takes an approval id, and the site comes off that row rather than
      // off the form — which is what makes another site's id a uniform 404.
      "action:approval-decision",
    ]);
  });

  it("every row whose default is a guess is flagged for the founder, with the question in the file", () => {
    /*
     * Five rows, not six: `/ramp-ipad` asked whether the front desk should land there until
     * SURF-04 is real, and Firia answered it on 2026-10-17 at 3:08 PM ET by making the live map
     * their home. An answered question is taken off the row rather than left standing.
     */
    expect(foundersQuestions()).toEqual(["/today", "/setup", "/health", "/whoami", "/api/health"]);
    const source = readFileSync(path.join(__dirname, "access.ts"), "utf8");
    expect(source.match(/OPEN QUESTION for the founder/g)).toHaveLength(foundersQuestions().length);
  });

  it("all five open questions are flagged in the source, in the one marker style", () => {
    /*
     * Five, and they are all rows in this table. There were six: the sixth was not about access
     * at all — the brand palette the brief named, which no token in this repo defined — and it
     * was marked in src/ui/tokens.ts where someone would act on it. The founder answered it on
     * 2026-10-17 at 6:19 PM ET (teal, Teal Ink, the selected tint, coral for alerts), so the
     * marker came off with the question, which is the rule this file holds everywhere else too.
     *
     * Counted across the whole of src/ so a question cannot be answered by deleting its marker,
     * and written out per file so a marker that lands somewhere unexpected fails here rather
     * than passing a total.
     */
    const flagged = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => [rel(f), (readFileSync(f, "utf8").match(/OPEN QUESTION for the founder/g) ?? []).length] as const)
      .filter(([, count]) => count > 0);
    expect(Object.fromEntries(flagged)).toEqual({ "src/auth/access.ts": 5 });
    expect(flagged.reduce((n, [, count]) => n + count, 0)).toBe(5);
  });
});

describe("the decision, cell by cell", () => {
  it("fails shut on a path with no row", () => {
    for (const caller of Object.values(callers)) {
      expect(pageOutcome(caller, "/not-in-the-table")).toBe("UNKNOWN");
      expect(apiOutcome(caller, "/api/not-in-the-table")).toBe("UNKNOWN");
    }
  });

  it("sends a signed-out visitor to sign-in on every staff page, and lets them keep the public ones", () => {
    for (const row of PAGES.filter((p) => p.kind === "page")) {
      const expected = "public" in row.access ? "ALLOW" : "SIGN_IN";
      expect({ path: row.path, outcome: pageOutcome(callers.signedOut, row.path) }).toEqual({
        path: row.path,
        outcome: expected,
      });
    }
  });

  it("refuses a signed-in caller who holds no membership anywhere, rather than bouncing them to sign-in", () => {
    expect(pageOutcome(callers.noRole, "/today")).toBe("NO_ACCESS");
    expect(pageOutcome(callers.noRole, "/ramp-ipad")).toBe("NO_ACCESS");
    expect(pageOutcome(callers.noRole, LAYOUT.console)).toBe("ALLOW"); // the shell; the page then refuses
    expect(apiOutcome(callers.noRole, API.demoReset)).toBe("FORBIDDEN");
  });

  it("gives the front desk the live map and their own ramp iPad, and no console page", () => {
    const allowed = PAGES.filter((p) => p.kind === "page" && pageOutcome(callers.frontDesk, p.path) === "ALLOW").map(
      (p) => p.path,
    );
    expect(allowed).toEqual([
      "/",
      "/login",
      "/_not-found",
      "/whoami",
      /*
       * The refusal card at an address. "Allowed" here is the guard letting a session past, and
       * the page then refuses it — which is the whole route: it carries no data and no screen,
       * so there is nothing for this row to have given the front desk.
       */
      "/refusal-check",
      "/live-map",
      "/ramp-ipad",
      // The redirects to those same two screens, and not the one to Plan routes.
      "/map-preview",
      "/ramp-preview",
    ]);
  });

  it("a session is never a way into a cron, queue, webhook or Auth.js route", () => {
    for (const row of ENDPOINTS.filter((e) => e.auth.kind !== "session" && e.auth.kind !== "public")) {
      for (const caller of Object.values(callers)) {
        expect({ path: row.path, outcome: apiOutcome(caller, row.path) }).toEqual({
          path: row.path,
          outcome: "NOT_A_SESSION_ROUTE",
        });
      }
    }
  });

  /**
   * The signature webhook, named rather than covered by the loop above, because it is the one kind
   * that is **reachable from the public internet** and so the one where "a session grants nothing"
   * is easy to get wrong. A director is not a provider: the only thing that may run this handler is
   * an HMAC of the request's own raw body, so every caller — signed out, no role, front desk,
   * coordinator, director — gets the same answer from the table, and the route answers 401 to all
   * of them without a valid signature (src/app/api/webhooks/sms/route.test.ts measures that over
   * HTTP, including for a staff session).
   */
  it("the signature webhook takes no session at all, from any role, and names its header and secret", () => {
    const rows = ENDPOINTS.filter((e) => e.auth.kind === "signature-webhook");
    expect(rows.map((r) => r.path)).toEqual([API.smsWebhook]);
    for (const row of rows) {
      for (const caller of Object.values(callers)) {
        expect({ path: row.path, outcome: apiOutcome(caller, row.path) }).toEqual({
          path: row.path,
          outcome: "NOT_A_SESSION_ROUTE",
        });
      }
      // Not "public": the row carries where the proof of authorization is read from.
      const auth = row.auth;
      if (auth.kind !== "signature-webhook") throw new Error("filtered above");
      expect(auth.header).toBe("x-sim-signature");
      expect(auth.secretEnv).toBe("SIM_WEBHOOK_SECRET");
      /*
       * The secret's *name* is in the table, never its value: the table stays a pure module that
       * reads no environment (see its header), and a key cannot be committed by being documented.
       */
      expect(auth.secretEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
      const code = readFileSync(path.join(__dirname, "access.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toContain("process.env");
    }
  });

  /**
   * The persona phone is the second site-scoped row, and the first one that is a read. The table
   * answers the role half (PRD §1.1: the console is the coordinator's and director's surface, the
   * front desk's is the ramp iPad); the site half is `requireSiteAccess` where the phone is loaded,
   * and src/modules/messaging/mailbox.test.ts holds the own-site-403 / other-site-404 matrix.
   */
  it("the persona phone is the console roles', and the front desk is refused", () => {
    expect(apiOutcome(callers.director, API.simPhoneMessages)).toBe("ALLOW");
    expect(apiOutcome(callers.coordinator, API.simPhoneMessages)).toBe("ALLOW");
    expect(apiOutcome(callers.frontDesk, API.simPhoneMessages)).toBe("FORBIDDEN");
    expect(apiOutcome(callers.noRole, API.simPhoneMessages)).toBe("FORBIDDEN");
    expect(apiOutcome(callers.signedOut, API.simPhoneMessages)).toBe("UNAUTHENTICATED");
  });

  it("the demo reset is the director's alone", () => {
    expect(apiOutcome(callers.director, API.demoReset)).toBe("ALLOW");
    expect(apiOutcome(callers.coordinator, API.demoReset)).toBe("FORBIDDEN");
    expect(apiOutcome(callers.frontDesk, API.demoReset)).toBe("FORBIDDEN");
    expect(apiOutcome(callers.signedOut, API.demoReset)).toBe("UNAUTHENTICATED");
  });
});

describe("where each role lives", () => {
  it("sends every role to a page that role can actually open", () => {
    expect(homePathFor(callers.director)).toBe("/today");
    expect(homePathFor(callers.coordinator)).toBe("/today");
    /*
     * The front desk has no console page. Their home is the live map — Firia's final ruling,
     * 2026-10-17 3:08 PM ET: "Front desk gets two tabs, Live map (their home) and Ramp iPad."
     * It was the ramp iPad before that, which is still their other tab.
     */
    expect(homePathFor(callers.frontDesk)).toBe("/live-map");
    expect(homePathFor(callers.signedOut)).toBe("/login");
    expect(homePathFor(callers.noRole)).toBe("/login");
    for (const caller of [callers.director, callers.coordinator, callers.frontDesk]) {
      expect(pageOutcome(caller, homePathFor(caller))).toBe("ALLOW");
    }
  });

  it("labels every home with the words that destination already uses", () => {
    for (const caller of Object.values(callers)) {
      expect(pageLabel(homePathFor(caller)).length).toBeGreaterThan(0);
    }
  });

  it("offers each role only the nav items it can open", () => {
    /*
     * The whole menu, for a role whose row opens everything, in REDESIGN-SPEC §9.2's order and
     * at §9.2's length: five, the day's four screens and then Family texts. Three destinations
     * are off the *menu* (the `inMenu` flag in src/ui/nav-items.ts) and none of the three is off
     * it because a page is unfinished — Exceptions & Approvals is Today's "Needs you" card and
     * the For you tab, Health & ROI is a tab inside Today, and §0 moves Setup's van counts onto
     * the ramp iPad. Every row and every route is untouched, and `rolesWhoCanOpen` below is
     * still asked about every destination. Addresses only — no "preview" in any of them.
     */
    const everything = [
      "/today",
      "/plan-routes",
      "/live-map",
      "/ramp-ipad",
      "/family-texts",
    ];
    expect(navItemsFor("DIRECTOR").map((i) => i.href)).toEqual(everything);
    expect(navItemsFor("COORDINATOR").map((i) => i.href)).toEqual(everything);
    /*
     * The front desk's row opens no console destination, Plan routes included: deciding which
     * van a child rides in is not their job (ARCHITECTURE §1). What is left is their own
     * surface, the ramp iPad (PRD §6.2), and the live map, whose row is all staff because a
     * person at the door needs to see where the vans are — src/domain/access/map-view.ts then
     * withholds the family labels and the notification queue from them.
     */
    expect(navItemsFor("FRONT_DESK").map((i) => i.href)).toEqual(["/live-map", "/ramp-ipad"]);
    expect(navItemsFor(null)).toEqual([]);
    /*
     * And the menu is never wider than the table for any role: this compares what a role is
     * shown against `rolesWhoCanOpen` row by row, so an item added to nav-items.ts whose row
     * omits a role fails here rather than on a screen. Narrower is allowed and is what the
     * `inMenu` flag does — the comparison is against the rows that are *on* the menu.
     */
    for (const role of ROLES) {
      const shown = navItemsFor(role).map((i) => i.href);
      const allowed = navItems
        .filter((i) => i.inMenu && rolesWhoCanOpen(i.href).includes(role))
        .map((i) => i.href);
      expect(shown, role).toEqual(allowed);
      // Nothing off the menu is reachable from it, for any role.
      for (const off of navItems.filter((i) => !i.inMenu)) {
        expect(shown, `${role} is offered ${off.href}`).not.toContain(off.href);
      }
    }
    // ...and hiding is only ever the same answer the server gives, never a different one.
    for (const role of ROLES) {
      for (const item of navItemsFor(role)) {
        expect(pageOutcome({ kind: "STAFF", role }, item.href)).toBe("ALLOW");
        expect(canSeeNavItem({ kind: "STAFF", role }, item.href)).toBe(true);
      }
    }
  });
});

describe("the line the no-access page says", () => {
  it("names the two console roles in prose, not enum values", () => {
    expect(whoCanOpenLine("/today")).toBe("Directors and coordinators can open this.");
    expect(whoCanOpenLine("/exceptions")).toBe("Directors and coordinators can open this.");
  });

  it("names all three where all three are in", () => {
    expect(whoCanOpenLine("/ramp-ipad")).toBe(
      "Directors, coordinators and front desk staff can open this.",
    );
  });

  it("says something honest for a page with no row rather than an empty sentence", () => {
    expect(whoCanOpenLine("/not-in-the-table")).toBe(noAccess.whoCanOpenNobody);
  });

  it("never prints a role key, a path or a status code", () => {
    for (const row of PAGES.filter((p) => p.kind === "page")) {
      const line = whoCanOpenLine(row.path);
      expect(line).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|403|\//);
    }
  });
});

describe("the helpers the table shares with the map matrix", () => {
  it("picks the most capable role a person holds", () => {
    expect(mostCapable(["FRONT_DESK", "DIRECTOR"])).toBe("DIRECTOR");
    expect(mostCapable(["FRONT_DESK", "COORDINATOR"])).toBe("COORDINATOR");
    expect(mostCapable([])).toBeNull();
  });

  it("reads a caller as the map pane's data matrix does", () => {
    expect(mapViewerOf(callers.director)).toBe("DIRECTOR");
    expect(mapViewerOf(callers.noRole)).toBe("ANONYMOUS");
    expect(mapViewerOf(callers.signedOut)).toBe("ANONYMOUS");
  });

  it("agrees with the screen policy in src/domain/access/map-view.ts", () => {
    // Two files answer "may this role open the live map": the table, which the route enforces,
    // and the data matrix, whose answer is "is there anything here for them". They must match.
    for (const role of ROLES) {
      const caller: Caller = { kind: "STAFF", role };
      expect({ role, open: canOpenLiveMap(role) }).toEqual({
        role,
        open: pageOutcome(caller, "/live-map") === "ALLOW",
      });
      expect({ role, ramp: canOpenRampIpad(role) }).toEqual({
        role,
        ramp: pageOutcome(caller, "/ramp-ipad") === "ALLOW",
      });
    }
    expect(canOpenLiveMap("ANONYMOUS")).toBe(false);
    expect(canOpenRampIpad("ANONYMOUS")).toBe(false);
  });

  it("rolesWhoCanOpen is the roles for a staff page and every role for a public one", () => {
    expect(rolesWhoCanOpen("/today")).toEqual(["DIRECTOR", "COORDINATOR"]);
    expect(rolesWhoCanOpen("/login")).toEqual(ALL_STAFF);
    expect(rolesWhoCanOpen("/not-in-the-table")).toEqual([]);
  });
});
