import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb, ORG, SITE } from "@/test/pglite";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { BOARD_CENSUS } from "./fixtures/standard";
import { PREVIEW_REFUSAL, demoControlsGate, handleDemoReset } from "./reset";

const SITE_B = "00000000-0000-7000-8000-0000000000b1";
const USERS = {
  DIRECTOR: "00000000-0000-7000-8000-0000000000d1",
  COORDINATOR: "00000000-0000-7000-8000-0000000000c1",
  FRONT_DESK: "00000000-0000-7000-8000-0000000000f1",
  OUTSIDER: "00000000-0000-7000-8000-0000000000e1", // active user, no membership at either site
  DIRECTOR_B: "00000000-0000-7000-8000-0000000000d2",
};
const env = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "test-pepper", DATA_KEY: "test-data-key" };
const NOW = new Date("2026-10-13T17:45:00.000Z");

let pg: PGlite; let db: Db;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  await db.query(
    `INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by)
     VALUES ($1,$2,'SYN Second Site',26.645352,-80.145541,'test','test')`, [SITE_B, ORG]);
  for (const [role, id] of Object.entries(USERS)) {
    await db.query(
      "INSERT INTO ops.app_user (id,email,display_name,password_hash) VALUES ($1,$2,$3,'$2b$12$notarealhash')",
      [id, `${role.toLowerCase()}@example.com`, `SYN ${role}`]);
  }
  for (const role of ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] as const) {
    await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,$3)", [USERS[role], SITE, role]);
  }
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.DIRECTOR_B, SITE_B]);
}, 60_000);

// One PGlite per test adds up: close it, or the worker is killed part-way through the file.
afterEach(async () => { await pg.close(); });

const childCount = async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.child_profile", [])).rows[0].n;

describe("POST /api/demo/reset gating (ADR-014, ADR-015)", () => {
  it("is invisible unless the demo controls are on", async () => {
    expect(demoControlsGate({ APP_DATA_CLASS: "SYNTHETIC" }).status).toBe(404);
    expect(demoControlsGate({ APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "0" }).status).toBe(404);
    const r = await handleDemoReset(db, { ...env, DEMO_MODE: "0" }, { userId: USERS.DIRECTOR, now: NOW });
    expect(r.status).toBe(404);
    expect(await childCount()).toBe(0);
  });

  it("refuses on a preview deployment, even for a DIRECTOR, before touching the DB", async () => {
    // A preview is served production's DATABASE_URL (DECISION-LEDGER #43): a reset there would wipe
    // the real demo data, so this gate is checked ahead of the flags and the role.
    expect(demoControlsGate({ ...env, VERCEL_ENV: "preview" })).toEqual({ allowed: false, status: 403, reason: PREVIEW_REFUSAL });
    expect(demoControlsGate({ VERCEL_ENV: "preview" }).status).toBe(403);
    for (const siteId of [SITE, SITE_B, undefined]) {
      const r = await handleDemoReset(db, { ...env, VERCEL_ENV: "preview" }, { userId: USERS.DIRECTOR, siteId, now: NOW });
      expect({ siteId, status: r.status, body: r.body }).toEqual({ siteId, status: 403, body: { ok: false, error: PREVIEW_REFUSAL } });
    }
    expect(await childCount()).toBe(0);
  });

  it("runs as before on production and off Vercel entirely", async () => {
    for (const vercelEnv of ["production", "development", undefined]) {
      expect({ vercelEnv, allowed: demoControlsGate({ ...env, VERCEL_ENV: vercelEnv }).allowed }).toEqual({ vercelEnv, allowed: true });
    }
    for (const vercelEnv of ["production", undefined]) { // the seed is idempotent, so twice is safe
      const r = await handleDemoReset(db, { ...env, VERCEL_ENV: vercelEnv }, { userId: USERS.DIRECTOR, siteId: SITE, now: NOW });
      expect({ vercelEnv, status: r.status }).toEqual({ vercelEnv, status: 200 });
    }
    expect(await childCount()).toBe(BOARD_CENSUS);
  }, 120_000);

  it("refuses unless the data class is SYNTHETIC", async () => {
    expect(demoControlsGate({ DEMO_MODE: "1", APP_DATA_CLASS: "REAL" }).status).toBe(403);
    expect(demoControlsGate({ DEMO_MODE: "1" }).status).toBe(403);
    for (const dataClass of ["REAL", "PHI", "", undefined]) {
      const r = await handleDemoReset(db, { ...env, APP_DATA_CLASS: dataClass }, { userId: USERS.DIRECTOR, siteId: SITE, now: NOW });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/synthetic/i);
    }
    expect(await childCount()).toBe(0);
  });

  it("requires a signed-in user", async () => {
    const r = await handleDemoReset(db, env, { userId: undefined, siteId: SITE, now: NOW });
    expect(r.status).toBe(401);
    expect(await childCount()).toBe(0);
  });

  it("is DIRECTOR only: a member with the wrong role gets 403, a non-member gets the uniform 404", async () => {
    // Same site, role not allowed → 403 (BUILD-PLAN §4). It is their site either way, so there
    // is nothing about its existence left to hide.
    for (const userId of [USERS.COORDINATOR, USERS.FRONT_DESK]) {
      for (const siteId of [SITE, undefined]) {
        const r = await handleDemoReset(db, env, { userId, siteId, now: NOW });
        expect({ userId, siteId, status: r.status }).toEqual({ userId, siteId, status: 403 });
      }
    }
    // No membership anywhere: naming the site is a 404, and naming no site is a 403 — the
    // second answer carries no id, so it reveals nothing.
    expect((await handleDemoReset(db, env, { userId: USERS.OUTSIDER, siteId: SITE, now: NOW })).status).toBe(404);
    expect((await handleDemoReset(db, env, { userId: USERS.OUTSIDER, now: NOW })).status).toBe(403);
    // A disabled user is refused before any site is looked at: the session is no longer a user.
    await db.query("UPDATE ops.app_user SET disabled_at = now() WHERE id = $1", [USERS.DIRECTOR]);
    expect((await handleDemoReset(db, env, { userId: USERS.DIRECTOR, siteId: SITE, now: NOW })).status).toBe(401);
    await db.query("UPDATE ops.app_user SET disabled_at = NULL WHERE id = $1", [USERS.DIRECTOR]);
    expect(await childCount()).toBe(0);
  });

  it("a director of another site cannot reset this one, and cannot tell it apart from a site that does not exist (ID swap)", async () => {
    const mine = { userId: USERS.DIRECTOR_B, now: NOW };
    const other = await handleDemoReset(db, env, { ...mine, siteId: SITE });
    const random = await handleDemoReset(db, env, { ...mine, siteId: "00000000-0000-7000-8000-00000000dead" });
    expect(other.status).toBe(404);
    // Byte-for-byte the same answer, so the response cannot be used to enumerate sites.
    expect(random).toEqual(other);
    expect(await childCount()).toBe(0);
    // Its own site is fine.
    expect((await handleDemoReset(db, env, { ...mine, siteId: SITE_B })).status).toBe(200);
  }, 60_000);

  /**
   * A reset forgets the saved plans too — on both sides of the store.
   *
   * The plan lives in `ops.plan_run` / `ops.plan_assignment` now (migration 0009), which the
   * seed's own TRUNCATE clears. The memory store is the other side: the browser check runs with
   * no database at all (src/modules/plan/memory.ts), and a day that has just been re-seeded
   * cannot still have last night's plan of it hanging about there either.
   */
  it("forgets a plan saved for the demo day", async () => {
    clearMemoryPlanStore();
    const store = memoryPlanStore();
    const saved = await store.savePlan(SITE, {
      date: "2026-10-14",
      direction: "AM",
      version: 0,
      placements: { "01900000-0000-7000-8000-001100000007": { bucket: "UNASSIGNED", vanId: null, pinned: true } },
      savedBy: null,
      now: new Date("2026-10-14T11:02:00.000Z"),
    });
    expect(saved.ok).toBe(true);
    expect(await store.loadPlan(SITE, "2026-10-14", "AM")).not.toBeNull();
    const done = await handleDemoReset(db, env, { userId: USERS.DIRECTOR, now: NOW });
    expect(done.status).toBe(200);
    expect(await store.loadPlan(SITE, "2026-10-14", "AM")).toBeNull();
  });

  it("a director gets the scenario, the counts and the board census back", async () => {
    const r = await handleDemoReset(db, env, { userId: USERS.DIRECTOR, now: NOW });
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body.ok).toBe(true);
    expect(r.body.scenario).toBe("standard");
    expect(r.body.siteId).toBe(SITE); // resolved from the caller's own membership, not from the request
    expect(r.body.boardRows).toBe(BOARD_CENSUS);
    expect(r.body.counts["ops.trip_leg"]).toBe(56);
    expect(await childCount()).toBe(BOARD_CENSUS);
    // The reset leaves the auth tables alone (ADR-014: never the identity/auth config).
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.app_user", [])).rows[0].n).toBe(5);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.site_membership", [])).rows[0].n).toBe(4);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.site", [])).rows[0].n).toBe(2);
  }, 60_000);

  it("asks which site when the caller directs more than one", async () => {
    await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,'DIRECTOR')", [USERS.DIRECTOR, SITE_B]);
    const r = await handleDemoReset(db, env, { userId: USERS.DIRECTOR, now: NOW });
    expect(r.status).toBe(400);
    expect(await childCount()).toBe(0);
  });

  it("says nothing about tickets, roles it did not grant, or secrets", async () => {
    const bodies: string[] = [];
    for (const e of [{ ...env, DEMO_MODE: "0" }, { ...env, APP_DATA_CLASS: "REAL" }, env]) {
      bodies.push(JSON.stringify((await handleDemoReset(db, e, { userId: USERS.COORDINATOR, siteId: SITE, now: NOW })).body));
    }
    for (const b of bodies) {
      expect(b).not.toMatch(/PPE-|B-15|\bticket\b/i);
      expect(b).not.toMatch(/pepper|DATA_KEY|password/i);
    }
  });
});
