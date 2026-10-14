import pg from "pg";
import type { Exec } from "@/domain/transition";
import { READ_ONLY_SESSION_SQL, dbSessionOptions, isReadOnlyDbEnv } from "@/db/read-only";

/**
 * One dedicated connection (so BEGIN/COMMIT in the seed are a real transaction). For scripts/build steps only.
 * On previews the session is opened read-only (DECISION-LEDGER #43) so a stray write fails in Postgres;
 * the callers also refuse up front (see seedDemoUsers).
 */
export async function withClientExec<T>(url: string, fn: (db: Exec) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true }, ...dbSessionOptions(process.env) });
  await c.connect();
  if (isReadOnlyDbEnv(process.env)) await c.query(READ_ONLY_SESSION_SQL);
  try { return await fn({ query: async (sql, params) => ({ rows: (await c.query(sql, params as unknown[])).rows }) }); }
  finally { await c.end(); }
}
