/**
 * ONE "NEEDS A PERSON" (ledger #80) — the writer, in a leaf module so anything that can be refused
 * (Approve's decision, a card writer, the run loop) can raise it without pulling the agent's
 * vendor plumbing into its graph. `staff-alert.ts` reads these rows back for the screens and
 * re-exports what it always did.
 */
import type { Exec } from "@/db/exec";
import { refusalWords, type Refusal } from "@/modules/changes/refusal";
import { assistantUnavailable } from "@/ui/copy";
import { LIVE_ALERT_STATES_SQL, MODEL_UNAVAILABLE_CATEGORY, sqlEnumList } from "./alert-task";
import { effectId } from "./run/exec/ids";

type AlertSubject = {
  readonly threadId: string;
  readonly childToken: string | null;
  readonly tripLegId: string | null;
};

/**
 * The alert's id, derived from the inbound message it is about.
 *
 * Not from the run and not from the attempt: a run is re-driven on resume and a vendor outage
 * produces many attempts, and all of them are the *same* "this text needs a person". One text,
 * one card, however many times we failed to read it.
 */
export function modelUnavailableAlertId(siteId: string, messageId: string): string {
  return effectId(`assistant-unavailable:${siteId}:${messageId}`, "staff-alert");
}


export type RaisedAlert = { readonly id: string; readonly created: boolean };


/**
 * ONE "NEEDS A PERSON" (ledger #80): whenever the agent took something on and could not finish it,
 * a person hears — the model could not read a family's text, the plan would not take the change a
 * family asked for, or Approve was refused because the board moved. One RED task, one card on
 * Family texts' For you, a line in the bubble, a count on Today; never the agent woken again
 * (`NEVER_A_RUN`).
 *
 * With a refusal it carries the board's own reason, and the van and child it names, so the card
 * says what is in the way and links the one place to fix it (`changes/refusal.ts`). `key` names
 * what could not be done — a message, an approval — so one cause is one card however often it
 * is tried.
 */
export async function raiseNeedsPerson(
  db: Exec,
  input: {
    readonly siteId: string;
    readonly messageId: string | null;
    /** Why: the model-unavailable class (`staff-alert.ts`), or `refused` when the plan said no. */
    readonly reason: string;
    readonly refusal?: Refusal;
    readonly key?: string;
    /** The card it is about, when Approve was refused: deciding that card later answers this one. */
    readonly approvalId?: string;
    readonly by: string;
  },
): Promise<RaisedAlert> {
  const id = input.key
    ? effectId(`needs-person:${input.siteId}:${input.key}`, "staff-alert")
    : modelUnavailableAlertId(input.siteId, input.messageId ?? "");
  const subject = input.messageId ? await alertSubject(db, input.siteId, input.messageId) : null;
  const evidence = {
    locator: {
      message_id: input.messageId,
      thread_id: subject?.threadId ?? null,
      reason_class: input.reason,
      ...(input.approvalId ? { approval_id: input.approvalId } : {}),
      ...(input.refusal ? { van_id: input.refusal.vanId ?? null, date: input.refusal.date, leg: input.refusal.leg } : {}),
    },
    ...(input.refusal ? { refusal: input.refusal } : {}),
  };
  const words = input.refusal ? refusalWords(input.refusal) : null;
  const r = await db.query<{ id: string }>(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       child_token, trip_leg_id, completion_evidence, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, 'RED', 'OPEN', $4, $5, $6, $7, $8, $9::jsonb, $10, $10, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      id,
      input.siteId,
      MODEL_UNAVAILABLE_CATEGORY,
      words?.says ?? assistantUnavailable.task.summary,
      words?.fix.label ?? assistantUnavailable.task.nextStep,
      assistantUnavailable.task.predicate,
      subject?.childToken ?? input.refusal?.childToken ?? null,
      subject?.tripLegId ?? null,
      JSON.stringify(evidence),
      input.by,
    ],
  );
  return { id, created: r.rows.length > 0 };
}


/**
 * Who and which ride, from the rows alone.
 *
 * The contact is the thread's counterparty; the children are the ones that contact is authorized
 * for. Exactly one ⇒ the card can name them. More than one ⇒ null, and the card names the family
 * instead — picking between siblings would mean reading the message, which is the thing this
 * whole change exists to stop.
 *
 * The leg is that child's ride on the message's own service date. Where the day has both, the
 * one still ahead wins: a text that arrives after the morning run is about the afternoon. "Still
 * ahead" is the leg's state, not a clock comparison, because the leg machine is what knows
 * whether a ride has happened (`TERMINAL_LEG_STATES`).
 */
async function alertSubject(db: Exec, siteId: string, messageId: string): Promise<AlertSubject | null> {
  const msg = await db.query<{
    thread_id: string;
    counterparty_token: string | null;
    service_date: string;
    received_at: Date;
  }>(
    `SELECT m.thread_id, t.counterparty_token, m.received_at,
            (m.received_at AT TIME ZONE 'America/New_York')::date::text AS service_date
     FROM ops.message m
     JOIN ops.conversation_thread t ON t.id = m.thread_id AND t.site_id = m.site_id
     WHERE m.id = $1 AND m.site_id = $2`,
    [messageId, siteId],
  );
  const row = msg.rows[0];
  if (!row) return null;

  const children = row.counterparty_token
    ? await db.query<{ child_token: string }>(
        // Any live authorization is enough to say "this contact's child": which *scope* they
        // hold decides what may be sent to them, and nothing is being sent here. The validity
        // window is read against the message's own arrival time, as §6.4 requires everywhere.
        `SELECT DISTINCT child_token FROM ops.contact_authorization
         WHERE site_id = $1 AND contact_token = $2
           AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
         ORDER BY child_token`,
        [siteId, row.counterparty_token, row.received_at],
      )
    : { rows: [] as { child_token: string }[] };

  const childToken = children.rows.length === 1 ? children.rows[0].child_token : null;
  if (childToken === null) return { threadId: row.thread_id, childToken: null, tripLegId: null };

  const legs = await db.query<{ id: string }>(
    `SELECT id FROM ops.trip_leg
     WHERE site_id = $1 AND child_token = $2 AND service_date = $3
     ORDER BY (state IN (${TERMINAL_LEG_STATES_SQL})) ASC, direction ASC
     LIMIT 1`,
    [siteId, childToken, row.service_date],
  );
  return { threadId: row.thread_id, childToken, tripLegId: legs.rows[0]?.id ?? null };
}


/** A ride that has already happened or been called off. Such a leg is not what a text is about. */
const TERMINAL_LEG_STATES = [
  "COMPLETED_HANDOFF",
  "CANCELED_TRANSPORT",
  "CANCELED_ATTENDANCE",
  "NO_SHOW",
  "LEFT_BEHIND_CAPACITY",
] as const;
const TERMINAL_LEG_STATES_SQL = sqlEnumList(TERMINAL_LEG_STATES);

/**
 * The card a refused Approve was about has now been decided (ledger #80): what it was waiting on is
 * fixed, so its "needs a person" card is answered too — inside the decision's own transaction.
 */
export async function answeredByDecision(
  tx: Exec,
  approvalId: string,
  resolve: (tx: Exec, taskId: string) => Promise<void>,
): Promise<void> {
  const open = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM ops.task
      WHERE category = $1 AND state IN (${LIVE_ALERT_STATES_SQL})
        AND completion_evidence -> 'locator' ->> 'approval_id' = $2`,
    [MODEL_UNAVAILABLE_CATEGORY, approvalId],
  );
  for (const row of open.rows) await resolve(tx, row.id);
}
