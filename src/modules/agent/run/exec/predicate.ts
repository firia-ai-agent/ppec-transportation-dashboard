/**
 * `ops.task.completion_predicate`, read by a machine.
 *
 * §11.2 `close_task(task_id, evidence_ref)` is "evidence satisfies completion predicate; else stays
 * open", and that is only checkable if the predicate says what evidence would satisfy it. Task
 * predicates in this system are of two kinds, and the difference is deliberate:
 *
 *  - **prose** ("call logged confirming the family's choice") — what staff write for each other,
 *    and what `ui/copy.ts` holds for the tasks the agent raises *for* staff. A predicate the agent
 *    cannot read is a predicate the agent may not close: `checkPredicate` returns
 *    `PREDICATE_NOT_MACHINE_READABLE` and the task stays open until a person closes it. That is the
 *    fail-shut default, and it is why no amount of prose matching happens here — guessing whether a
 *    sentence has come true is exactly the judgement a staff task exists to ask for.
 *  - **coded** (`kind:STATE`, e.g. `message:IN`, `outbound:SENT|DELIVERED`) — what the agent writes
 *    on the tasks it raises for *itself*: the 15-minute clarification wait is satisfied by an
 *    inbound message in this site, a therapist ack wait by that acknowledgment reaching
 *    ACKNOWLEDGED. Five kinds, each a table whose state column the evidence is read against.
 *
 * The evidence is always a row id, never a description, and it is read back from the database at
 * close time — so "evidence" means a thing that happened, not a claim that it did.
 */
import type { Exec } from "@/db/exec";
import { isUuid } from "./effects";

/** The §11.1 clarification / awaited-reply predicate: the family (or provider) replied. */
export const PREDICATE_INBOUND_REPLY = "message:IN";
/** An awaited send actually left. */
export const PREDICATE_MESSAGE_SENT = "outbound:SENT|DELIVERED";
/** An awaited acknowledgment came back. */
export const PREDICATE_ACK_CLOSED = "ack:ACKNOWLEDGED|DECLINED";

/** `kind` → the table and the column the evidence's state is read from. */
const EVIDENCE_SOURCES: Readonly<Record<string, { table: string; column: string }>> = {
  // A message's "state" is its direction: IN is a reply, OUT is something we sent.
  message: { table: "ops.message", column: "direction" },
  outbound: { table: "ops.outbound_message", column: "state" },
  ack: { table: "ops.acknowledgment", column: "state" },
  leg: { table: "ops.trip_leg", column: "state" },
  attendance: { table: "ops.attendance_day", column: "state" },
};

export const PREDICATE_KINDS: readonly string[] = Object.keys(EVIDENCE_SOURCES);

/** `kind:STATE` or `kind:STATE|STATE`. Anything else is prose, and prose is a human's to judge. */
const CODED = /^([a-z_]+):([A-Z_]+(?:\|[A-Z_]+)*)$/;

export type ParsedPredicate = { readonly kind: string; readonly states: readonly string[] };

/** The predicate as a machine reads it, or null when it is prose. */
export function parsePredicate(predicate: string): ParsedPredicate | null {
  const m = CODED.exec(predicate.trim());
  if (!m || !Object.hasOwn(EVIDENCE_SOURCES, m[1])) return null;
  return { kind: m[1], states: m[2].split("|") };
}

export type PredicateResult = {
  readonly satisfied: boolean;
  /** Why, as a code. The task's own words are what a human reads; this is for the run's record. */
  readonly reasonCode: string;
  /** What was found, when something was: the kind and the state the evidence is actually in. */
  readonly evidence?: { readonly kind: string; readonly state: string };
};

/**
 * Does `evidenceRef` satisfy `predicate`, here and now? One read of one row in this site: the
 * evidence has to exist, belong to this site, and be in one of the states the predicate names.
 */
export async function checkPredicate(
  db: Exec,
  a: { siteId: string; predicate: string; evidenceRef: string },
): Promise<PredicateResult> {
  const parsed = parsePredicate(a.predicate);
  if (!parsed) return { satisfied: false, reasonCode: "PREDICATE_NOT_MACHINE_READABLE" };
  if (!isUuid(a.evidenceRef)) return { satisfied: false, reasonCode: "EVIDENCE_NOT_AN_ID" };

  const source = EVIDENCE_SOURCES[parsed.kind];
  // The table and column come from the table above, never from the predicate text, so nothing a
  // task's predicate says can name an identifier of its own.
  const r = await db.query<{ state: string }>(
    `SELECT ${source.column} AS state FROM ${source.table} WHERE id = $1 AND site_id = $2`,
    [a.evidenceRef, a.siteId],
  );
  const row = r.rows[0];
  if (!row) return { satisfied: false, reasonCode: "EVIDENCE_NOT_FOUND" };
  const satisfied = parsed.states.includes(row.state);
  return {
    satisfied,
    reasonCode: satisfied ? "SATISFIED" : "EVIDENCE_DOES_NOT_SATISFY",
    evidence: { kind: parsed.kind, state: row.state },
  };
}
