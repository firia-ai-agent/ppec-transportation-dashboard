import { Pool } from "@neondatabase/serverless";
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

let pool: Pool | undefined;
/** Neon WebSocket Pool (ADR-009: Pool for transactions). Never logs the URL. */
export function getNeonDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new Pool({ connectionString: url });
  const p = pool;
  return {
    query: async (sql, params) => ({ rows: (await p.query(sql, params)).rows }),
    async tx(fn) {
      const c = await p.connect();
      const hooks: (() => Promise<void>)[] = [];
      try {
        await c.query("BEGIN");
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
