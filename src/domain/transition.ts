import { canTransition, type Actor, type Machine } from "./machines";

/** Minimal SQL executor so the same code runs on Neon, node-postgres or PGlite. */
export interface Exec {
  query<R = Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: R[] }>;
}

export class IllegalTransition extends Error {}
export class StaleOrConflict extends Error {}

const IDENT = /^[a-z_]+\.[a-z_]+$/;

/**
 * Guarded, optimistic transition (schema convention): rejects illegal edges in code, then
 * UPDATE ... WHERE id=$ AND version=$ AND state=$from. 0 rows ⇒ someone else moved it first.
 */
export async function transition<T extends string>(
  db: Exec, m: Machine<T>, table: string,
  args: { id: string; version: number; from: T; to: T; actor: Actor; by: string; priorState?: T | null },
): Promise<{ version: number }> {
  if (!IDENT.test(table)) throw new Error("bad table name");
  if (!canTransition(m, args.from, args.to, args.actor, { priorState: args.priorState })) {
    throw new IllegalTransition(`${m.name}: ${args.from} -> ${args.to} not allowed for ${args.actor}`);
  }
  const r = await db.query<{ version: number }>(
    `UPDATE ${table} SET state = $1, version = version + 1, updated_at = now(), updated_by = $2
     WHERE id = $3 AND version = $4 AND state = $5 RETURNING version`,
    [args.to, args.by, args.id, args.version, args.from],
  );
  if (r.rows.length !== 1) throw new StaleOrConflict(`${m.name} ${args.id}: stale version or state`);
  return { version: r.rows[0].version };
}
