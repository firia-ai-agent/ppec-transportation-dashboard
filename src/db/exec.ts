import { autocommitQuery, getPool } from "./pool";
import { txGuardForEnv } from "./read-only";
import type { Exec } from "@/domain/transition";

export type { Exec };
/** Exec plus a transaction runner. Post-commit hooks run only after COMMIT succeeds. */
export interface Db extends Exec {
  tx<T>(fn: (tx: Exec, afterCommit: (hook: () => Promise<void>) => void) => Promise<T>): Promise<T>;
}

export async function runAfterCommit(hooks: (() => Promise<void>)[]) {
  for (const h of hooks) {
    try { await h(); } catch { /* lost wake-ups are recovered by the sweeper (ADR-001) */ }
  }
}

/**
 * Db over the one shared Neon WebSocket Pool (src/db/pool.ts; ADR-009: Pool for transactions).
 * On previews every transaction opens READ ONLY and every autocommit query becomes its own read-only
 * transaction (DECISION-LEDGER #43); off previews this is a plain BEGIN and a plain pool.query.
 *
 * The transaction itself belongs to the guard (`txGuardForEnv`), which hands the callback only its
 * `query`: on a preview every statement the callback sends is rewritten or refused, and anything that
 * would escape the open transaction — a `SET … READ WRITE`, a nested BEGIN, a COMMIT/ROLLBACK/END/ABORT,
 * a multi-statement string — is refused before it is sent, so the READ ONLY transaction the callback is
 * running in cannot be closed from inside it. The BEGIN and COMMIT below are the guard's own and take a
 * different path, which is why a caller spelling out `COMMIT` is distinguishable from ours at all.
 * Off previews the guard is a pass-through: every statement, the framing included, is sent exactly as
 * it is written here and in the callback.
 */
export function getNeonDb(): Db {
  const p = getPool();
  return {
    query: <R,>(sql: string, params: unknown[]) => autocommitQuery<R>(p, sql, params),
    async tx(fn) {
      const c = await p.connect();
      const g = txGuardForEnv(process.env, (q, ps) => c.query(q, ps));
      const hooks: (() => Promise<void>)[] = [];
      try {
        await g.begin();
        const tx: Exec = {
          query: async <R,>(sql: string, params: unknown[]) =>
            ({ rows: (await g.query(sql, params)).rows as R[] }),
        };
        const r = await fn(tx, (h) => hooks.push(h));
        await g.commit();
        await runAfterCommit(hooks);
        return r;
      } catch (e) {
        await g.rollback().catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
