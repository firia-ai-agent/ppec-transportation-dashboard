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
 * and from the `IdentityGateway` (src/modules/identity/gateway.ts) the same way, through the
 * shared display helpers — never by joining `identity.guardian_contact` here, because `app_rw`
 * has no SELECT on that schema (src/db/schema.ts:104) and the join took the whole "For you" tab
 * down with `permission denied for schema identity`.
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
 * `APPROVAL_ROLES` (src/auth/access.ts), read at the page and at the action; this
 * module takes the site ids a caller is a member of and reads within them. `src/auth/access.ts`
 * is unchanged by this work — director and coordinator already hold that row, and the front desk
 * already does not.
 */
import type { Exec } from "@/db/exec";
import { assistantUnavailable } from "@/ui/copy";
import { childFirstName, guardianShortName } from "@/modules/identity/display-name";
import type { IdentityGateway } from "@/modules/identity/gateway";
import { type DemoDataGuardCode, DATA_MODE_ENV_VAR } from "./config";
import { type GatewayOutcome, GatewayError } from "./gateway";
import { effectId } from "./run/exec/effects";
import { ProviderError } from "./providers/provider";
import {
  RemoteApiKeyMissing,
  RemoteBaseUrlRefused,
  RemoteDemoDataGuardRefused,
  RemoteEndpointRefused,
  RemoteModelRefused,
  RemoteProviderUnavailable,
  RemoteRequestUrlRefused,
} from "./providers/remote";

/**
 * The task row's own three facts — the category, the live states and the UPDATE that marks an
 * alert taken — live in `./alert-task.ts`, which imports nothing but `Exec`, and are re-exported
 * here so callers have one name for each. The split exists because the "For you" tab's server
 * action needs `openAlert` and must not reach a vendor through it; see that file's header.
 */
export {
  LIVE_ALERT_STATES,
  MODEL_UNAVAILABLE_CATEGORY,
  openAlert,
} from "./alert-task";
import { LIVE_ALERT_STATES_SQL, MODEL_UNAVAILABLE_CATEGORY, sqlEnumList } from "./alert-task";

/**
 * Why no model answered, as a stable class.
 *
 * Three groups, and the grouping is what a reader of a log line has to be able to act on:
 *
 *  - **the vendor was reached and failed** — `rate_limited` (429 on every model in the chain),
 *    `timeout` (our own request deadline), `provider_error` (a 500, a dead socket, a body that is
 *    not the shape it claims);
 *  - **we never got as far as calling** — `no_key`, and the three demo-data guard conditions, one
 *    class each so a log line names the condition rather than "configuration";
 *  - **the call was refused on the way out** — `destination_refused`: the endpoint, the base URL,
 *    the built request URL or the model chain was not one this deployment may use. A **stop**,
 *    kept distinct from everything above it (see `Unavailable.stop`).
 *
 * None of them reaches the card. A coordinator's next move is the same for every one of them —
 * read the text and answer the family — so the class lives in the server log and in the task
 * locator, and `ui/copy.ts` has one sentence for all of them.
 */
export type UnavailableReason =
  | "no_key"
  | "key_refused"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "guard_demo_data_only"
  | "guard_data_class"
  | "guard_data_mode"
  | "config_refused"
  | "destination_refused";

/** The three guard conditions, by the `config.DemoDataGuardCode` each one reports. */
const GUARD_REASONS: Readonly<Record<DemoDataGuardCode, UnavailableReason>> = {
  DEMO_DATA_ONLY_UNCONFIRMED: "guard_demo_data_only",
  DATA_CLASS_NOT_SYNTHETIC: "guard_data_class",
  DATA_MODE_NOT_SYNTHETIC: "guard_data_mode",
};

/** What is wrong with each guard var, in the house style: one lowercase clause, and no value. */
const GUARD_DETAIL: Readonly<Record<DemoDataGuardCode, string>> = {
  DEMO_DATA_ONLY_UNCONFIRMED: "not confirmed",
  DATA_CLASS_NOT_SYNTHETIC: "not SYNTHETIC",
  DATA_MODE_NOT_SYNTHETIC: "not SYNTHETIC",
};

/**
 * What a model outage *was*, in the two forms a caller needs.
 *
 * `reason` is the stable class, for the task locator and for a test to assert on. `detail` is the
 * log line's parenthetical, and the only place an env var **name** appears — never a value,
 * because `apiKeyEnvVar` names a secret and "names only" is a rule a reader can check at a glance.
 */
export type Unavailable = {
  readonly reason: UnavailableReason;
  readonly detail: string;
  /**
   * True when this is a **stop** rather than an outage: the key was about to go somewhere this
   * deployment has not vetted, or to a model off the allow-list.
   *
   * It still raises the alert — the family's text needs a person whatever went wrong upstream, and
   * that is the founder's rule of 2026-10-17 — but the run's reason string says "stop", so nobody
   * reads a misrouted key as a flaky vendor and waits for it to clear. Nothing is retried either
   * way: the run fails, here as everywhere else in this file.
   */
  readonly stop: boolean;
};

/**
 * Is this error "the assistant could not reach a model", and if so which kind? `null` otherwise.
 *
 * Six classes answer yes, and the list is deliberately closed:
 *
 *  - `RemoteDemoDataGuardRefused` — one of the three §2.5A conditions does not hold. **This is the
 *    case that put the preview in "couldn't reach its model"**: that deployment has the key and
 *    `APP_DATA_CLASS` but no `AGENT_DEMO_DATA_ONLY`, so the guard's first condition refuses every
 *    call. It is a *wiring-time* refusal, which commit a8dc0f5 had classed as a stop raising no
 *    card — and the founder's rule wins over that: the parent's text is sitting there either way,
 *    so it needs a person either way.
 *  - `RemoteApiKeyMissing` — there is no key to call with. Same reasoning.
 *  - `RemoteProviderUnavailable` — every model in the chain was tried and every one failed.
 *  - `RemoteEndpointRefused`, `RemoteBaseUrlRefused`, `RemoteRequestUrlRefused`,
 *    `RemoteModelRefused` — `destination_refused`, with `stop: true`. `providers/remote.ts` is
 *    right that "a key that nearly went to the wrong host is a stop, not a fallback": nothing
 *    degrades and nothing is retried. But a stop is not a reason to leave a family unanswered, so
 *    it raises the same alert and says `stop` in the run's reason.
 *  - a gateway `PROVIDER_ERROR` whose cause is **not** a `ProviderError` at all: a raw transport
 *    failure from an adapter that does not classify its own errors.
 *
 * Everything else is `null`, and the two groups that matters for are worth naming:
 *
 *  - a plain `ProviderError` from a non-vendor adapter — a scripted provider running out of
 *    responses is a harness condition, and it used to raise a card in suites with nothing to do
 *    with this (`run/exec/clarify.test.ts`, `run/exec/staff.test.ts`);
 *  - every other gateway outcome — a policy block, a prompt leak, a free-text refusal, an
 *    invalid-argument rejection. Those are the agent working correctly and refusing something,
 *    and they have their own tasks (`run/tasks.ts`).
 */
export function modelUnavailable(err: unknown): Unavailable | null {
  // Thrown straight at a caller holding the adapter, with no gateway in between — which is what a
  // *wiring-time* refusal is: `remoteProvider()` throws before a gateway exists at all.
  const direct = fromProviderError(err);
  if (direct) return direct;

  if (!(err instanceof GatewayError)) return null;
  if (err.outcome !== "PROVIDER_ERROR") return GATEWAY_CONFIG_REFUSALS[err.outcome] ?? null;

  const cause = fromProviderError(err.cause);
  if (cause) return cause;
  // A classed provider error that is none of the six is not an outage; see the list above.
  if (err.cause instanceof ProviderError) return null;
  // Anything else got as far as trying and failed in a way nobody classified.
  return { reason: "provider_error", detail: "provider error", stop: false };
}

/**
 * The two gateway outcomes that are "this deployment is not configured to make this call" rather
 * than "the model answered and we refused it" — so no model was reached, and the family's text is
 * still sitting there needing a person.
 *
 * `REJECTED_ATTESTATION` is the one a PHI-mode deployment hits **first**, before the adapter's own
 * demo-data guard ever runs: `dataMode === "PHI"` demands a `vendorAttestation` and a vendor with
 * no BAA cannot produce one (gateway.ts step 2). Without this entry, the third guard condition
 * would raise a card in a test where the provider is handed its own config, and raise nothing on a
 * real deployment where the gateway and the provider share one — which is exactly the kind of gap
 * a passing test hides.
 *
 * `REJECTED_ENDPOINT` is the same fact as `RemoteEndpointRefused` seen one layer up, so it carries
 * the same reason and the same `stop`.
 *
 * Every *other* outcome stays `null` on purpose: a prompt leak, free text, multiple calls, invalid
 * arguments and an unknown tool are all the model having answered and the gateway refusing the
 * answer, and our own rate limits are our own budget. None of those means the assistant could not
 * be reached.
 */
const GATEWAY_CONFIG_REFUSALS: Partial<Record<GatewayOutcome, Unavailable>> = {
  REJECTED_ATTESTATION: {
    reason: "config_refused",
    detail: `config: $${DATA_MODE_ENV_VAR} requires a vendor attestation this vendor cannot give`,
    stop: false,
  },
  REJECTED_ENDPOINT: {
    reason: "destination_refused",
    detail: "destination refused: endpoint not allow-listed",
    stop: true,
  },
};

/** The six adapter errors that mean "no model answered", or null for anything else. */
function fromProviderError(err: unknown): Unavailable | null {
  if (err instanceof RemoteDemoDataGuardRefused) {
    return {
      reason: GUARD_REASONS[err.failure.code],
      detail: `guard: $${err.failure.envVar} ${GUARD_DETAIL[err.failure.code]}`,
      stop: false,
    };
  }
  if (err instanceof RemoteApiKeyMissing) {
    return { reason: "no_key", detail: `missing key: $${err.apiKeyEnvVar}`, stop: false };
  }
  if (err instanceof RemoteProviderUnavailable) return chainUnavailable(err);
  if (err instanceof RemoteEndpointRefused) return destination("endpoint");
  if (err instanceof RemoteBaseUrlRefused) return destination("base URL");
  if (err instanceof RemoteRequestUrlRefused) return destination("request URL");
  if (err instanceof RemoteModelRefused) return destination("model");
  return null;
}

/** A refusal on the way out: which check, and nothing about the value it refused. */
function destination(what: string): Unavailable {
  return { reason: "destination_refused", detail: `destination refused: ${what} not allow-listed`, stop: true };
}

/**
 * Which kind of outage an exhausted chain was, read off the recorded attempts rather than the
 * error's message. "Every model timed out" and "every model 429ed" are the two an on-call would
 * act on differently; a mixed chain is neither, and says so.
 */
function chainUnavailable(err: RemoteProviderUnavailable): Unavailable {
  // Every model said the key is no good (401/403): that is configuration, and waiting will not fix
  // it — `stop`, so a person's run is not parked to try the same key again (ledger #76).
  if (err.attempts.length > 0 && err.attempts.every((a) => a.status === 401 || a.status === 403)) {
    return { reason: "key_refused", detail: "the provider refused the key on every model", stop: true };
  }
  const failures = new Set(err.attempts.map((a) => a.failure));
  if (failures.size === 1) {
    const only = [...failures][0];
    if (only === "timeout") return { reason: "timeout", detail: "timeout", stop: false };
    if (only === "rate_limited") return { reason: "rate_limited", detail: "rate limited on every model", stop: false };
  }
  return { reason: "provider_error", detail: "provider error on every model", stop: false };
}

/**
 * The one line a model outage writes to the server log.
 *
 * Non-secret by construction: a fixed prefix, the reason's own `detail` — a stable phrase plus at
 * most an env var **name** — and the fact that a person was told. It names no key, no env var
 * *value*, no prompt, no family text, no child and no phone number. The things it would be most
 * tempting to add are exactly the things that must never be in a log line about a message we
 * could not read, and `model-unavailable.test.ts` asserts the stub key string appears in no log
 * output at all.
 */
export function modelUnavailableLogLine(u: Unavailable): string {
  return `agent: model unavailable (${u.detail}); staff alert raised`;
}

/** Log it, once, through the same `console` seam the queue routes use. */
export function logModelUnavailable(u: Unavailable): void {
  console.warn(modelUnavailableLogLine(u));
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
  /**
   * The message the card's words came from. Nullable because the join is a LEFT JOIN: every row
   * this module writes carries a locator, and a row that somehow does not should still render as
   * a card a person can see rather than disappear from the board.
   */
  readonly messageId: string | null;
  /** True once a staff member has opened it: the card stays, marked as taken. */
  readonly beingHandled: boolean;
};

type AlertRow = {
  id: string;
  state: string;
  message_id: string | null;
  thread_id: string | null;
  body_tokenized: string | null;
  child_display_name: string | null;
  /** The thread's counterparty. A *name* for it is the gateway's answer, not this query's. */
  counterparty_token: string | null;
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
export async function openAssistantAlerts(
  db: Exec, siteIds: readonly string[], gateway: IdentityGateway,
): Promise<AssistantAlert[]> {
  if (siteIds.length === 0) return [];
  const r = await db.query<AlertRow>(
    `SELECT t.id, t.state,
            m.id AS message_id, m.thread_id, m.body_tokenized,
            c.display_name AS child_display_name,
            th.counterparty_token,
            l.direction::text AS leg_direction
     FROM ops.task t
     LEFT JOIN ops.message m
       ON m.id = (t.completion_evidence -> 'locator' ->> 'message_id')::uuid AND m.site_id = t.site_id
     LEFT JOIN ops.conversation_thread th ON th.id = m.thread_id AND th.site_id = t.site_id
     LEFT JOIN ops.child_profile c ON c.child_token = t.child_token AND c.site_id = t.site_id
     LEFT JOIN ops.trip_leg l ON l.id = t.trip_leg_id AND l.site_id = t.site_id
     WHERE t.site_id = ANY($1::uuid[])
       AND t.category = $2
       AND t.state IN (${LIVE_ALERT_STATES_SQL})
     ORDER BY t.created_at, t.id`,
    [siteIds, MODEL_UNAVAILABLE_CATEGORY],
  );
  /*
   * One gateway call for the whole page, not one per card: the names are asked for in a batch
   * after the ops read, so a tab with six alerts on it is still two round trips.
   */
  const names = await gateway.namesForContacts(
    r.rows.map((row) => row.counterparty_token).filter((t): t is string => t !== null),
  );
  return r.rows.map((row) => toAlert(row, names));
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
 * One row as one card. The sentence is filled here rather than in the component so that the copy,
 * the display helpers and the fallback for a family whose text names no single child are decided
 * once, server-side, and asserted in one test.
 */
function toAlert(row: AlertRow, names: ReadonlyMap<string, string>): AssistantAlert {
  /*
   * A name the gateway did not have is "" and `assistantUnavailable.card` renders without it,
   * which is `display-name.ts`'s fail-soft rule: a card that cannot name the adult is a smaller
   * harm than a tab that throws (and than a made-up name).
   */
  const adult = guardianShortName(row.counterparty_token === null ? null : names.get(row.counterparty_token) ?? null);
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
    messageId: row.message_id ?? null,
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

/** One message of the thread an alert points at, as the thread panel shows it. */
export type AlertThreadMessage = {
  readonly id: string;
  readonly at: string;
  /** The family's words, from `ops.message.body_tokenized`. Never a paraphrase. */
  readonly body: string;
};

/**
 * The family's side of one thread, oldest first, for the panel behind "Open text".
 *
 * Inbound only. An alert exists precisely because nothing was sent in reply, so there is no
 * outbound half worth rendering here — and rendering one would mean re-rendering outbound
 * templates, which is `messaging/mailbox.ts`'s job and not this card's.
 *
 * Site-scoped on the caller's own memberships, like every other read in this file: a thread id
 * from another tenant returns nothing rather than "forbidden", because a 403 on an id is an
 * existence oracle.
 */
export async function alertThreadMessages(
  db: Exec,
  a: { threadId: string; siteIds: readonly string[] },
): Promise<AlertThreadMessage[]> {
  if (a.siteIds.length === 0) return [];
  const r = await db.query<{ id: string; received_at: Date; body_tokenized: string }>(
    `SELECT id, received_at, body_tokenized
     FROM ops.message
     WHERE thread_id = $1 AND site_id = ANY($2::uuid[]) AND direction = 'IN' AND is_own_echo = false
     ORDER BY received_at, id`,
    [a.threadId, a.siteIds],
  );
  return r.rows.map((m) => ({ id: m.id, at: new Date(m.received_at).toISOString(), body: m.body_tokenized }));
}
