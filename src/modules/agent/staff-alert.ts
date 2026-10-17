/**
 * "Needs a person": what happens when the assistant cannot reach a model at all.
 *
 * ## The rule
 *
 * Founder, 2026-10-17 5:28 PM ET, overriding PRD §18.1 l.1200 ("LLM down → keyword parser"):
 *
 *   "Never compensate with a deterministic text parser if the model isn't available; the
 *    owner/staff need to be notified."
 *
 * So the degraded path is not a smaller agent. It is **no agent and one alert**. A run whose
 * model is unavailable makes no proposal, changes no ride, queues nothing and sends nothing; it
 * writes one row that puts the family's text in front of a coordinator and says "reply yourself".
 * `providers/keyword.ts`, which used to answer here, is deleted, and
 * `no-keyword-fallback.test.ts` is what keeps it deleted.
 *
 * ## Storage: no schema change (migration 0009 is frozen)
 *
 * The alert is an `ops.task` row and nothing else — there is no new table and no new store, in
 * memory or otherwise:
 *
 *  | column | value |
 *  |---|---|
 *  | `category` | `ASSISTANT_UNAVAILABLE` |
 *  | `severity` | `RED` — §3's "needs action now" |
 *  | `state` | `OPEN`, then `IN_PROGRESS` when a staff member opens it (`openAlert`) |
 *  | `child_token`, `trip_leg_id` | who and which ride, when the rows say so unambiguously |
 *  | `summary` / `next_step` / `completion_predicate` | `ui/copy.assistantUnavailable.task` |
 *  | `completion_evidence -> 'locator'` | `{message_id, thread_id, reason_class}` |
 *
 * `locator` is a **pointer**, which is the whole PHI design here: the family's words stay in
 * `ops.message.body_tokenized` and are read back at display time (`openAssistantAlerts`), never
 * copied into the task row, the summary or a log line. `ops.message` is the row the retention
 * window and the tokenizer already apply to; a second copy of a family's sentence in `ops.task`
 * would be outside both. The names on the card are read from `ops.child_profile.display_name`
 * and `identity.guardian_contact.legal_name` the same way, through the shared display helpers.
 *
 * (`completion_evidence` is also the column the `task_closed_needs_evidence` check reads. Writing
 * a locator into it means a row of this category can reach `CLOSED_VERIFIED` without the check
 * stopping it. That is a known, named trade-off of carrying the pointer with no schema change;
 * the alternative is migration 0010, which is frozen.)
 *
 * ## One alert, not one per attempt
 *
 * The id is derived from the **message**, not from the run or the attempt
 * (`modelUnavailableAlertId`), and the insert is `ON CONFLICT DO NOTHING`. A redelivered webhook,
 * a resumed run and a second driver all land on the same row, so a vendor that is down for an
 * hour produces one card per family text rather than one per retry.
 *
 * ## Roles
 *
 * There are none in this file. Who may see or act on an alert is the access table's answer for
 * `/exceptions` (`approvals/decide.approvalRoles`), read at the page and at the action; this
 * module takes the site ids a caller is a member of and reads within them. `src/auth/access.ts`
 * is unchanged by this work — director and coordinator already hold that row, and the front desk
 * already does not.
 */
import type { Exec } from "@/db/exec";
import { assistantUnavailable } from "@/ui/copy";
import { childFirstName, guardianShortName } from "@/modules/identity/display-name";
import { GatewayError } from "./gateway";
import { effectId } from "./run/exec/effects";
import { ProviderError } from "./providers/provider";
import {
  RemoteApiKeyMissing,
  RemoteProviderUnavailable,
} from "./providers/remote";

/** `ops.task.category` for a model this deployment could not reach. */
export const MODEL_UNAVAILABLE_CATEGORY = "ASSISTANT_UNAVAILABLE";

/** The states an alert is still a person's work in. Closed ones leave the board. */
export const LIVE_ALERT_STATES = ["OPEN", "IN_PROGRESS"] as const;

/**
 * The same list as a SQL literal.
 *
 * Inlined rather than bound as a parameter because the driver has to be told the element type of
 * an enum array and `$n::task_state[]` does not survive the round trip through every backend this
 * runs on. Safe to inline precisely because these are module constants declared one line above —
 * no caller supplies them, so there is no value here that did not come from this file.
 */
const sqlEnumList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
const LIVE_ALERT_STATES_SQL = sqlEnumList(LIVE_ALERT_STATES);

/**
 * Why no model answered, as a class.
 *
 * Four of them because four are actionable and distinguishable, and no more because the vendor's
 * own words are not something we store: `no_key` is a deployment that has not been given a key,
 * `rate_limited` is a 429 on every model in the chain, `timeout` is our own request deadline, and
 * `provider_error` is everything else a vendor can do (a 500, a dead socket, a body that is not
 * the shape it claims). The class goes in the server log and in the task locator. None of them
 * reaches the card: a coordinator's next move is the same for all four.
 */
export type UnavailableReason = "no_key" | "rate_limited" | "timeout" | "provider_error";

/**
 * Is this error "the model is unavailable", and if so which kind? `null` for anything else.
 *
 * Deliberately narrow. A policy block, a prompt leak, a free-text refusal and an invalid-argument
 * rejection are all the agent working correctly and refusing something, and none of them is a
 * reason to tell a coordinator their assistant is down — they have their own tasks
 * (`run/tasks.ts`). Only a `PROVIDER_ERROR` from the gateway, or an adapter error thrown before a
 * gateway existed, is this.
 */
export function modelUnavailableReason(err: unknown): UnavailableReason | null {
  const inner =
    err instanceof GatewayError
      ? err.outcome === "PROVIDER_ERROR"
        ? (err.cause ?? err)
        : null
      : err instanceof ProviderError
        ? err
        : null;
  if (inner === null) return null;

  // A key that was never set. Checked first: it is the one case with no attempt behind it, and
  // the one whose fix is a deployment setting rather than waiting for a vendor.
  if (inner instanceof RemoteApiKeyMissing) return "no_key";

  if (inner instanceof RemoteProviderUnavailable && inner.attempts.length > 0) {
    // Read off the recorded attempts rather than the message. "Every model timed out" and "every
    // model 429ed" are the two a coordinator's on-call would act on differently; a mixed chain is
    // neither, and says so.
    const failures = new Set(inner.attempts.map((a) => a.failure));
    if (failures.size === 1) {
      const only = [...failures][0];
      if (only === "timeout") return "timeout";
      if (only === "rate_limited") return "rate_limited";
    }
  }
  return "provider_error";
}

/**
 * The one line a model outage writes to the server log.
 *
 * Non-secret by construction: a fixed prefix, one of four reason classes, and the fact that a
 * person was told. It names no key, no env var *value*, no prompt, no family text, no child and
 * no phone number — the things it would be most tempting to add are exactly the things that must
 * never be in a log line about a message we could not read.
 */
export function modelUnavailableLogLine(reason: UnavailableReason): string {
  return `agent: model unavailable (${reason}); staff alert raised`;
}

/** Log it, once, through the same `console` seam the queue routes use. */
export function logModelUnavailable(reason: UnavailableReason): void {
  console.warn(modelUnavailableLogLine(reason));
}

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

export type RaiseAlertInput = {
  readonly siteId: string;
  /** The inbound `ops.message` this run was triggered by. The card's text is read from it. */
  readonly messageId: string;
  readonly reason: UnavailableReason;
  /** `created_by` / `updated_by`. The run's actor, so the row says which run could not run. */
  readonly by: string;
};

export type RaisedAlert = { readonly id: string; readonly created: boolean };

/**
 * Write the one alert, and nothing else.
 *
 * What this function does **not** do is the point of it: no `ops.approval_request`, no
 * `ops.change_request`, no `ops.outbound_message`, no transition on a leg. It inserts one
 * `ops.task` and resolves. Everything a family would have received is simply not produced,
 * because nothing read their message.
 *
 * The child and the leg are resolved from **rows**, never from the family's words: the child is
 * the one the texting contact is authorized for (and is left null when they are authorized for
 * more than one, because choosing between them would need the text read), and the leg is that
 * child's ride on the day the message arrived. Both are decoration on the card — the alert is
 * raised whether or not either resolves.
 */
export async function raiseModelUnavailableAlert(db: Exec, input: RaiseAlertInput): Promise<RaisedAlert> {
  const id = modelUnavailableAlertId(input.siteId, input.messageId);
  const subject = await alertSubject(db, input.siteId, input.messageId);
  const locator = {
    locator: {
      message_id: input.messageId,
      thread_id: subject?.threadId ?? null,
      reason_class: input.reason,
    },
  };

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
      assistantUnavailable.task.summary,
      assistantUnavailable.task.nextStep,
      assistantUnavailable.task.predicate,
      subject?.childToken ?? null,
      subject?.tripLegId ?? null,
      JSON.stringify(locator),
      input.by,
    ],
  );
  return { id, created: r.rows.length > 0 };
}

type AlertSubject = {
  readonly threadId: string;
  readonly childToken: string | null;
  readonly tripLegId: string | null;
};

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

/** One alert, as the Exceptions board shows it. Every field is read from a row at display time. */
export type AssistantAlert = {
  readonly id: string;
  readonly state: "OPEN" | "IN_PROGRESS";
  /** The whole card sentence, names already filled in. */
  readonly sentence: string;
  /** The family's own words, verbatim from `ops.message`. Never summarized, never paraphrased. */
  readonly theirWords: string;
  /** The thread "Open text" and "Reply" lead to. */
  readonly threadId: string | null;
  readonly messageId: string;
  /** True once a staff member has opened it: the card stays, marked as taken. */
  readonly beingHandled: boolean;
};

type AlertRow = {
  id: string;
  state: string;
  message_id: string;
  thread_id: string | null;
  body_tokenized: string | null;
  child_display_name: string | null;
  guardian_legal_name: string | null;
  leg_direction: string | null;
};

/**
 * The live alerts at the sites this caller belongs to, oldest first.
 *
 * Scoped by `siteIds` and by nothing else — the caller has already been through the page guard,
 * and the site list is their memberships, so another tenant's alert is not "forbidden" here, it
 * is simply not selected. Both `OPEN` and `IN_PROGRESS`: opening an alert marks it taken, it does
 * not make it disappear, because the thing it is about — a family waiting for an answer — has not
 * happened yet.
 */
export async function openAssistantAlerts(db: Exec, siteIds: readonly string[]): Promise<AssistantAlert[]> {
  if (siteIds.length === 0) return [];
  const r = await db.query<AlertRow>(
    `SELECT t.id, t.state,
            m.id AS message_id, m.thread_id, m.body_tokenized,
            c.display_name AS child_display_name,
            g.legal_name   AS guardian_legal_name,
            l.direction::text AS leg_direction
     FROM ops.task t
     LEFT JOIN ops.message m
       ON m.id = (t.completion_evidence -> 'locator' ->> 'message_id')::uuid AND m.site_id = t.site_id
     LEFT JOIN ops.conversation_thread th ON th.id = m.thread_id AND th.site_id = t.site_id
     LEFT JOIN ops.child_profile c ON c.child_token = t.child_token AND c.site_id = t.site_id
     LEFT JOIN identity.guardian_contact g
       ON g.contact_token = th.counterparty_token AND g.site_id = t.site_id
     LEFT JOIN ops.trip_leg l ON l.id = t.trip_leg_id AND l.site_id = t.site_id
     WHERE t.site_id = ANY($1::uuid[])
       AND t.category = $2
       AND t.state IN (${LIVE_ALERT_STATES_SQL})
     ORDER BY t.created_at, t.id`,
    [siteIds, MODEL_UNAVAILABLE_CATEGORY],
  );
  return r.rows.map(toAlert);
}

/** How many alerts are waiting. The number the rail's badge shows, and the only thing it shows. */
export async function assistantAlertCount(db: Exec, siteIds: readonly string[]): Promise<number> {
  if (siteIds.length === 0) return 0;
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ops.task
     WHERE site_id = ANY($1::uuid[]) AND category = $2 AND state IN (${LIVE_ALERT_STATES_SQL})`,
    [siteIds, MODEL_UNAVAILABLE_CATEGORY],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * A staff member opened this alert: mark it taken, and say whether that was this call.
 *
 * `OPEN → IN_PROGRESS`, guarded on both the state and the site, so two coordinators opening the
 * same card do not both think they are the one handling it, and an id from another tenant updates
 * nothing. It does **not** close the alert: only answering the family does that, and this code
 * cannot know when that happened.
 */
export async function openAlert(
  db: Exec,
  a: { id: string; siteIds: readonly string[]; by: string },
): Promise<{ readonly claimed: boolean }> {
  if (a.siteIds.length === 0) return { claimed: false };
  const r = await db.query<{ id: string }>(
    `UPDATE ops.task SET state = 'IN_PROGRESS', updated_by = $3, updated_at = now()
     WHERE id = $1 AND site_id = ANY($2::uuid[]) AND category = $4 AND state = 'OPEN'
     RETURNING id`,
    [a.id, a.siteIds, a.by, MODEL_UNAVAILABLE_CATEGORY],
  );
  return { claimed: r.rows.length > 0 };
}

/**
 * One row as one card. The sentence is filled here rather than in the component so that the copy,
 * the display helpers and the fallback for a family whose text names no single child are decided
 * once, server-side, and asserted in one test.
 */
function toAlert(row: AlertRow): AssistantAlert {
  const adult = guardianShortName(row.guardian_legal_name);
  const child = childFirstName(row.child_display_name);
  const leg =
    row.leg_direction === "AM" || row.leg_direction === "PM"
      ? assistantUnavailable.legWord[row.leg_direction]
      : assistantUnavailable.legWordUnknown;

  return {
    id: row.id,
    state: row.state === "IN_PROGRESS" ? "IN_PROGRESS" : "OPEN",
    sentence:
      child === ""
        ? fillCard(assistantUnavailable.cardNoChild, { adult })
        : fillCard(assistantUnavailable.card, { adult, child, leg }),
    theirWords: row.body_tokenized ?? "",
    threadId: row.thread_id,
    messageId: row.message_id,
    beingHandled: row.state === "IN_PROGRESS",
  };
}

/**
 * `ui/copy.fill` with one difference: an unknown adult leaves a gap rather than a `{adult}`.
 *
 * A guardian row that has gone (revoked, or a thread with no counterparty) must not print a
 * placeholder at a coordinator. The sentence degrades to "Someone texted about Noah's drop-off",
 * which is still true and still actionable, and the words for it are in `copy.ts` like the rest.
 */
function fillCard(template: string, values: Record<string, string>): string {
  const filled: Record<string, string> = {
    ...values,
    adult: values.adult === "" ? assistantUnavailable.unknownAdult : values.adult,
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => filled[key] ?? whole);
}
