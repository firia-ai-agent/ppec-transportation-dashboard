import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeCredentials } from "@/auth/credentials";
import { DEMO_ACCOUNTS, DEMO_EMAILS, DEMO_SHARED_PASSWORD } from "@/auth/demo-accounts";
import type { Exec } from "@/domain/transition";

/**
 * drizzle/0005_demo_shared_password.sql on PGlite (founder decision, DECISION-LEDGER row 59).
 *
 * The migration is the only thing that gives the deployed demo its shared password: production
 * is never seeded from a build (scripts/vercel-seed.ts), so the production build's migrate step
 * (scripts/vercel-db-step.mjs) is where the three rows change. These tests apply the schema
 * migrations *without* it, plant users the way a long-lived database already holds them — three
 * demo accounts on an older password, plus one non-demo user as a control — and then run the
 * data migration exactly as the migrator would, twice.
 *
 * What is held here: it touches those three rows and nothing else, no column but
 * `password_hash`, inserts nothing, is safe to run again, and the password it installs is the
 * one /login prints — checked by signing in through the real authorize path.
 */
const DIR = join(__dirname, "..", "..", "drizzle");
const TAG = "0005_demo_shared_password";
const SQL = readFileSync(join(DIR, `${TAG}.sql`), "utf8");
const JOURNAL = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

/** A user the migration must not touch: not one of the three emails, same table, same shape. */
const CONTROL = {
  id: "01900000-0000-7000-8000-0000000000e1",
  email: "someone.else@example.com",
  name: "SYN Sam Elsewhere",
  password: "control-password-not-the-shared-one",
};

/** The password the three accounts held before row 59, so a no-op would be visible as a failure. */
const OLD_PASSWORD = "old-per-role-password-aaaa";

type Row = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  disabled_at: string | null;
  created_at: string;
};

let pg: PGlite;
let db: Exec;

/** Every migration except the data one, in journal order: the schema, before row 59 ran. */
async function applySchemaMigrations(target: PGlite): Promise<void> {
  for (const entry of JOURNAL.entries) {
    if (entry.tag === TAG) continue;
    const sql = readFileSync(join(DIR, `${entry.tag}.sql`), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await target.exec(stmt);
  }
}

/** The same split the migrator and src/test/pglite.ts use, so the test runs what production runs. */
async function applyDataMigration(target: PGlite): Promise<void> {
  for (const stmt of SQL.split("--> statement-breakpoint")) if (stmt.trim()) await target.exec(stmt);
}

const dump = () =>
  pg.query<Row>(
    `SELECT id, email, display_name, password_hash, disabled_at, created_at FROM ops.app_user ORDER BY email`,
  ).then((r) => r.rows);

beforeEach(async () => {
  pg = new PGlite();
  await applySchemaMigrations(pg);
  db = { query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] }) };
  const old = await bcrypt.hash(OLD_PASSWORD, 12);
  for (const u of DEMO_ACCOUNTS) {
    await pg.query(
      `INSERT INTO ops.app_user (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
      [u.id, u.email, u.name, old],
    );
  }
  await pg.query(
    `INSERT INTO ops.app_user (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
    [CONTROL.id, CONTROL.email, CONTROL.name, await bcrypt.hash(CONTROL.password, 12)],
  );
}, 60_000);

describe("the migration changes exactly the three demo passwords", () => {
  it("rewrites password_hash for the three emails and leaves every other column alone", async () => {
    const before = await dump();
    await applyDataMigration(pg);
    const after = await dump();

    expect(after).toHaveLength(before.length);
    const changed = after.filter((row, i) => row.password_hash !== before[i].password_hash);
    expect(changed.map((r) => r.email).sort()).toEqual([...DEMO_EMAILS].sort());
    // Same rows, same everything else: only the hash column moved.
    expect(after.map((r) => ({ ...r, password_hash: "" }))).toEqual(
      before.map((r) => ({ ...r, password_hash: "" })),
    );
    expect(new Set(changed.map((r) => r.password_hash)).size).toBe(1);
  });

  it("leaves a non-demo user's password untouched, hash and sign-in both", async () => {
    const before = (await dump()).find((r) => r.email === CONTROL.email);
    await applyDataMigration(pg);
    const after = (await dump()).find((r) => r.email === CONTROL.email);
    expect(after).toEqual(before);
    expect(await authorizeCredentials(db, { email: CONTROL.email, password: CONTROL.password })).toEqual({ id: CONTROL.id });
    expect(await authorizeCredentials(db, { email: CONTROL.email, password: DEMO_SHARED_PASSWORD })).toBeNull();
  });

  it("inserts nothing: on a database without those users it updates no row", async () => {
    const empty = new PGlite();
    await applySchemaMigrations(empty);
    await applyDataMigration(empty);
    const n = await empty.query<{ n: number }>(`SELECT count(*)::int n FROM ops.app_user`);
    expect(n.rows[0].n).toBe(0);
  });

  it("is safe to run twice: the second run writes the same bytes", async () => {
    await applyDataMigration(pg);
    const once = await dump();
    await applyDataMigration(pg);
    expect(await dump()).toEqual(once);
  });
});

describe("the hash it installs is the app's own, for the password /login prints", () => {
  it("is bcrypt at cost 12, the cost src/auth/seed.ts uses", async () => {
    await applyDataMigration(pg);
    for (const row of await dump()) {
      if (!DEMO_EMAILS.includes(row.email)) continue;
      expect(row.password_hash.startsWith("$2b$12$")).toBe(true);
      expect(await bcrypt.compare(DEMO_SHARED_PASSWORD, row.password_hash)).toBe(true);
      expect(await bcrypt.compare(OLD_PASSWORD, row.password_hash)).toBe(false);
    }
  });

  it("signs each of the three in with the shared password through the real authorize path", async () => {
    await applyDataMigration(pg);
    for (const account of DEMO_ACCOUNTS) {
      expect(await authorizeCredentials(db, { email: account.email, password: DEMO_SHARED_PASSWORD })).toEqual({ id: account.id });
      // The same path Auth.js takes, so the lowercase/uppercase rule is the deployed one too.
      expect(await authorizeCredentials(db, { email: account.email.toUpperCase(), password: DEMO_SHARED_PASSWORD })).toEqual({ id: account.id });
    }
  });

  it("refuses a wrong password, the old one included, and refuses nonsense input", async () => {
    await applyDataMigration(pg);
    for (const account of DEMO_ACCOUNTS) {
      expect(await authorizeCredentials(db, { email: account.email, password: "PPEc" })).toBeNull();
      expect(await authorizeCredentials(db, { email: account.email, password: OLD_PASSWORD })).toBeNull();
      expect(await authorizeCredentials(db, { email: account.email, password: "" })).toBeNull();
      expect(await authorizeCredentials(db, { email: account.email })).toBeNull();
    }
    expect(await authorizeCredentials(db, { email: "nobody@example.com", password: DEMO_SHARED_PASSWORD })).toBeNull();
  });

  it("accepts the four-character password: no minimum length stands in its way", async () => {
    await applyDataMigration(pg);
    expect(DEMO_SHARED_PASSWORD).toHaveLength(4);
    expect(await authorizeCredentials(db, { email: DEMO_ACCOUNTS[0].email, password: DEMO_SHARED_PASSWORD })).not.toBeNull();
  });
});

describe("the migration file itself", () => {
  it("is one UPDATE of one column, against the three emails, and nothing else", () => {
    const body = SQL.replace(/^\s*--.*$/gm, "").trim();
    expect(body.match(/\bUPDATE\b/gi)).toHaveLength(1);
    expect(body).not.toMatch(/\b(INSERT|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i);
    expect(body).toMatch(/UPDATE "ops"\."app_user" SET "password_hash" = '\$2b\$12\$[./A-Za-z0-9]{53}'/);
    expect(body.match(/SET\b/gi)).toHaveLength(1);
    for (const email of DEMO_EMAILS) expect(body).toContain(`'${email}'`);
    expect(body.match(/@example\.com/g)).toHaveLength(3);
    expect(body.endsWith(";")).toBe(true);
  });

  it("carries the hash, never the password", () => {
    expect(SQL).not.toContain(DEMO_SHARED_PASSWORD);
  });

  it("is in the journal, with a snapshot that says the schema did not move", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(JOURNAL.entries.at(-1)).toEqual(entry);
    const snap = (idx: string) =>
      JSON.parse(readFileSync(join(DIR, "meta", `${idx}_snapshot.json`), "utf8")) as Record<string, unknown>;
    const mine = snap("0005");
    const previous = snap("0003");
    expect(mine.prevId).toBe(previous.id);
    expect(mine.id).not.toBe(previous.id);
    // A data migration must not carry a schema change: everything but the two ids is identical.
    const strip = (s: Record<string, unknown>) => ({ ...s, id: null, prevId: null });
    expect(strip(mine)).toEqual(strip(previous));
  });
});
