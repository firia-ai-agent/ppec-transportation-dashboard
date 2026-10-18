import bcrypt from "bcryptjs";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getActiveUser, getMemberships, requireSiteRole, requireUser, verifyCredentials, Forbidden } from "./core";
import { jwtCallback, sessionCallback } from "./callbacks";
import { encode, decode } from "next-auth/jwt";
import { decideSeed } from "../../scripts/vercel-seed";
import { seedDemoUsers, SeedRefused, DEMO_SITE_A, DEMO_SITE_B } from "./seed";
import { DEMO_ACCOUNTS as DEMO_USERS, DEMO_SHARED_PASSWORD } from "./demo-accounts";
import { authorizeCredentials } from "./credentials";
import type { Exec } from "@/domain/transition";

// Test-only secret, generated per run (never a committed value).
const pw = () => `t-${Math.random().toString(36).slice(2)}-${Date.now()}`;
// The seed needs no password in its environment any more: the three demo accounts share
// `DEMO_SHARED_PASSWORD` (founder decision, DECISION-LEDGER row 59), hashed here at the same
// cost drizzle/0005_demo_shared_password.sql bakes into production.
const env: Record<string, string> = { APP_DATA_CLASS: "SYNTHETIC" };
let db: Exec;

/** A password no account holds after the seed; stands in for "whatever was there before". */
const STALE_PASSWORD = "stale-per-role-password-aaaa";

beforeAll(async () => {
  const pg = new PGlite();
  const dir = join(__dirname, "..", "..", "drizzle");
  const j = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const e of j.entries) for (const s of readFileSync(join(dir, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (s.trim()) await pg.exec(s);
  db = { query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] }) };
  await seedDemoUsers(db, env, { dryRun: false });
}, 60_000);

describe("seed", () => {
  it("refuses a non-synthetic data class, dry run included", async () => {
    await expect(seedDemoUsers(db, { ...env, APP_DATA_CLASS: "REAL" }, { dryRun: true })).rejects.toBeInstanceOf(SeedRefused);
    await expect(seedDemoUsers(db, {}, { dryRun: true })).rejects.toThrow(/APP_DATA_CLASS/);
  });
  it("gives all three the shared password, so local matches the deployed demo", async () => {
    for (const u of DEMO_USERS) {
      expect(await verifyCredentials(db, u.email, DEMO_SHARED_PASSWORD)).toEqual({ id: u.id });
    }
  });
  it("re-running does not reset an existing password unless resetPasswords is set", async () => {
    // A row left on an older password, the way a long-lived database holds one.
    const stale = await bcrypt.hash(STALE_PASSWORD, 12);
    await db.query("UPDATE ops.app_user SET password_hash=$1 WHERE email='coordinator@example.com'", [stale]);
    await seedDemoUsers(db, env, { dryRun: false });
    expect((await db.query<{ h: string }>("SELECT password_hash h FROM ops.app_user WHERE email='coordinator@example.com'", [])).rows[0].h).toBe(stale);
    expect(await verifyCredentials(db, "coordinator@example.com", STALE_PASSWORD)).not.toBeNull();
    expect(await verifyCredentials(db, "coordinator@example.com", DEMO_SHARED_PASSWORD)).toBeNull();
    await seedDemoUsers(db, env, { dryRun: false, resetPasswords: true });
    expect(await verifyCredentials(db, "coordinator@example.com", DEMO_SHARED_PASSWORD)).not.toBeNull();
    expect(await verifyCredentials(db, "coordinator@example.com", STALE_PASSWORD)).toBeNull();
  });
  it("is idempotent and stores only bcrypt hashes, never the password itself", async () => {
    await seedDemoUsers(db, env, { dryRun: false });
    const r = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.app_user WHERE password_hash LIKE '$2%'", []);
    expect(r.rows[0].n).toBe(3);
    const leak = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.app_user WHERE password_hash = $1", [DEMO_SHARED_PASSWORD]);
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
    expect(await verifyCredentials(db, "director@example.com", DEMO_SHARED_PASSWORD)).toEqual({ id: DEMO_USERS[0].id });
    expect(await verifyCredentials(db, "Director@Example.com", DEMO_SHARED_PASSWORD)).not.toBeNull();
    expect(await verifyCredentials(db, "director@example.com", STALE_PASSWORD)).toBeNull();
    expect(await verifyCredentials(db, "nobody@example.com", "whatever")).toBeNull();
  });
  it("takes the shared password through the provider's own authorize step (ADR-004)", async () => {
    // The schema in src/auth/credentials.ts is the one src/auth.ts hands to Auth.js: a
    // four-character password is accepted as it stands (row 59), a wrong one is not.
    for (const u of DEMO_USERS) {
      expect(await authorizeCredentials(db, { email: u.email, password: DEMO_SHARED_PASSWORD })).toEqual({ id: u.id });
    }
    expect(await authorizeCredentials(db, { email: "director@example.com", password: "ppec" })).toBeNull();
    expect(await authorizeCredentials(db, { email: "not-an-email", password: DEMO_SHARED_PASSWORD })).toBeNull();
    expect(await authorizeCredentials(db, { email: "director@example.com", password: "x".repeat(201) })).toBeNull();
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
    expect(await verifyCredentials(db, "frontdesk@example.com", DEMO_SHARED_PASSWORD)).toBeNull();
    expect(await getMemberships(db, fd)).toEqual([]);
    expect(await getActiveUser(db, fd)).toBeNull(); // /whoami redirects on null
    await expect(requireUser(db, fd)).rejects.toBeInstanceOf(Forbidden);
    expect(await getActiveUser(db, "01900000-0000-7000-8000-0000000000ee")).toBeNull(); // deleted / unknown uid
    // The stored name, marker and role included — turning it into "Dana M." is the console's
    // job (src/ui/display-name.ts), not the database's. Read from the account itself so a
    // renamed demo account is tested as it is.
    expect(await getActiveUser(db, dir)).toMatchObject({ id: dir, displayName: DEMO_USERS[0].name });
  });
});

describe("build-time seed gate", () => {
  const ok = { VERCEL_ENV: "preview", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-x.neon.tech/db" };
  it("never seeds from a build: one shared DB (DECISION-LEDGER #43)", () => {
    for (const env of [ok, { ...ok, VERCEL_ENV: "production" }, { ...ok, VERCEL_ENV: undefined }, {}]) {
      expect(decideSeed(env).run).toBe(false);
      expect(decideSeed(env).reason).toContain("DECISION-LEDGER #43");
    }
    expect(decideSeed(ok).reason).toMatch(/^preview: never writes to the shared DB/);
    expect(decideSeed({ ...ok, VERCEL_ENV: "production" }).reason).toMatch(/manual only/);
    expect(JSON.stringify(decideSeed(ok))).not.toContain("://");
  });
});

describe("manual seed on a preview", () => {
  it("refuses to write when VERCEL_ENV=preview, but a dry run is still allowed", async () => {
    await expect(seedDemoUsers(db, { ...env, VERCEL_ENV: "preview" }, { dryRun: false })).rejects.toBeInstanceOf(SeedRefused);
    await expect(seedDemoUsers(db, { ...env, VERCEL_ENV: "preview" }, { dryRun: false, resetPasswords: true })).rejects.toThrow(/DECISION-LEDGER #43/);
    expect(await seedDemoUsers(db, { ...env, VERCEL_ENV: "preview" }, { dryRun: true })).toMatchObject({ dryRun: true });
    expect(await seedDemoUsers(db, { ...env, VERCEL_ENV: "production" }, { dryRun: false })).toMatchObject({ dryRun: false });
  });
});
