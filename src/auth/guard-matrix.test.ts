import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAGES, pageOutcome, homePathFor, type Caller } from "./access";
import type { Membership } from "./core";

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
 *  - NO_ACCESS  → it threw Next's 403 interrupt, which is the no-access page with a real 403.
 *
 * Mocks, and why each one is honest:
 *  - `@/auth/caller` — the one session reader. Stubbing it is how a role is put on the request;
 *    the reader's own steps (token → active user → memberships, including a disabled user) are
 *    tested against a real database in caller.test.ts, and the site-scoping writes in
 *    idswap.test.ts.
 *  - `@/auth` and `next-auth` — Auth.js's module scope wants `next/server`, which resolves only
 *    inside Next. Nothing here calls into it; the pages reach the session through `getCaller`,
 *    and /login only uses `AuthError` to tell a bad password from a real failure.
 *  - `@/components/map/LiveFleetMap` — a client component that pulls in MapLibre. The page is
 *    being called for its guard, and the pane has its own tests.
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
vi.mock("@/components/map/LiveFleetMap", () => ({ default: () => null }));
vi.mock("@/db/exec", () => ({ getNeonDb, runAfterCommit: vi.fn() }));

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
  signedOut: { kind: "ANONYMOUS", memberships: [] },
};

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

/** What a thrown Next interrupt was: a redirect (and where to), or the 403. */
function interrupt(error: unknown): { kind: "redirect"; to: string } | { kind: "forbidden" } | null {
  const digest = (error as { digest?: unknown })?.digest;
  if (typeof digest !== "string") return null;
  if (digest.startsWith("NEXT_REDIRECT")) return { kind: "redirect", to: digest.split(";")[2] };
  if (digest === "NEXT_HTTP_ERROR_FALLBACK;403") return { kind: "forbidden" };
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

beforeEach(() => {
  getCaller.mockReset();
  getNeonDb.mockClear();
});

describe("the harness itself works", () => {
  it("found every page on disk and can name each one's route", () => {
    const paths = pageFiles.map((p) => p.path).sort();
    expect(paths).toEqual(
      ["/", "/_not-found", "/exceptions", "/health", "/login", "/map-preview", "/ramp-preview", "/setup", "/today", "/whoami"].sort(),
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
        if (expected === "ALLOW") {
          expect(result).toEqual({ rendered: true });
          return;
        }
        if (expected === "SIGN_IN") {
          expect(result).toEqual({ rendered: false, interrupt: { kind: "redirect", to: "/login" } });
          return;
        }
        expect(expected).toBe("NO_ACCESS");
        expect(result).toEqual({ rendered: false, interrupt: { kind: "forbidden" } });
      });
    }
  }

  it("the front desk is refused all four console pages, with a 403 and never an empty frame", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    for (const p of ["/today", "/exceptions", "/setup", "/health"]) {
      const file = pageFiles.find((f) => f.path === p)?.file as string;
      expect({ p, ...(await openPage(file)) }).toEqual({ p, rendered: false, interrupt: { kind: "forbidden" } });
    }
  });

  it("the console shell lets any session in and leaves the role to the page inside it", async () => {
    const layout = path.join(APP, "(app)", "layout.tsx");
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    expect(await openPage(layout)).toEqual({ rendered: true });
    getCaller.mockResolvedValue(CALLERS.signedOut);
    expect(await openPage(layout)).toEqual({
      rendered: false,
      interrupt: { kind: "redirect", to: "/login" },
    });
  });
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
  it("POST /api/demo/reset is the director's alone: 401 signed out, 403 for the others", async () => {
    const expected: Record<string, number | "reached the db"> = {
      director: "reached the db",
      coordinator: 403,
      frontDesk: 403,
      signedOut: 401,
    };
    for (const [who, caller] of Object.entries(CALLERS)) {
      getCaller.mockResolvedValue(caller);
      getNeonDb.mockClear();
      if (expected[who] === "reached the db") {
        // Past both guards: the only thing left is the work, and the DB stub says so.
        await expect(callRoute(ROUTE("demo", "reset"), "POST", { body: "{}" })).rejects.toThrow(DB_OPENED);
        continue;
      }
      const res = await callRoute(ROUTE("demo", "reset"), "POST", { body: "{}" });
      expect({ who, status: res.status }).toEqual({ who, status: expected[who] });
      // A refusal never reaches the data, and never says which role would have worked.
      expect(getNeonDb).not.toHaveBeenCalled();
      const body = JSON.stringify(await res.json());
      expect(body).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|403|401/);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("names a site in the body and it is still refused for everyone but a director", async () => {
    for (const who of ["coordinator", "frontDesk", "signedOut"] as const) {
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await callRoute(ROUTE("demo", "reset"), "POST", {
        body: JSON.stringify({ siteId: "00000000-0000-7000-8000-000000000001" }),
      });
      expect({ who, ok: res.ok }).toEqual({ who, ok: false });
      expect(getNeonDb).not.toHaveBeenCalled();
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
      expect(await res.text()).not.toContain(secret);
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
