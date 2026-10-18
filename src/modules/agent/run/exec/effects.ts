/**
 * What every slice-3 executor needs, and none of them should re-invent.
 *
 * Slice 2 left the executor registry recording *intent*: one row per call, no state change, no
 * send. Slice 3 fills the §11.2 "Precondition → effect" column in, and the two contracts
 * `run/executors.ts` states for a real executor are what this file is for:
 *
 *  - **Idempotent on the call's idempotency key.** A crash between the persist and the effect
 *    leaves a PENDING row whose effect may or may not have happened, and the loop's only safe
 *    answer is to re-drive it with the same key. So every row an executor writes gets an id
 *    *derived* from that key (`effectId`) and is inserted `ON CONFLICT (id) DO NOTHING`, and every
 *    outbound message is enqueued under the key itself (`ops.outbound_message.idempotency_key` is
 *    unique). A state change needs none of this: `transition()` is version-guarded, so the second
 *    attempt finds the version already moved and says so.
 *  - **Only `promptFacts` may reach the next prompt.** Executors here return tokens, codes, counts
 *    and versions — never a row, never a body, never a contact.
 *
 * Nothing in this directory chooses a recipient, writes a message body or decides a policy: the
 * recipients come from `ops.contact_authorization` at enqueue time and are re-checked per contact
 * by the outbox at send time, the copy is an outbox template, and the call only runs at all because
 * `policy.evaluate` returned ALLOW (loop.ts).
 */
import type { Db, Exec } from "@/db/exec";
import { identityGateway, type IdentityGateway } from "@/modules/identity/gateway";
import type { JobScheduler } from "@/modules/jobs/scheduler";
import type { OutboxTransport } from "@/modules/outbox/outbox";
import { sha256Hex } from "../../redact";
import type { ToolExecution } from "../executors";
import { runActor, type CommittedCall } from "../store";

/**
 * Who mints a single-use dispatcher link (ADR 5.6, §11.2 `request_provider_capability`: "signed
 * dispatcher link").
 *
 * Only the **hash** comes back, because that is all `ops.dispatcher_link.token_hash` holds and all
 * ops is allowed to hold: the token itself is the signer's to deliver, exactly as a phone number is
 * the identity gateway's. It has to be deterministic in `linkId` for the same reason every other
 * effect here is keyed on the call's idempotency key — a re-driven call recomputes the same hash,
 * so the insert is a no-op instead of a second live link.
 *
 * There is **no implementation in P1**: the link page and its signing key are a later milestone, so
 * a deployment configures none and the executor records the link as an intent rather than inventing
 * a token (`exec/capability.ts`). Supplying one is what turns the intent into a row.
 */
export type DispatcherLinkSigner = {
  sign(a: { linkId: string; siteId: string; expiresAt: Date }): Promise<{ tokenHash: string }>;
};

/** What the live executors are built over. One instance per server process (or per test). */
export type ExecutorDeps = {
  readonly db: Db;
  /** B-03. Used to cancel an acknowledgment's deadline when the ack arrives. */
  readonly scheduler: JobScheduler;
  /** The outbox's wake-up transport: `enqueue` publishes on it after commit (ADR-003). */
  readonly transport: OutboxTransport;
  /** Optional, and absent in P1 — see `DispatcherLinkSigner`. */
  readonly linkSigner?: DispatcherLinkSigner;
  /**
   * THE AGENT'S ONE DOOR TO `identity` (S1-6; Firia's ruling 2, 2026-10-18 2:48 AM ET).
   *
   * Two steps of the run need a fact that lives behind the restricted schema — `read_message`
   * resolving who texted (`reads.ts`) and `record_provider_capability` checking a report really
   * came from that van's dispatcher (`capability.ts`) — and both used to ask `deps.db`, which is
   * the application connection and has no SELECT there (src/db/schema.ts:104).
   *
   * Optional, defaulting to this data class's own gateway, so every existing construction of these
   * deps is unchanged and a suite can still hand the deployed gateway over a connection that may
   * run its SQL.
   */
  readonly gateway?: IdentityGateway;
};

/** The gateway these deps were given, or this data class's own (ADR-015). */
export const gatewayOf = (deps: ExecutorDeps): IdentityGateway => deps.gateway ?? identityGateway();

/**
 * The id of a row this call writes, derived from the call's idempotency key rather than freshly
 * generated, so re-driving an interrupted call computes the *same* id and `ON CONFLICT (id) DO
 * NOTHING` is the no-op the resume contract needs. `suffix` separates two rows written by one call
 * (a change request and the exception that points at it).
 *
 * The value is a syntactically valid UUID (version 8, "custom") because that is what the columns
 * are; it is deliberately *not* a uuidv7, since a time-ordered id could not be recomputed.
 */
export function effectId(idempotencyKey: string, suffix = ""): string {
  const h = sha256Hex(`${idempotencyKey}#${suffix}`);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this argument the shape of an id this database holds? The tool schemas take an opaque `token`
 * (wide enough for a fixture key like "C1"), the policy engine has already refused any token
 * outside the run's scope, and every id column here is `uuid` — so a token that is not a uuid
 * cannot name a row, and sending it to Postgres anyway would be an error rather than a miss.
 * Treated as "no such object", in the same words as an id that exists in another tenant (there is
 * no existence oracle in a tool result either).
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** `created_by` / `updated_by` for every row an executor writes. */
export const actor = runActor;

/* ───────────────────────────── results ───────────────────────────── */

/**
 * A step that could not complete. The loop records it and fails the run shut — a run that stopped
 * is cheap to restart, and an executor that guessed would not be.
 *
 * `error_code` is a code on purpose: it is what the next engineer greps for, what the prompt would
 * carry if the run were resumed, and the one thing a §11.2 log may hold about a refusal.
 */
export function failed(code: string, data: Record<string, unknown> = {}): ToolExecution {
  return { status: "failed", data: { error_code: code, ...data }, promptFacts: { error_code: code } };
}

/** No row of that id in this site. 404 rather than 403, as everywhere else (policy.ts step 7). */
export const notFound = (what: string): ToolExecution => failed("NOT_FOUND", { object: what });

/**
 * The §11.2 failure column of a version-guarded write: `expected_version` did not hold, so nothing
 * was written. 412 is the API's answer to the same condition (PRD §12 `If-Match: <version>`), and
 * `canceled_stale` is what a message about the state we thought we had becomes.
 */
export const versionConflict = (data: Record<string, unknown> = {}): ToolExecution =>
  failed("VERSION_CONFLICT", { http_status: 412, outcome: "canceled_stale", ...data });

/* ───────────────────────────── reading the run back ───────────────────────────── */

/**
 * The prompt facts of the newest committed, executed call of `tool` in this run — the only thing
 * one step may learn from an earlier one.
 *
 * This is how a write gets its *authority* rather than taking the model's word for it: the cancel
 * executor reads `resolve_sender`'s candidate count out of here before it will transition a leg
 * (machines.ts `agentRequiresVerifiedGuardian`), and the follow-up reads which leg this run
 * actually touched. A fact is in there only because an executor declared it, so nothing the model
 * said can reach this path.
 */
export function factsOf(
  committed: readonly CommittedCall[],
  tool: string,
): Readonly<Record<string, string | number | boolean>> | null {
  for (let i = committed.length - 1; i >= 0; i -= 1) {
    const c = committed[i];
    if (c.tool === tool && c.status === "EXECUTED") return c.promptFacts;
  }
  return null;
}

/** A fact of this run as a string, or null when the step that would have set it did not run. */
export function factString(
  committed: readonly CommittedCall[],
  tool: string,
  key: string,
): string | null {
  const v = factsOf(committed, tool)?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/* ───────────────────────────── small shared reads ───────────────────────────── */

/** The site's own id for a thread, with the counterparty the clarification would go back to. */
export type ThreadRow = {
  readonly id: string;
  readonly state: string;
  readonly counterparty_token: string | null;
  readonly family_group_id: string | null;
  readonly channel: string;
};

export async function threadRow(db: Exec, a: { siteId: string; threadId: string }): Promise<ThreadRow | null> {
  if (!isUuid(a.threadId)) return null;
  const r = await db.query<ThreadRow>(
    `SELECT id, state, counterparty_token, family_group_id, channel FROM ops.conversation_thread
     WHERE id = $1 AND site_id = $2`,
    [a.threadId, a.siteId],
  );
  return r.rows[0] ?? null;
}

/** The leg, as both the read tool and the writers need it. `service_date` is text, never a Date. */
export type LegRow = {
  readonly id: string;
  readonly child_token: string;
  readonly service_date: string;
  readonly direction: "AM" | "PM";
  readonly mode: string;
  readonly state: string;
  readonly version: number;
  readonly plan_version: number;
};

const LEG_COLUMNS =
  `id, child_token, to_char(service_date, 'YYYY-MM-DD') AS service_date, direction, mode, state, version, plan_version`;

export async function legRow(db: Exec, a: { siteId: string; legId: string }): Promise<LegRow | null> {
  if (!isUuid(a.legId)) return null;
  const r = await db.query<LegRow>(
    `SELECT ${LEG_COLUMNS} FROM ops.trip_leg WHERE id = $1 AND site_id = $2`,
    [a.legId, a.siteId],
  );
  return r.rows[0] ?? null;
}

/** One child's legs on one service date, AM first. */
export async function legsOfDay(
  db: Exec,
  a: { siteId: string; childToken: string; serviceDate: string },
): Promise<LegRow[]> {
  const r = await db.query<LegRow>(
    `SELECT ${LEG_COLUMNS} FROM ops.trip_leg WHERE site_id = $1 AND child_token = $2 AND service_date = $3
     ORDER BY direction`,
    [a.siteId, a.childToken, a.serviceDate],
  );
  return r.rows;
}

export type AttendanceRow = { readonly id: string; readonly state: string; readonly version: number };

export async function attendanceRow(
  db: Exec,
  a: { siteId: string; childToken: string; serviceDate: string },
): Promise<AttendanceRow | null> {
  const r = await db.query<AttendanceRow>(
    `SELECT id, state, version FROM ops.attendance_day
     WHERE site_id = $1 AND child_token = $2 AND service_date = $3`,
    [a.siteId, a.childToken, a.serviceDate],
  );
  return r.rows[0] ?? null;
}

/* ───────────────────────────── shared writers ───────────────────────────── */

/** One staff task, idempotent on the id the caller derived from the call's key. */
export async function raiseTask(
  db: Exec,
  a: {
    id: string;
    siteId: string;
    category: string;
    severity: "GREEN" | "AMBER" | "RED";
    words: { summary: string; nextStep: string; predicate: string };
    by: string;
    tripLegId?: string | null;
    childToken?: string | null;
    /**
     * `completion_evidence` — the machine-readable detail on the row, as
     * `{ locator: { … } }`, which is the shape `staff-alert.raiseModelUnavailableAlert` already
     * writes and `openAssistantAlerts` already reads. It is where a *class* goes: a reason code,
     * a message id, a thread id. Never a sentence a person reads (that is `words`), and never a
     * value out of a provider error — those name endpoints, models and, in the worst case,
     * headers (see `ask/staff-ask.ts`, which is this parameter's first caller).
     */
    evidence?: Record<string, unknown> | null;
  },
): Promise<string> {
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       trip_leg_id, child_token, completion_evidence, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7, $8, $9, $10::jsonb, $11, $11, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      a.id, a.siteId, a.category, a.severity,
      a.words.summary, a.words.nextStep, a.words.predicate,
      a.tripLegId ?? null, a.childToken ?? null,
      a.evidence ? JSON.stringify(a.evidence) : null, a.by,
    ],
  );
  return a.id;
}
