import { Pool } from "@neondatabase/serverless";
import { BEGIN_READ_ONLY, isReadOnlyDbEnv, rewriteBeginReadOnly, type SqlLike } from "./read-only";

let pool: Pool | undefined;
/**
 * One shared Neon WebSocket Pool per server instance (pooled DATABASE_URL, ADR-009). Never logs the URL.
 * The pool is plain: no connection-level state is configured or set here, ever. Previews share the one
 * production role, database and endpoint behind PgBouncer (DECISION-LEDGER #43), so anything left on a
 * server backend would leak into production's next query — read-only is per transaction instead, via
 * `readOnlyQuery`/`autocommitQuery`/`readOnlyPool` below and `beginSql` in src/db/exec.ts.
 */
export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!pool) pool = new Pool({ connectionString: url });
  return pool;
}

/** The slice of a pg/Neon Pool the helpers below need, so they can be driven by a fake in tests. */
export interface PoolLike {
  query(sql: SqlLike, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<ClientLike>;
}
/** The slice of a checked-out pool client the helpers below need. */
export interface ClientLike {
  query(sql: SqlLike, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/**
 * Run one statement inside its own read-only transaction, on its own checked-out client, and release it.
 * The client goes back to the pool with no state on it: READ ONLY ended with the COMMIT.
 */
export async function readOnlyQuery<R = Record<string, unknown>>(
  p: PoolLike, sql: SqlLike, params?: unknown[],
): Promise<{ rows: R[] }> {
  const c = await p.connect();
  try {
    await c.query(BEGIN_READ_ONLY);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return { rows: r.rows as R[] };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * An autocommit application query: straight to `pool.query` everywhere, except on previews, where it
 * becomes its own `BEGIN READ ONLY … COMMIT`. Off previews nothing extra is sent and no client is pinned.
 */
export async function autocommitQuery<R = Record<string, unknown>>(
  p: PoolLike, sql: SqlLike, params?: unknown[],
): Promise<{ rows: R[] }> {
  if (isReadOnlyDbEnv(process.env)) return readOnlyQuery<R>(p, sql, params);
  return { rows: (await p.query(sql, params)).rows as R[] };
}

/**
 * Preview-only view of the pool for the drizzle client: autocommit queries each get their own
 * `BEGIN READ ONLY … COMMIT`, and a drizzle transaction — which checks a client out and sends a bare
 * `begin` — opens READ ONLY instead. Nothing is set on the connection, so a released client is clean.
 *
 * It is `Object.create(p)` and not an object literal on purpose: drizzle's neon-serverless session only
 * checks a client out when `client instanceof Pool`, and would otherwise push BEGIN/COMMIT through
 * `query()` as separate autocommit statements. Only `query` and `connect` are overridden; every other
 * member still resolves to the real pool through the prototype chain.
 */
export function readOnlyPool(p: Pool): Pool {
  const ro: Pool = Object.create(p) as Pool;
  ro.query = ((sql: SqlLike, params?: unknown[]) => readOnlyQuery(p, sql, params)) as Pool["query"];
  ro.connect = (async () => {
    const c = await p.connect();
    // A wrapper, not a patched client: the real client returns to the pool untouched on release().
    return {
      query: (sql: SqlLike, params?: unknown[]) => c.query(rewriteBeginReadOnly(sql), params),
      release: () => c.release(),
    };
  }) as unknown as Pool["connect"];
  return ro;
}
