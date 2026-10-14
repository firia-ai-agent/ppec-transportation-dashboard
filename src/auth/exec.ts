import type { Exec } from "@/domain/transition";
import { autocommitQuery, getPool } from "@/db/pool";

/**
 * Raw-SQL executor over the shared pool, for auth lookups. On previews each query runs inside its own
 * read-only transaction (DECISION-LEDGER #43); elsewhere it is a plain pool.query.
 */
export function getExec(): Exec {
  const p = getPool();
  return { query: <R,>(sql: string, params: unknown[]) => autocommitQuery<R>(p, sql, params) };
}
