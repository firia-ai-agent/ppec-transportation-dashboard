import { drizzle } from "drizzle-orm/neon-serverless";
import { getPool, readOnlyPool } from "./pool";
import { isReadOnlyDbEnv } from "./read-only";
import * as schema from "./schema";

/**
 * Drizzle over the one shared pool. On previews it gets the read-only view of that pool, so each
 * query runs in its own read-only transaction and drizzle's own transactions open READ ONLY
 * (DECISION-LEDGER #43). Off previews drizzle gets the pool itself: behaviour is unchanged.
 */
export function getDb() {
  const p = getPool();
  return drizzle(isReadOnlyDbEnv(process.env) ? readOnlyPool(p) : p, { schema });
}
