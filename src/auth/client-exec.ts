import pg from "pg";
import type { Exec } from "@/domain/transition";
import { READ_ONLY_REASON, isReadOnlyDbEnv } from "@/db/read-only";

/**
 * One dedicated connection (so BEGIN/COMMIT in the seed are a real transaction). For scripts/build steps only.
 * No connection-level state is configured or set: previews share production's role, database and endpoint
 * (DECISION-LEDGER #43), so anything session-scoped could leak onto a backend production later reuses.
 *
 * On previews this refuses outright rather than wrapping `fn` in BEGIN READ ONLY … COMMIT: callers here own
 * their transactions (seedDemoUsers issues its own BEGIN/COMMIT), and an inner COMMIT would close the
 * read-only transaction early and leave the rest of the script writing in autocommit — a guard that quietly
 * stops guarding. Scripts have no reason to touch the shared DB from a preview; the seed already refuses too.
 */
export async function withClientExec<T>(url: string, fn: (db: Exec) => Promise<T>): Promise<T> {
  if (isReadOnlyDbEnv(process.env)) throw new Error(READ_ONLY_REASON);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await c.connect();
  try { return await fn({ query: async (sql, params) => ({ rows: (await c.query(sql, params as unknown[])).rows }) }); }
  finally { await c.end(); }
}
