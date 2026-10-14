import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getActiveUser, getMemberships, requireSiteRole, requireUser, verifyCredentials, Forbidden } from "./core";
import { jwtCallback, sessionCallback } from "./callbacks";
import { encode, decode } from "next-auth/jwt";
import { decideSeed } from "../../scripts/vercel-seed";
import { seedDemoUsers, SeedRefused, DEMO_SITE_A, DEMO_SITE_B, DEMO_USERS } from "./seed";
import type { Exec } from "@/domain/transition";

// Test-only passwords, generated per run (never committed values).
const pw = () => `t-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const env: Record<string, string> = {
  APP_DATA_CLASS: "SYNTHETIC",
  DEMO_DIRECTOR_PASSWORD: pw(), DEMO_COORDINATOR_PASSWORD: pw(), DEMO_FRONT_DESK_PASSWORD: pw(),
};
let db: Exec;

beforeAll(async () => {
  const pg = new PGlite();
  const dir = join(__dirname, "..", "..", "drizzle");
  const j = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const e of j.entries) for (const s of readFileSync(join(dir, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (s.trim()) await pg.exec(s);
  db = { query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] }) };
  await seedDemoUsers(db, env, { dryRun: false });
}, 60_000);

describe("seed", () => {
  it("refuses non-synthetic data class and missing passwords", async () => {
    await expect(seedDemoUsers(db, { ...env, APP_DATA_CLASS: "REAL" }, { dryRun: true })).rejects.toBeInstanceOf(SeedRefused);
    await expect(seedDemoUsers(db, { APP_DATA_CLASS: "SYNTHETIC" }, { dryRun: true })).rejects.toThrow(/DEMO_DIRECTOR_PASSWORD/);
  });
  it("re-running does not reset existing passwords unless resetPasswords is set", async () => {
    const before = (await db.query<{ h: string }>("SELECT password_hash h FROM ops.app_user WHERE email='coordinator@example.com'", [])).rows[0].h;
    const env2 = { ...env, DEMO_COORDINATOR_PASSWORD: pw() };
    await seedDemoUsers(db, env2, { dryRun: false });
    expect((await db.query<{ h: string }>("SELECT password_hash h FROM ops.app_user WHERE email='coordinator@example.com'", [])).rows[0].h).toBe(before);
    expect(await verifyCredentials(db, "coordinator@example.com", env.DEMO_COORDINATOR_PASSWORD)).not.toBeNull();
    await seedDemoUsers(db, env2, { dryRun: false, resetPasswords: true });
    expect(await verifyCredentials(db, "coordinator@example.com", env2.DEMO_COORDINATOR_PASSWORD)).not.toBeNull();
    expect(await verifyCredentials(db, "coordinator@example.com", env.DEMO_COORDINATOR_PASSWORD)).toBeNull();
    await seedDemoUsers(db, env, { dryRun: false, resetPasswords: true });
  });
  it("is idempotent and stores only bcrypt hashes", async () => {
    await seedDemoUsers(db, env, { dryRun: false });
    const r = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.app_user WHERE password_hash LIKE '$2%'", []);
    expect(r.rows[0].n).toBe(3);
    const leak = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.app_user WHERE password_hash = $1", [env.DEMO_DIRECTOR_PASSWORD]);
    expect(leak.rows[0].n).toBe(0);
  });
  it("uses only example.com identities", () => {
    for (const u of DEMO_USERS) expect(u.email.endsWith("@example.com")).toBe(true);
  });
});

describe("session token carries only uid (ADR-004)", () => {
  it("jwt callback drops name/email/picture/sub on sign-in and on refresh", () => {
    const dflt = { name: "SYN Dana Director", email: "director@example.com", picture: "x", sub: "abc" };
    expect(jwtCallback({ token: dflt, user: { id: "u1" } })).toEqual({ uid: "u1" });
    expect(jwtCallback({ token: { ...dflt, uid: "u1", iat: 1, exp: 2, jti: "j" } })).toEqual({ uid: "u1" });
    expect(sessionCallback({ session: { user: { name: "n", email: "e" }, expires: "x" }, token: { uid: "u1" } })).toEqual({ user: { id: "u1" }, expires: "x" });
  });
  it("encoded token decodes to uid + standard claims only", async () => {
    const secret = `test-${pw()}`;
    const token = jwtCallback({ token: { name: "n", email: "e", picture: "p", sub: "s" }, user: { id: "u1" } });
    const jwe = await encode({ token, secret, salt: "authjs.session-token", maxAge: 60 });
    const payload = await decode({ token: jwe, secret, salt: "authjs.session-token" });
    expect(Object.keys(payload ?? {}).sort()).toEqual(["exp", "iat", "jti", "uid"]);
  });
});

describe("credentials + roles from DB", () => {
  it("accepts the right password, rejects wrong / unknown", async () => {
    expect(await verifyCredentials(db, "director@example.com", env.DEMO_DIRECTOR_PASSWORD)).toEqual({ id: DEMO_USERS[0].id });
    expect(await verifyCredentials(db, "Director@Example.com", env.DEMO_DIRECTOR_PASSWORD)).not.toBeNull();
    expect(await verifyCredentials(db, "director@example.com", env.DEMO_COORDINATOR_PASSWORD)).toBeNull();
    expect(await verifyCredentials(db, "nobody@example.com", "whatever")).toBeNull();
  });
  it("roles are read from site_membership and change without re-login", async () => {
    const coord = DEMO_USERS[1].id;
    expect(await getMemberships(db, coord)).toEqual([{ siteId: DEMO_SITE_A, role: "COORDINATOR" }]);
    await expect(requireSiteRole(db, coord, DEMO_SITE_A, ["DIRECTOR"])).rejects.toBeInstanceOf(Forbidden);
    await db.query("UPDATE ops.site_membership SET role='DIRECTOR' WHERE user_id=$1", [coord]);
    await expect(requireSiteRole(db, coord, DEMO_SITE_A, ["DIRECTOR"])).resolves.toMatchObject({ role: "DIRECTOR" });
    await db.query("UPDATE ops.site_membership SET role='COORDINATOR' WHERE user_id=$1", [coord]);
  });
  it("other site and signed-out are forbidden; disabled user loses access", async () => {
    const dir = DEMO_USERS[0].id;
    await expect(requireSiteRole(db, dir, DEMO_SITE_B, ["DIRECTOR"])).rejects.toBeInstanceOf(Forbidden);
    await expect(requireSiteRole(db, undefined, DEMO_SITE_A, ["DIRECTOR"])).rejects.toBeInstanceOf(Forbidden);
    const fd = DEMO_USERS[2].id;
    await db.query("UPDATE ops.app_user SET disabled_at=now() WHERE id=$1", [fd]);
    expect(await verifyCredentials(db, "frontdesk@example.com", env.DEMO_FRONT_DESK_PASSWORD)).toBeNull();
    expect(await getMemberships(db, fd)).toEqual([]);
    expect(await getActiveUser(db, fd)).toBeNull(); // /whoami redirects on null
    await expect(requireUser(db, fd)).rejects.toBeInstanceOf(Forbidden);
    expect(await getActiveUser(db, "01900000-0000-7000-8000-0000000000ee")).toBeNull(); // deleted / unknown uid
    expect(await getActiveUser(db, dir)).toMatchObject({ id: dir, displayName: "SYN Dana Director" });
  });
});

describe("build-time seed gate", () => {
  const ok = { VERCEL_ENV: "preview", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL_UNPOOLED: "x",
    DEMO_DIRECTOR_PASSWORD: "a", DEMO_COORDINATOR_PASSWORD: "b", DEMO_FRONT_DESK_PASSWORD: "c" };
  it("runs on preview only, with SYNTHETIC and all demo passwords present", () => {
    expect(decideSeed(ok).run).toBe(true);
    expect(decideSeed({ ...ok, VERCEL_ENV: "production" }).run).toBe(false);
    expect(decideSeed({ ...ok, APP_DATA_CLASS: "REAL" }).run).toBe(false);
    expect(decideSeed({ ...ok, DEMO_FRONT_DESK_PASSWORD: undefined }).reason).toMatch(/DEMO_FRONT_DESK_PASSWORD/);
    expect(JSON.stringify(decideSeed({ ...ok, DATABASE_URL_UNPOOLED: undefined }))).not.toContain("://");
  });
});
