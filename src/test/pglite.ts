import { PGlite } from "@electric-sql/pglite";
import { resetTestIdentity } from "./identity-gateway";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAfterCommit, type Db } from "@/db/exec";

export const SITE = "00000000-0000-7000-8000-000000000001";
export const ORG = "00000000-0000-7000-8000-000000000002";

/**
 * Where the DB-backed suites run.
 *
 * By default: PGlite, in this process, with every migration applied — no setup, no server, and
 * nothing anybody can point at the wrong database.
 *
 * Optionally: a **throwaway local Postgres**, for a reviewer who wants the real engine
 * (`pnpm test:db`, see README "Database tests"). Set `TEST_DATABASE_URL` to it. The host is
 * checked rather than trusted: anything but a loopback address is refused outright, because
 * these suites **drop and recreate the whole `ops` schema** and the shared Neon database is one
 * typo away from any other connection string.
 */
export const LOCAL_DB_URL = process.env.TEST_DATABASE_URL;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `TEST_DATABASE_URL must be a throwaway local Postgres (localhost), not ${host}: these ` +
        "tests recreate the ops schema and must never touch a shared database",
    );
  }
}

/** Fresh DB with all drizzle/ migrations applied, plus one SYN org + site. Test-only. */
export async function freshDb(): Promise<{ pg: PGlite; db: Db }> {
  // A new database means a new identity: the suites' in-memory gateway starts empty too (S1-6).
  resetTestIdentity();
  const pg = new PGlite();
  const dir = join(__dirname, "..", "..", "drizzle");
  const j = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const e of j.entries) for (const s of readFileSync(join(dir, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (s.trim()) await pg.exec(s);
  await pg.exec(`INSERT INTO ops.org (id,name,created_by,updated_by) VALUES ('${ORG}','SYN Org','test','test');
    INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by) VALUES ('${SITE}','${ORG}','SYN Site',26.645352,-80.145541,'test','test');`);
  const db: Db = {
    query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] }),
    async tx(fn) {
      const hooks: (() => Promise<void>)[] = [];
      const r = await pg.transaction(async (t) =>
        fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params)).rows as never[] }) }, (h) => hooks.push(h)));
      await runAfterCommit(hooks);
      return r;
    },
  };
  return { pg, db };
}

/**
 * THE SAME DATABASE, SEEN THE WAY THE APPLICATION SEES IT: as `app_rw`.
 *
 * `freshDb()` hands back a connection running as the PGlite superuser, which can read
 * everything — including `identity`, which the deployed application role cannot
 * (0001_roles.sql; src/db/schema.ts:104 "App role `app_rw` gets NO select on these"). That gap
 * is why a query against `identity.*` on the app connection passed every local suite and then
 * answered `permission denied for schema identity` on the preview, taking Family texts down
 * with it (12:13 AM ET).
 *
 * So this wraps the same `PGlite` instance in a `Db` whose every statement — autocommit and
 * transactional — runs after `SET LOCAL ROLE app_rw`. `LOCAL`, so the role is scoped to the
 * transaction and nothing is left on the connection for the next caller.
 *
 * Seed with `freshDb()`'s own `db` (the migrator and the gateway write identity rows); *read*
 * through this one wherever the thing under test is something a page or a route handler does.
 * A read that needs identity then fails here, locally, instead of on a deployment.
 */
export function appRoleDb(pg: PGlite): Db {
  const inRole = async <T,>(fn: (t: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> =>
    pg.transaction(async (t) => {
      await t.query("SET LOCAL ROLE app_rw");
      return fn(t);
    }) as Promise<T>;
  return {
    query: async (sql, params) =>
      inRole(async (t) => ({ rows: (await t.query(sql as string, params as unknown[])).rows as never[] })),
    async tx(fn) {
      const hooks: (() => Promise<void>)[] = [];
      const r = await inRole((t) =>
        fn({ query: async (sql, params) => ({ rows: (await t.query(sql as string, params as unknown[])).rows as never[] }) }, (h) => hooks.push(h)));
      await runAfterCommit(hooks);
      return r;
    },
  };
}

/**
 * The same fresh database, over **either** engine — for the suites a reviewer may want to run
 * against a real Postgres (`pnpm test:db`, README "Database tests").
 *
 * With no `TEST_DATABASE_URL` this is `freshDb()` and nothing changes: PGlite, in this process,
 * every migration applied, no setup. With one, it connects to that **local** database, drops and
 * recreates the application schemas, and applies the same migration files — so the statements
 * under test meet the engine a deployment runs rather than an emulation of it.
 *
 * It refuses any non-loopback host (`assertLocal`). These suites recreate schemas; the shared
 * Neon database must never be on the other end of that, and a check beats a warning in a README.
 */
export async function freshPlanDb(): Promise<{ db: Db; close: () => Promise<void>; engine: string }> {
  if (!LOCAL_DB_URL) {
    const { pg, db } = await freshDb();
    return { db, close: () => pg.close(), engine: "pglite" };
  }
  assertLocal(LOCAL_DB_URL);
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: LOCAL_DB_URL, max: 4 });
  const sql = migrationStatements();
  /*
   * A clean slate, every time: the app's two schemas **and** `public`, where the enum types
   * live. Re-applying the migrations over leftover types fails with "type … already exists",
   * and a half-migrated database is a worse answer than a slow one. This is why the URL has to
   * be loopback (`assertLocal` above) — it is a destructive reset of whatever it points at.
   */
  await pool.query(
    `DROP SCHEMA IF EXISTS ops CASCADE;
     DROP SCHEMA IF EXISTS identity CASCADE;
     DROP SCHEMA IF EXISTS drizzle CASCADE;
     DROP SCHEMA IF EXISTS public CASCADE;
     CREATE SCHEMA public;`,
  );
  for (const statement of sql) await pool.query(statement);
  await pool.query(
    `INSERT INTO ops.org (id,name,created_by,updated_by) VALUES ($1,'SYN Org','test','test')
     ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
  await pool.query(
    `INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by)
     VALUES ($1,$2,'SYN Site',26.645352,-80.145541,'test','test') ON CONFLICT (id) DO NOTHING`,
    [SITE, ORG],
  );
  const db: Db = {
    query: async (text, params) => ({ rows: (await pool.query(text, params as unknown[])).rows as never[] }),
    async tx(fn) {
      const client = await pool.connect();
      const hooks: (() => Promise<void>)[] = [];
      try {
        await client.query("BEGIN");
        const result = await fn(
          { query: async (text, params) => ({ rows: (await client.query(text, params as unknown[])).rows as never[] }) },
          (hook) => hooks.push(hook),
        );
        await client.query("COMMIT");
        await runAfterCommit(hooks);
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return { db, close: () => pool.end(), engine: "postgres" };
}

/** Every statement in drizzle/, in journal order — the same list `freshDb` applies. */
function migrationStatements(): string[] {
  const dir = join(__dirname, "..", "..", "drizzle");
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.flatMap((entry) =>
    readFileSync(join(dir, `${entry.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean),
  );
}
