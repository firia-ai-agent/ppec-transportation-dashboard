import type { Exec } from "@/domain/transition";
import { getPool } from "@/db/pool";

/** Raw-SQL executor over the shared pool, for auth lookups. */
export function getExec(): Exec {
  const p = getPool();
  return { query: async (sql, params) => { const r = await p.query(sql, params); return { rows: r.rows }; } };
}
