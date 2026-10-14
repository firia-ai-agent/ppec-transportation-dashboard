import { Pool } from "@neondatabase/serverless";

let pool: Pool | undefined;
/** One shared Neon WebSocket Pool per server instance (pooled DATABASE_URL, ADR-009). Never logs the URL. */
export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new Pool({ connectionString: url });
  return pool;
}
