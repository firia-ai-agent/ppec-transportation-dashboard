import { Pool, type PoolClient } from "@neondatabase/serverless";
import { READ_ONLY_SESSION_SQL, dbSessionOptions, isReadOnlyDbEnv } from "./read-only";

let pool: Pool | undefined;
/**
 * One shared Neon WebSocket Pool per server instance (pooled DATABASE_URL, ADR-009). Never logs the URL.
 * Previews share the one production DB (DECISION-LEDGER #43), so there every session is read-only:
 * the startup option is the primary guard, the per-connection SET the fallback if a proxy drops it.
 * The pool emits "connect" before the client is handed out and pg queues queries FIFO, so the SET
 * always runs ahead of the first application query on that connection.
 */
export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = new Pool({ connectionString: url, ...dbSessionOptions(process.env) });
    if (isReadOnlyDbEnv(process.env)) {
      pool.on("connect", (client: PoolClient) => { void client.query(READ_ONLY_SESSION_SQL).catch(() => {}); });
    }
  }
  return pool;
}
