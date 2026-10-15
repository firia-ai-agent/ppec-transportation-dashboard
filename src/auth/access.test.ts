import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_STAFF,
  API,
  ENDPOINTS,
  LAYOUT,
  PAGES,
  POLICY,
  ROLE_LADDER,
  apiOutcome,
  canSeeNavItem,
  foundersQuestions,
  homePathFor,
  mapViewerOf,
  mostCapable,
  pageLabel,
  pageOutcome,
  rolesWhoCanOpen,
  whoCanOpenLine,
  type Caller,
} from "./access";
import { canOpenMapPreview, canOpenRampPreview } from "@/domain/access/map-view";
import { navItemsFor } from "@/ui/nav-items";
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
 *    or the queue callback;
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
      expect.arrayContaining(["src/app/layout.tsx", "src/app/(app)/layout.tsx"]),
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

  it("the console layout guards sign-in for everything inside it", () => {
    const source = readFileSync(path.join(REPO, "src/app/(app)/layout.tsx"), "utf8");
    expect(source).toContain("requirePage(LAYOUT.console)");
    expect(source).toMatch(/export const dynamic = "force-dynamic"/);
  });

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
      // It names its own page, which is where the "who can open this" line comes from.
      expect(source).toContain(`<NoAccess path="${row.path}" />`);
    },
  );

  it("every boundary names a path the table holds", () => {
    for (const file of surfaceFiles.forbidden) {
      const named = /<NoAccess path="([^"]+)"/.exec(readFileSync(path.join(REPO, file), "utf8"))?.[1];
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
    }
  });

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
        "roles" in p.access ? [...p.access.roles].join("+") : "PUBLIC",
      ]),
    );
    expect(written).toEqual({
      "/": "PUBLIC",
      "/login": "PUBLIC",
      "/_not-found": "PUBLIC",
      "/today": "DIRECTOR+COORDINATOR",
      "/exceptions": "DIRECTOR+COORDINATOR",
      "/setup": "DIRECTOR+COORDINATOR",
      "/health": "DIRECTOR+COORDINATOR",
      "/whoami": "DIRECTOR+COORDINATOR+FRONT_DESK",
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
      "/api/queues/timer": "queue-callback",
      "/api/queues/outbox": "queue-callback",
      "/api/queues/delay-probe": "queue-callback",
      "action:sign-in": "auth-endpoint",
      "action:sign-out": "public",
    });
  });

  it("the site-scoped endpoints are the ones that take an id", () => {
    const scoped = ENDPOINTS.filter((e) => e.auth.kind === "session" && e.auth.siteScoped).map((e) => e.path);
    expect(scoped).toEqual(["/api/demo/reset"]);
  });

  it("every row whose default is a guess is flagged for the founder, with the question in the file", () => {
    expect(foundersQuestions()).toEqual(["/today", "/setup", "/health", "/whoami", "/api/health"]);
    const source = readFileSync(path.join(__dirname, "access.ts"), "utf8");
    expect(source.match(/OPEN QUESTION for the founder/g)).toHaveLength(foundersQuestions().length);
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
    expect(pageOutcome(callers.noRole, "/ramp-preview")).toBe("NO_ACCESS");
    expect(pageOutcome(callers.noRole, LAYOUT.console)).toBe("ALLOW"); // the shell; the page then refuses
    expect(apiOutcome(callers.noRole, API.demoReset)).toBe("FORBIDDEN");
  });

  it("gives the front desk the ramp check and the previews, and no console page", () => {
    const allowed = PAGES.filter((p) => p.kind === "page" && pageOutcome(callers.frontDesk, p.path) === "ALLOW").map(
      (p) => p.path,
    );
    expect(allowed).toEqual(["/", "/login", "/_not-found", "/whoami", "/map-preview", "/ramp-preview"]);
  });

  it("a session is never a way into a cron, queue or Auth.js route", () => {
    for (const row of ENDPOINTS.filter((e) => e.auth.kind !== "session" && e.auth.kind !== "public")) {
      for (const caller of Object.values(callers)) {
        expect({ path: row.path, outcome: apiOutcome(caller, row.path) }).toEqual({
          path: row.path,
          outcome: "NOT_A_SESSION_ROUTE",
        });
      }
    }
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
    // The front desk has no console page: their surface is the ramp iPad (ARCHITECTURE §1).
    expect(homePathFor(callers.frontDesk)).toBe("/ramp-preview");
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
    expect(navItemsFor("DIRECTOR").map((i) => i.href)).toEqual(["/today", "/exceptions", "/setup", "/health"]);
    expect(navItemsFor("COORDINATOR").map((i) => i.href)).toEqual(["/today", "/exceptions", "/setup", "/health"]);
    expect(navItemsFor("FRONT_DESK")).toEqual([]);
    expect(navItemsFor(null)).toEqual([]);
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
    expect(whoCanOpenLine("/ramp-preview")).toBe(
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

  it("agrees with the preview policy in src/domain/access/map-view.ts", () => {
    // Two files answer "may this role open the preview": the table, which the route enforces,
    // and the data matrix, whose answer is "is there anything here for them". They must match.
    for (const role of ROLES) {
      const caller: Caller = { kind: "STAFF", role };
      expect({ role, open: canOpenMapPreview(role) }).toEqual({
        role,
        open: pageOutcome(caller, "/map-preview") === "ALLOW",
      });
      expect({ role, ramp: canOpenRampPreview(role) }).toEqual({
        role,
        ramp: pageOutcome(caller, "/ramp-preview") === "ALLOW",
      });
    }
    expect(canOpenMapPreview("ANONYMOUS")).toBe(false);
    expect(canOpenRampPreview("ANONYMOUS")).toBe(false);
  });

  it("rolesWhoCanOpen is the roles for a staff page and every role for a public one", () => {
    expect(rolesWhoCanOpen("/today")).toEqual(["DIRECTOR", "COORDINATOR"]);
    expect(rolesWhoCanOpen("/login")).toEqual(ALL_STAFF);
    expect(rolesWhoCanOpen("/not-in-the-table")).toEqual([]);
  });
});
