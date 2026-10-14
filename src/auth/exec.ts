import { Pool } from "@neondatabase/serverless";
import type { Exec } from "@/domain/transition";

let pool: Pool | undefined;
/** Raw-SQL executor over the pooled Neon URL, for auth lookups. */
export function getExec(): Exec {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new Pool({ connectionString: url });
  const p = pool;
  return { query: async (sql, params) => { const r = await p.query(sql, params); return { rows: r.rows }; } };
}
