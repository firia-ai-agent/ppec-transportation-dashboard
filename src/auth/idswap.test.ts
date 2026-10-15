import { beforeEach, describe, expect, it, vi } from "vitest";
import { Forbidden, SiteNotFound, Unauthenticated, getMemberships, requireSiteAccess } from "./core";
import { API, endpointRow } from "./access";
import { handleDemoReset } from "@/modules/demo/reset";
import { freshDb, ORG, SITE } from "@/test/pglite";
import type { Db } from "@/db/exec";

/**
 * THE ID-SWAP MATRIX (the reviewer's access-control procedure, /workspace/idswap-skill.md).
 *
 * The hole that procedure exists for was not cross-tenant: a staff member could open an object
 * **inside their own tenant** that was not theirs, because the query scoped by organisation
 * only. So "another site is denied" is not enough on its own, and neither is a scoped list.
 * Every cell below is filled for reads **and** writes, and each one is run against a real
 * database with two sites in it.
 *
 * OBJECT: the site (`ops.site`), which is the only object an id reaches in this app today — the
 * one id-taking surface is `POST /api/demo/reset {siteId}`. There is no child, leg, thread or
 * invoice route yet; when one lands it gets its own matrix here, and `requireSiteAccess` is the
 * helper it must call. The PR description says this out loud rather than implying coverage of
 * surfaces that do not exist.
 *
 * Spec rule, quoted: ADR-004 — "Every handler goes through `requireSiteRole(siteId, roles)` and
 * loads rows `WHERE site_id = session site`." BUILD-PLAN §4 — same site, role not allowed: 403;
 * other site (second seeded site): 404. The skill adds: prefer a uniform 404 so a response
 * cannot be used to find out what exists.
 *
 * | Role \ Target        | own site R | own site W | other site R | other site W | random id R | random id W |
 * |----------------------|------------|------------|--------------|--------------|-------------|-------------|
 * | signed out           | 401        | 401        | 401          | 401           | 401        | 401         |
 * | front desk (least)   | 403        | 403        | 404          | 404           | 404        | 404         |
 * | coordinator          | 403        | 403        | 404          | 404           | 404        | 404         |
 * | director (site A)    | ALLOW      | ALLOW      | 404          | 404           | 404        | 404         |
 * | director (site B)    | 404 (at A) | 404 (at A) | ALLOW (at B) | ALLOW (at B)  | 404        | 404         |
 * | no membership at all | 404        | 404        | 404          | 404           | 404        | 404         |
 * | disabled director    | 401        | 401        | 401          | 401           | 401        | 401         |
 *
 * "R" is `requireSiteAccess`, the read-side guard every id-taking handler calls; "W" is the one
 * write that exists, `POST /api/demo/reset`, exercised through the module **and** through the
 * route handler, because a direct API call is how the hole was found in the first place.
 */
const SITE_B = "00000000-0000-7000-8000-0000000000b1";
const RANDOM = "00000000-0000-7000-8000-00000000dead";
const NONEXISTENT = "ffffffff-ffff-7fff-8fff-ffffffffffff";

const USERS = {
  DIRECTOR_A: "00000000-0000-7000-8000-0000000000d1",
  COORDINATOR_A: "00000000-0000-7000-8000-0000000000c1",
  FRONT_DESK_A: "00000000-0000-7000-8000-0000000000f1",
  DIRECTOR_B: "00000000-0000-7000-8000-0000000000d2",
  OUTSIDER: "00000000-0000-7000-8000-0000000000e1",
  DISABLED_DIRECTOR: "00000000-0000-7000-8000-0000000000a9",
};

const env = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "test-pepper", DATA_KEY: "test-data-key" };
const NOW = new Date("2026-10-13T17:45:00.000Z");

/** The roles the access table gives the one write. Not restated here, so the two cannot drift. */
const WRITE_ROW = endpointRow(API.demoReset)?.auth;
const WRITE_ROLES = WRITE_ROW?.kind === "session" ? WRITE_ROW.roles : [];

let db: Db;

beforeEach(async () => {
  ({ db } = await freshDb());
  // A second site, with its own director: the "other tenant" row of the matrix.
  await db.query(
    `INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by)
     VALUES ($1,$2,'SYN Second Site',26.645352,-80.145541,'test','test')`,
    [SITE_B, ORG],
  );
  for (const [who, id] of Object.entries(USERS)) {
    await db.query(
      "INSERT INTO ops.app_user (id,email,display_name,password_hash) VALUES ($1,$2,$3,'$2b$12$notarealhash')",
      [id, `${who.toLowerCase()}@example.com`, `SYN ${who}`],
    );
  }
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.DIRECTOR_A, SITE]);
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'COORDINATOR')", [USERS.COORDINATOR_A, SITE]);
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'FRONT_DESK')", [USERS.FRONT_DESK_A, SITE]);
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.DIRECTOR_B, SITE_B]);
  // A director in every other respect, switched off: a session that is no longer a user.
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.DISABLED_DIRECTOR, SITE]);
  await db.query("UPDATE ops.app_user SET disabled_at = now() WHERE id = $1", [USERS.DISABLED_DIRECTOR]);
}, 60_000);

/** The read-side guard's answer: the status a handler maps it to, and the words behind the throw. */
async function read(userId: string | undefined, siteId: string): Promise<{ status: number; message: string }> {
  try {
    await requireSiteAccess(db, userId, siteId, WRITE_ROLES);
    return { status: 200, message: "" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof Unauthenticated) return { status: 401, message };
    if (e instanceof SiteNotFound) return { status: 404, message };
    if (e instanceof Forbidden) return { status: 403, message };
    throw e;
  }
}

const readStatus = async (userId: string | undefined, siteId: string) => (await read(userId, siteId)).status;

const write = (userId: string | undefined, siteId: string) =>
  handleDemoReset(db, env, { userId, siteId, now: NOW });

const writeStatus = async (userId: string | undefined, siteId: string) => (await write(userId, siteId)).status;

/** Every id in this test and every user in it: nothing a refusal may hand back. */
const ALL_IDS = [SITE, SITE_B, RANDOM, NONEXISTENT, ...Object.values(USERS)];

/**
 * The other half of a denied cell: what came back with the status.
 *
 * A 404 that names the id it refused tells the person guessing ids that this one is real, and a
 * 403 that names the role that would have worked tells them which account to go after. So every
 * refused cell's body is held to one plain sentence in the `{ ok, error }` shape every endpoint
 * uses, with no id (not even the one the request named), no role key, no table or column name,
 * no status code and no markup — an API refusal is never a page.
 */
function expectNothingLeaked(cell: string, body: unknown, named: string) {
  const text = JSON.stringify(body);
  expect({ cell, keys: Object.keys(body as object).sort() }).toEqual({ cell, keys: ["error", "ok"] });
  expect({ cell, text }).toEqual({ cell, text: expect.not.stringContaining(named) });
  for (const id of ALL_IDS) expect({ cell, id, text }).toEqual({ cell, id, text: expect.not.stringContaining(id) });
  expect(text, cell).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
  expect(text, cell).not.toMatch(/site_membership|app_user|ops\.|SELECT|INSERT|[<>]/i);
  expect(text, cell).not.toMatch(/\b(400|401|403|404)\b/);
}

const childCount = async () =>
  (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.child_profile", [])).rows[0].n;

describe("the matrix: every role against every target, read and write", () => {
  const TARGETS = [
    ["own site", () => SITE],
    ["the other site", () => SITE_B],
    ["a random id", () => RANDOM],
    ["an id that exists nowhere", () => NONEXISTENT],
  ] as const;

  it.each([
    ["signed out", undefined, { "own site": 401, "the other site": 401, "a random id": 401, "an id that exists nowhere": 401 }],
    ["front desk (least privileged)", USERS.FRONT_DESK_A, { "own site": 403, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["coordinator", USERS.COORDINATOR_A, { "own site": 403, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["director at site A", USERS.DIRECTOR_A, { "own site": 200, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["director at site B", USERS.DIRECTOR_B, { "own site": 404, "the other site": 200, "a random id": 404, "an id that exists nowhere": 404 }],
    ["a user with no membership anywhere", USERS.OUTSIDER, { "own site": 404, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["a disabled director", USERS.DISABLED_DIRECTOR, { "own site": 401, "the other site": 401, "a random id": 401, "an id that exists nowhere": 401 }],
  ] as const)("%s, reading", async (who, userId, expected) => {
    for (const [name, target] of TARGETS) {
      const answer = await read(userId, target());
      expect({ name, status: answer.status }).toEqual({ name, status: expected[name] });
      /*
       * The read guard throws rather than returning a body, and the handlers map the throw onto
       * the words in src/ui/copy.ts — but the message is what a log line and a stack keep, so it
       * names no id and no role either.
       */
      for (const id of ALL_IDS) expect({ who, name, message: answer.message }).toEqual({ who, name, message: expect.not.stringContaining(id) });
      expect(answer.message, `${who} reading ${name}`).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
    }
  });

  it.each([
    ["signed out", undefined, { "own site": 401, "the other site": 401, "a random id": 401, "an id that exists nowhere": 401 }],
    ["front desk (least privileged)", USERS.FRONT_DESK_A, { "own site": 403, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["coordinator", USERS.COORDINATOR_A, { "own site": 403, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["director at site B", USERS.DIRECTOR_B, { "own site": 404, "the other site": 200, "a random id": 404, "an id that exists nowhere": 404 }],
    ["a user with no membership anywhere", USERS.OUTSIDER, { "own site": 404, "the other site": 404, "a random id": 404, "an id that exists nowhere": 404 }],
    ["a disabled director", USERS.DISABLED_DIRECTOR, { "own site": 401, "the other site": 401, "a random id": 401, "an id that exists nowhere": 401 }],
  ] as const)("%s, writing", async (who, userId, expected) => {
    for (const [name, target] of TARGETS) {
      const answer = await write(userId, target());
      expect({ name, status: answer.status }).toEqual({ name, status: expected[name] });
      if (answer.status !== 200) expectNothingLeaked(`${who} writing ${name}`, answer.body, target());
    }
    /*
     * A refusal is a refusal, not a partial write. Site B's director has one allowed cell in
     * this row — their own site — so where a 200 is expected the rows must exist and must be at
     * *that* site; everywhere else the database is untouched.
     */
    const allowedSite = TARGETS.filter(([name]) => expected[name] === 200).map(([, t]) => t());
    const rows = await db.query<{ site_id: string }>("SELECT DISTINCT site_id FROM ops.child_profile", []);
    expect(rows.rows.map((r) => r.site_id).sort()).toEqual([...allowedSite].sort());
  }, 60_000);

  it("the director of site A is the one cell that writes, and only at site A", async () => {
    expect(await writeStatus(USERS.DIRECTOR_A, SITE_B)).toBe(404);
    expect(await childCount()).toBe(0);
    expect(await writeStatus(USERS.DIRECTOR_A, SITE)).toBe(200);
    expect(await childCount()).toBeGreaterThan(0);
  }, 120_000);
});

describe("a refusal says nothing about what exists", () => {
  it("the other site, a random id and an id that exists nowhere are byte-for-byte the same answer", async () => {
    const answers = await Promise.all(
      [SITE_B, RANDOM, NONEXISTENT].map((siteId) => handleDemoReset(db, env, { userId: USERS.DIRECTOR_A, siteId, now: NOW })),
    );
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0].status).toBe(404);
    // No id, role name or table name in the words either.
    const body = JSON.stringify(answers[0].body);
    expect(body).not.toContain(SITE_B);
    expect(body).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|site_membership|ops\./);
  });

  it("a wrong role at your own site is 403, which hides nothing it could hide", async () => {
    // Their own site: its existence is not a secret from a member of it (BUILD-PLAN §4).
    const r = await handleDemoReset(db, env, { userId: USERS.FRONT_DESK_A, siteId: SITE, now: NOW });
    expect(r.status).toBe(403);
  });
});

describe("the list is scoped too, and a scoped list is not a scoped object", () => {
  it("a user's memberships are their own, never another user's", async () => {
    expect(await getMemberships(db, USERS.FRONT_DESK_A)).toEqual([{ siteId: SITE, role: "FRONT_DESK" }]);
    expect(await getMemberships(db, USERS.DIRECTOR_B)).toEqual([{ siteId: SITE_B, role: "DIRECTOR" }]);
    // A disabled user's memberships are gone from the query, not merely unused by it.
    expect(await getMemberships(db, USERS.DISABLED_DIRECTOR)).toEqual([]);
    expect(await getMemberships(db, USERS.OUTSIDER)).toEqual([]);
  });

  it("holding a scoped list does not make the object behind one of its ids reachable", async () => {
    // The lesson the skill is written from: the list was scoped, the detail was not. Site B's
    // director can list exactly one site, and naming any other id gets the same 404 either way.
    const [mine] = await getMemberships(db, USERS.DIRECTOR_B);
    expect(mine.siteId).toBe(SITE_B);
    expect(await readStatus(USERS.DIRECTOR_B, SITE)).toBe(404);
    expect(await writeStatus(USERS.DIRECTOR_B, SITE)).toBe(404);
  });
});

/**
 * The same swap through the HTTP route, not the module: "a direct API call bypassing the UI" is
 * how the original hole was confirmed, so the route is called with a hand-written body naming
 * another site. The session reader is stubbed (there is no cookie jar here) and the database is
 * the real seeded one, so what is being tested is the handler chain a `curl` would hit.
 */
describe("the same swap, sent straight to the endpoint", () => {
  const getCaller = vi.fn();
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/auth/caller", () => ({ getCaller }));
    vi.doMock("@/db/exec", () => ({ getNeonDb: () => db, runAfterCommit: vi.fn() }));
    process.env = { ...saved, ...env, DATABASE_URL: undefined };
  });

  async function post(userId: string | undefined, role: "DIRECTOR" | "COORDINATOR" | "FRONT_DESK" | null, body: unknown) {
    getCaller.mockResolvedValue(
      userId && role ? { kind: "STAFF", role, userId, memberships: [] } : { kind: "ANONYMOUS", memberships: [] },
    );
    const { POST } = await import("@/app/api/demo/reset/route");
    return POST(new Request("https://example.test/reset", { method: "POST", body: JSON.stringify(body) }));
  }

  /** Status, headers and body on one refused HTTP call: the whole answer a `curl` would see. */
  async function expectRefusedOverHttp(res: Response, status: number, named: string, cell: string) {
    expect({ cell, status: res.status }).toEqual({ cell, status });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectNothingLeaked(cell, await res.json(), named);
    // Nothing written on a refused attempt, whichever refusal it was.
    expect({ cell, children: await childCount() }).toEqual({ cell, children: 0 });
  }

  it("a director naming another site's id over HTTP gets 404 and writes nothing", async () => {
    const res = await post(USERS.DIRECTOR_A, "DIRECTOR", { siteId: SITE_B });
    await expectRefusedOverHttp(res, 404, SITE_B, "director at A naming site B");
  });

  it("a coordinator naming their own site's id over HTTP gets 403 and writes nothing", async () => {
    const res = await post(USERS.COORDINATOR_A, "COORDINATOR", { siteId: SITE });
    await expectRefusedOverHttp(res, 403, SITE, "coordinator naming their own site");
  });

  it("a signed-out caller gets 401, body or no body", async () => {
    await expectRefusedOverHttp(await post(undefined, null, { siteId: SITE }), 401, SITE, "signed out, id named");
    await expectRefusedOverHttp(await post(undefined, null, {}), 401, SITE, "signed out, no id");
  });

  it("a malformed id is a 400 before anything is looked up, and not a 500", async () => {
    const res = await post(USERS.DIRECTOR_A, "DIRECTOR", { siteId: "not-a-uuid" });
    // The id it refused is not echoed back either, malformed or not.
    await expectRefusedOverHttp(res, 400, "not-a-uuid", "director with a malformed id");
  });
});
