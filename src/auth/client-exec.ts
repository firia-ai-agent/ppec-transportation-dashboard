import pg from "pg";
import type { Exec } from "@/domain/transition";

/** One dedicated connection (so BEGIN/COMMIT in the seed are a real transaction). For scripts/build steps only. */
export async function withClientExec<T>(url: string, fn: (db: Exec) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await c.connect();
  try { return await fn({ query: async (sql, params) => ({ rows: (await c.query(sql, params as unknown[])).rows }) }); }
  finally { await c.end(); }
}
