import { autocommitQuery, getPool } from "./pool";
import { beginSql } from "./read-only";
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
 */
export function getNeonDb(): Db {
  const p = getPool();
  return {
    query: <R,>(sql: string, params: unknown[]) => autocommitQuery<R>(p, sql, params),
    async tx(fn) {
      const c = await p.connect();
      const hooks: (() => Promise<void>)[] = [];
      try {
        await c.query(beginSql(process.env));
        const r = await fn({ query: async (sql, params) => ({ rows: (await c.query(sql, params)).rows }) }, (h) => hooks.push(h));
        await c.query("COMMIT");
        await runAfterCommit(hooks);
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
