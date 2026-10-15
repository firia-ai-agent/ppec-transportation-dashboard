import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, ORG, SITE } from "@/test/pglite";
import type { Db } from "@/db/exec";
import type { Exec } from "@/domain/transition";

/**
 * The one session reader, against a real database.
 *
 * guard-matrix.test.ts puts a role on a request and checks what every page and endpoint does
 * with it. This file is the other half: where that role comes from. Each step ADR-004 fixes is
 * checked against real rows, because every one of them is a way in if it is skipped:
 *  - the token carries only a user id;
 *  - that id must still be an **active** user — a user disabled mid-session is anonymous again
 *    on their next request, not "still a director until the token expires";
 *  - roles are re-read from `ops.site_membership` per request, never taken from the token, so a
 *    membership removed a second ago is gone now;
 *  - a signed-in user with no membership anywhere is NO_ROLE, not ANONYMOUS, so they are refused
 *    rather than bounced to sign-in forever.
 *
 * Only two things are stubbed, and neither is an authorization step: `auth()`, which decodes a
 * token (there is no browser here to hold a cookie), and `getExec`, which is pointed at the
 * in-memory Postgres this file seeds.
 */
const SITE_B = "00000000-0000-7000-8000-0000000000b1";
const USERS = {
  DIRECTOR: "00000000-0000-7000-8000-0000000000d1",
  COORDINATOR: "00000000-0000-7000-8000-0000000000c1",
  FRONT_DESK: "00000000-0000-7000-8000-0000000000f1",
  OUTSIDER: "00000000-0000-7000-8000-0000000000e1",
  DIRECTOR_B: "00000000-0000-7000-8000-0000000000d2",
  BOTH: "00000000-0000-7000-8000-0000000000b2",
};

const auth = vi.fn<() => Promise<{ user?: { id?: string } } | null>>();
let db: Db;

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/auth/exec", () => ({ getExec: (): Exec => db }));

beforeAll(async () => {
  ({ db } = await freshDb());
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
  for (const role of ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] as const) {
    await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,$3)", [USERS[role], SITE, role]);
  }
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.DIRECTOR_B, SITE_B]);
  // One person, two sites, two roles: the ladder has to pick the more capable of them.
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'FRONT_DESK')", [USERS.BOTH, SITE]);
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.BOTH, SITE_B]);
}, 60_000);

beforeEach(() => auth.mockReset());

/** The reader, with this token and this environment. */
async function callerFor(userId: string | undefined, env: Record<string, string | undefined> = {}) {
  auth.mockResolvedValue(userId ? { user: { id: userId } } : null);
  const { getCaller } = await import("./caller");
  return getCaller({ VERCEL_ENV: "production", ...env });
}

describe("no usable session is anonymous, whatever the reason", () => {
  it("no token at all", async () => {
    expect(await callerFor(undefined)).toEqual({ kind: "ANONYMOUS", memberships: [] });
  });

  it("a token whose user id matches no row", async () => {
    expect(await callerFor("00000000-0000-7000-8000-00000000dead")).toEqual({
      kind: "ANONYMOUS",
      memberships: [],
    });
  });

  it("a token for a user who has been disabled — the whole point of reading the DB per request", async () => {
    expect((await callerFor(USERS.DIRECTOR)).kind).toBe("STAFF");
    await db.query("UPDATE ops.app_user SET disabled_at = now() WHERE id = $1", [USERS.DIRECTOR]);
    try {
      expect(await callerFor(USERS.DIRECTOR)).toEqual({ kind: "ANONYMOUS", memberships: [] });
    } finally {
      await db.query("UPDATE ops.app_user SET disabled_at = NULL WHERE id = $1", [USERS.DIRECTOR]);
    }
  });

  it("a session read is never skipped for a token that only looks like one", async () => {
    auth.mockResolvedValue({ user: {} });
    const { getCaller } = await import("./caller");
    expect((await getCaller({ VERCEL_ENV: "production" })).kind).toBe("ANONYMOUS");
  });
});

describe("a signed-in user with no role is refused, not signed out", () => {
  it("is NO_ROLE, carries their own name, and has no membership to scope anything by", async () => {
    expect(await callerFor(USERS.OUTSIDER)).toEqual({
      kind: "NO_ROLE",
      userId: USERS.OUTSIDER,
      displayName: "SYN OUTSIDER",
      memberships: [],
    });
  });
});

describe("the role comes from the database, per request", () => {
  it.each([
    ["DIRECTOR", USERS.DIRECTOR],
    ["COORDINATOR", USERS.COORDINATOR],
    ["FRONT_DESK", USERS.FRONT_DESK],
  ])("%s is read from site_membership, with the site they hold it at", async (role, userId) => {
    expect(await callerFor(userId)).toEqual({
      kind: "STAFF",
      role,
      userId,
      displayName: `SYN ${role}`,
      memberships: [{ siteId: SITE, role }],
    });
  });

  it("gives a person with two memberships their most capable role, and both sites", async () => {
    const caller = await callerFor(USERS.BOTH);
    expect(caller.kind).toBe("STAFF");
    expect(caller).toMatchObject({ role: "DIRECTOR" });
    expect([...caller.memberships].sort((a, b) => a.siteId.localeCompare(b.siteId))).toEqual([
      { siteId: SITE, role: "FRONT_DESK" },
      { siteId: SITE_B, role: "DIRECTOR" },
    ]);
  });

  it("drops a role the moment the membership is removed", async () => {
    await db.query("DELETE FROM ops.site_membership WHERE user_id = $1", [USERS.COORDINATOR]);
    try {
      expect((await callerFor(USERS.COORDINATOR)).kind).toBe("NO_ROLE");
    } finally {
      await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'COORDINATOR')", [USERS.COORDINATOR, SITE]);
    }
  });
});

describe("the browser-test session is a role and nothing else", () => {
  const E2E = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", E2E_DEMO_ROLE: "COORDINATOR" };

  it("grants the named role, with no user id and no membership, and reads no database", async () => {
    auth.mockResolvedValue(null);
    const { getCaller } = await import("./caller");
    // VERCEL_ENV deliberately absent: that is the gate that makes this local-only.
    expect(await getCaller(E2E)).toEqual({
      kind: "STAFF",
      role: "COORDINATOR",
      displayName: "Coordinator",
      memberships: [],
    });
    // No token was decoded either: the branch short-circuits before the session is read.
    expect(auth).not.toHaveBeenCalled();
  });

  it("is refused on every deployment, where VERCEL_ENV is always set", async () => {
    for (const vercelEnv of ["production", "preview", "development", ""]) {
      expect((await callerFor(undefined, { ...E2E, VERCEL_ENV: vercelEnv })).kind).toBe("ANONYMOUS");
    }
  });

  it("is refused without the synthetic data class, without the demo flag, and for an invented role", async () => {
    for (const env of [
      { ...E2E, APP_DATA_CLASS: "REAL" },
      { ...E2E, DEMO_MODE: "0" },
      { ...E2E, E2E_DEMO_ROLE: "SUPERUSER" },
      { ...E2E, E2E_DEMO_ROLE: undefined },
    ]) {
      auth.mockResolvedValue(null);
      const { getCaller } = await import("./caller");
      expect((await getCaller({ ...env, VERCEL_ENV: undefined })).kind).toBe("ANONYMOUS");
    }
  });
});
