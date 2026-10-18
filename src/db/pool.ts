import { neonConfig, Pool } from "@neondatabase/serverless";
import { isReadOnlyDbEnv, readOnlyGuard, rewriteBeginReadOnly, type SqlLike } from "./read-only";

let pool: Pool | undefined;
/**
 * One shared Neon WebSocket Pool per server instance (pooled DATABASE_URL, ADR-009). Never logs the URL.
 * The pool is plain: no connection-level state is configured or set here, ever. Previews share the one
 * production role, database and endpoint behind PgBouncer (DECISION-LEDGER #43), so anything left on a
 * server backend would leak into production's next query — read-only is per transaction instead, via
 * `readOnlyQuery`/`autocommitQuery`/`readOnlyPool` below and `txGuardForEnv` in src/db/exec.ts.
 */
export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    /*
     * A local throwaway Postgres speaks TCP. The Neon driver only speaks WebSocket, so the
     * browser check that seeds one (e2e/health-tab-data.spec.ts) points this at its own proxy.
     * Unset everywhere else, including every deployment: the driver keeps its Neon defaults.
     */
    const proxy = process.env.LOCAL_PG_WS_PROXY;
    if (proxy) {
      neonConfig.wsProxy = proxy;
      neonConfig.useSecureWebSocket = false;
      neonConfig.pipelineConnect = false;
    }
    pool = new Pool({ connectionString: url });
  }
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
 *
 * The transaction is the guard's (`readOnlyGuard`): its BEGIN and its COMMIT/ROLLBACK never travel
 * through the path the caller's statement takes, so a caller-sent COMMIT is refused rather than
 * mistaken for ours. The caller's statement is checked once more before any client is checked out, so
 * anything that could escape the transaction we are about to open — its own BEGIN, a `SET … READ WRITE`,
 * a COMMIT/ROLLBACK/END/ABORT, a multi-statement string — costs no connection at all.
 */
export async function readOnlyQuery<R = Record<string, unknown>>(
  p: PoolLike, sql: SqlLike, params?: unknown[],
): Promise<{ rows: R[] }> {
  rewriteBeginReadOnly(sql, { inTransaction: true });
  const c = await p.connect();
  const g = readOnlyGuard((q, ps) => c.query(q, ps));
  try {
    await g.begin();
    const r = await g.query(sql, params);
    await g.commit();
    return { rows: r.rows as R[] };
  } catch (e) {
    await g.rollback().catch(() => {});
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
 * `begin`, or `begin <modes>` when a caller asked for one — opens READ ONLY whichever it sends.
 * Nothing is set on the connection, so a released client is clean.
 *
 * The checked-out client is wrapped in a `readOnlyGuard`, so the guard owns the transaction for as long
 * as the client is out: the `commit`/`rollback` drizzle (or any caller) sends afterwards is refused, not
 * forwarded, and the transaction is closed here on release() instead. Were a caller's COMMIT honoured,
 * everything it sent next would run in autocommit — writable, against the one production database.
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
    const g = readOnlyGuard((q, ps) => c.query(q, ps));
    // A wrapper, not a patched client: the real client returns to the pool untouched on release().
    return {
      query: (sql: SqlLike, params?: unknown[]) => g.query(sql, params),
      release: () => {
        // The ROLLBACK is queued on this client before it goes back to the pool, so the backend is
        // never handed on with the guard's transaction still open on it.
        void g.rollback().catch(() => {});
        c.release();
      },
    };
  }) as unknown as Pool["connect"];
  return ro;
}
