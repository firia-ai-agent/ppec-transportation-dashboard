/**
 * Transactional outbox (ADR-003, PRD §6.3 outbound machine).
 * - enqueue(): the row is written in the caller's tx with the domain change; the wake-up is published after commit.
 * - drain(): guarded QUEUED→SENDING claim, after send-time rechecks (stale plan / not_after → CANCELED_STALE;
 *   suppression / recipient authorization → BLOCKED_EGRESS). The provider call happens outside any tx.
 * - A provider timeout, or a crash while SENDING, ends in UNKNOWN. UNKNOWN is never resent.
 * - sweepOutbox() drains rows whose wake-up was lost and moves stuck SENDING / silent SENT rows to UNKNOWN.
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";
import { canTransition, OUTBOUND } from "@/domain/machines";
import { IllegalTransition, StaleOrConflict } from "@/domain/transition";
import { activeSuppression, childAuthorized, recipientKind, therapistAuthorized, type RecipientAuthorizer } from "./policy";
import { ProviderRejected, ProviderTimeout, type MessagingProvider } from "./provider";

export const OUTBOX_TOPIC = "ppec-outbox";
export const SEND_TIMEOUT_MS = 10_000;
/** SENDING longer than this means the drainer died mid-send: UNKNOWN, never resend. */
export const STUCK_SENDING_SECONDS = 120;
/** SENT with no status callback after this long: UNKNOWN (PRD l.754). */
export const STATUS_CALLBACK_WINDOW_SECONDS = 30 * 60;
/** QUEUED rows older than this with no drain are picked up by the sweeper (lost wake-up). */
export const SWEEP_GRACE_SECONDS = 5;

export type OutboxState =
  | "DRAFTED" | "POLICY_CHECKED" | "QUEUED" | "BLOCKED_EGRESS" | "SENDING" | "SENT" | "DELIVERED"
  | "UNDELIVERED" | "FAILED" | "UNKNOWN" | "REDACTED" | "CANCELED_STALE";

export interface OutboxTransport { publish(msg: { messageId: string }, opts: { idempotencyKey: string }): Promise<void> }

export type EnqueueInput = {
  siteId: string; purpose: string; recipientRule: string; recipientToken: string; channel: "SMS_1TO1" | "MMS_GROUP" | "TEAMS" | "VOICE_TASK" | "DISPATCHER_LINK";
  templateId: string; vars: Record<string, unknown>; tripLegId?: string | null; therapySessionId?: string | null;
  /** Required when the message carries child data (child template, child-ish vars, a trip leg or a therapy session). */
  childToken?: string | null;
  planVersionBasis: number; notAfter: Date; idempotencyKey: string; by: string;
};

type Row = {
  id: string; site_id: string; purpose: string; recipient_token: string | null; channel: string; template_id: string;
  vars: Record<string, unknown>; trip_leg_id: string | null; therapy_session_id: string | null; child_token: string | null;
  recipient_rule: string; plan_version_basis: number; not_after: Date | string;
  state: OutboxState; version: number; idempotency_key: string;
};
const COLS = "id, site_id, purpose, recipient_token, recipient_rule, channel, template_id, vars, trip_leg_id, therapy_session_id, child_token, plan_version_basis, not_after, state, version, idempotency_key";

/** Templates whose text names or describes a child. Any message using one must carry a child reference. */
export const CHILD_TEMPLATES = new Set(["pickup.eta", "dropoff.eta", "leg.canceled", "leg.changed", "therapist.absence_alert", "therapist.late_alert", "child.not_received"]);
/**
 * Per-template allowlist of permitted var names (Veri #8 follow-up). Any template not listed, or any var not on its
 * list, is rejected at enqueue and blocked at send. Child-data vars appear only on CHILD_TEMPLATES.
 */
export const TEMPLATE_VARS: Readonly<Record<string, ReadonlySet<string>>> = {
  "pickup.eta": new Set(["childFirstName", "eta", "stopLabel"]),
  "dropoff.eta": new Set(["childFirstName", "eta", "stopLabel"]),
  "leg.canceled": new Set(["childFirstName", "legDate", "reason"]),
  "leg.changed": new Set(["childFirstName", "legDate", "eta", "stopLabel"]),
  "therapist.absence_alert": new Set(["childFirstName", "sessionStart"]),
  "therapist.late_alert": new Set(["childFirstName", "sessionStart", "eta"]),
  "child.not_received": new Set(["childFirstName", "stopLabel", "eta"]),
  "center.closure": new Set(["date", "reason"]),
  "generic.notice": new Set(["text"]),
};

export class TemplateVarNotAllowed extends Error {}

/** Names of vars the template does not permit (all of them if the template is unknown). */
export function disallowedVars(templateId: string, vars: Record<string, unknown> | null | undefined): string[] {
  const allow = TEMPLATE_VARS[templateId];
  return Object.keys(vars ?? {}).filter((k) => !allow?.has(k));
}

export class ChildReferenceRequired extends Error {}

/** Veri #8: child data never rides without a child reference, and the reference must agree with the leg/session. */
export async function assertChildReference(tx: Exec, m: EnqueueInput) {
  if (!TEMPLATE_VARS[m.templateId]) throw new TemplateVarNotAllowed(`unknown template ${m.templateId}`);
  const bad = disallowedVars(m.templateId, m.vars);
  if (bad.length) throw new TemplateVarNotAllowed(`vars not permitted for template ${m.templateId}: ${bad.join(",")}`);
  const needs = CHILD_TEMPLATES.has(m.templateId) || !!m.tripLegId || !!m.therapySessionId;
  if (needs && !m.childToken) {
    throw new ChildReferenceRequired(`child reference required (template ${m.templateId}${m.tripLegId ? ", trip leg" : ""}${m.therapySessionId ? ", therapy session" : ""})`);
  }
  if (m.tripLegId) {
    const r = await tx.query<{ child_token: string }>("SELECT child_token FROM ops.trip_leg WHERE id = $1 AND site_id = $2", [m.tripLegId, m.siteId]);
    if (r.rows[0]?.child_token !== m.childToken) throw new ChildReferenceRequired("trip leg belongs to a different child or site");
  }
  if (m.therapySessionId) {
    const r = await tx.query<{ child_token: string }>("SELECT child_token FROM ops.therapy_session WHERE id = $1 AND site_id = $2", [m.therapySessionId, m.siteId]);
    if (r.rows[0]?.child_token !== m.childToken) throw new ChildReferenceRequired("therapy session belongs to a different child or site");
  }
}

/** Guarded move along the outbound machine (actor Y = system). Extra columns are set in the same UPDATE. */
async function move(tx: Exec, row: Pick<Row, "id" | "version" | "state">, to: OutboxState, by: string, extra: Record<string, unknown> = {}) {
  if (!canTransition(OUTBOUND, row.state, to, "Y")) throw new IllegalTransition(`outbound_message: ${row.state} -> ${to}`);
  const keys = Object.keys(extra);
  const sets = keys.map((k, i) => `${k} = $${i + 6}`).join(", ");
  const r = await tx.query<{ version: number }>(
    `UPDATE ops.outbound_message SET state = $1, version = version + 1, updated_at = now(), updated_by = $2${sets ? ", " + sets : ""}
     WHERE id = $3 AND version = $4 AND state = $5 RETURNING version`,
    [to, by, row.id, row.version, row.state, ...keys.map((k) => extra[k])]);
  if (r.rows.length !== 1) throw new StaleOrConflict(`outbound_message ${row.id}: stale`);
  return { ...row, state: to, version: r.rows[0].version };
}

/**
 * Write the message in the caller's transaction (DRAFTED → POLICY_CHECKED → QUEUED; the B-08 policy engine
 * runs before this call). Same idempotency key twice returns the existing row and publishes nothing new.
 */
export async function enqueue(tx: Exec, afterCommit: (h: () => Promise<void>) => void, transport: OutboxTransport, m: EnqueueInput) {
  await assertChildReference(tx, m);
  const id = uuidv7();
  const ins = await tx.query<{ id: string; version: number }>(
    `INSERT INTO ops.outbound_message (id, site_id, purpose, recipient_rule, recipient_token, channel, template_id, vars,
       trip_leg_id, therapy_session_id, plan_version_basis, not_after, idempotency_key, created_by, updated_by, child_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$14,$15)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, version`,
    [id, m.siteId, m.purpose, m.recipientRule, m.recipientToken, m.channel, m.templateId, JSON.stringify(m.vars),
      m.tripLegId ?? null, m.therapySessionId ?? null, m.planVersionBasis, m.notAfter.toISOString(), m.idempotencyKey, m.by, m.childToken ?? null]);
  if (!ins.rows.length) {
    const ex = await tx.query<{ id: string }>("SELECT id FROM ops.outbound_message WHERE idempotency_key = $1", [m.idempotencyKey]);
    return { id: ex.rows[0].id, duplicate: true };
  }
  let row = { id, version: ins.rows[0].version, state: "DRAFTED" as OutboxState };
  row = await move(tx, row, "POLICY_CHECKED", m.by);
  await move(tx, row, "QUEUED", m.by);
  afterCommit(() => transport.publish({ messageId: id }, { idempotencyKey: `outbox:${id}` }));
  return { id, duplicate: false };
}

export type DrainDeps = { provider: MessagingProvider; authorizer: RecipientAuthorizer; clock?: () => Date; timeoutMs?: number };
export type DrainResult = "SENT" | "UNKNOWN" | "FAILED" | "CANCELED_STALE" | "BLOCKED_EGRESS" | "noop";

/** Recheck and claim one QUEUED message, then send it. Safe to call any number of times, from queue or sweeper. */
export async function drain(db: Db, messageId: string, deps: DrainDeps, by = "system:outbox"): Promise<DrainResult> {
  const now = (deps.clock ?? (() => new Date()))();
  // Recipient authorization goes through the IdentityGateway (a separate connection in deployed envs), so it runs
  // before the ops tx. The result is applied only if the row is unchanged when the claim runs.
  const pre = await db.query<{ site_id: string; recipient_token: string | null; purpose: string; channel: string; recipient_rule: string; version: number }>(
    "SELECT site_id, recipient_token, purpose, channel, recipient_rule, version FROM ops.outbound_message WHERE id = $1 AND state = 'QUEUED'", [messageId]);
  if (!pre.rows[0]) return "noop";
  const p0 = pre.rows[0];
  const auth = p0.recipient_token
    ? await deps.authorizer.authorize({ siteId: p0.site_id, recipientToken: p0.recipient_token, purpose: p0.purpose, channel: p0.channel, at: now, kind: await recipientKind(db, { siteId: p0.site_id, recipientToken: p0.recipient_token }) })
    : ({ ok: false, reason: "no recipient token" } as const);
  const claimed = await db.tx(async (tx) => {
    const r = await tx.query<Row>(`SELECT ${COLS} FROM ops.outbound_message WHERE id = $1 AND state = 'QUEUED'
      AND (next_attempt_at IS NULL OR next_attempt_at <= $2) FOR UPDATE SKIP LOCKED`, [messageId, now.toISOString()]);
    const row = r.rows[0];
    if (!row || row.version !== p0.version) return null; // changed since the pre-read: a later drain/sweep retries

    // Send-time rechecks (ADR-003, PRD §10). Order: staleness first, then egress policy.
    if (new Date(row.not_after) <= now) { await move(tx, row, "CANCELED_STALE", by, { block_reason: "not_after passed" }); return "CANCELED_STALE" as const; }
    if (row.trip_leg_id) {
      const leg = await tx.query<{ plan_version: number }>("SELECT plan_version FROM ops.trip_leg WHERE id = $1", [row.trip_leg_id]);
      if (leg.rows[0]?.plan_version !== row.plan_version_basis) {
        await move(tx, row, "CANCELED_STALE", by, { block_reason: `plan_version ${leg.rows[0]?.plan_version} != basis ${row.plan_version_basis}` });
        return "CANCELED_STALE" as const;
      }
    }
    if (!row.recipient_token) { await move(tx, row, "BLOCKED_EGRESS", by, { block_reason: "no recipient token" }); return "BLOCKED_EGRESS" as const; }
    const sup = await activeSuppression(tx, { siteId: row.site_id, recipientToken: row.recipient_token, purpose: row.purpose });
    if (sup) { await move(tx, row, "BLOCKED_EGRESS", by, { block_reason: `suppressed (${sup})` }); return "BLOCKED_EGRESS" as const; }
    if (!TEMPLATE_VARS[row.template_id] || disallowedVars(row.template_id, row.vars).length) {
      // Defence in depth for rows written around the enqueue guard: only allowlisted vars ever go out.
      await move(tx, row, "BLOCKED_EGRESS", by, { block_reason: `vars not permitted for template ${row.template_id}` }); return "BLOCKED_EGRESS" as const;
    }
    if (row.child_token) {
      // Guardianship / therapist assignment can change after queueing: re-check the recipient against the child now.
      const ok = (await recipientKind(tx, { siteId: row.site_id, recipientToken: row.recipient_token })) === "therapist"
        ? await therapistAuthorized(tx, { siteId: row.site_id, personToken: row.recipient_token, childToken: row.child_token, therapySessionId: row.therapy_session_id })
        : await childAuthorized(tx, { siteId: row.site_id, recipientToken: row.recipient_token, childToken: row.child_token, channel: row.channel, purpose: row.purpose, at: now });
      if (!ok) { await move(tx, row, "BLOCKED_EGRESS", by, { block_reason: "recipient not authorized for this child at send time" }); return "BLOCKED_EGRESS" as const; }
    } else if (row.trip_leg_id || row.therapy_session_id || CHILD_TEMPLATES.has(row.template_id)) {
      // Defence in depth for rows written before the enqueue guard: child data with no child reference never goes out.
      await move(tx, row, "BLOCKED_EGRESS", by, { block_reason: "child data without a child reference" }); return "BLOCKED_EGRESS" as const;
    }
    if (!auth.ok) { await move(tx, row, "BLOCKED_EGRESS", by, { block_reason: auth.reason }); return "BLOCKED_EGRESS" as const; }

    const sending = await move(tx, row, "SENDING", by, { attempts: 1 });
    return { ...row, ...sending };
  });
  if (claimed === null) return "noop";
  if (typeof claimed === "string") return claimed;

  // Outside any tx: one provider call, bounded by a timeout.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? SEND_TIMEOUT_MS);
  let outcome: { to: "SENT"; providerMessageId: string } | { to: "UNKNOWN" | "FAILED"; reason: string };
  try {
    const res = await deps.provider.send({
      messageId: claimed.id, siteId: claimed.site_id, idempotencyKey: claimed.idempotency_key, channel: claimed.channel,
      recipientToken: claimed.recipient_token!, templateId: claimed.template_id, vars: claimed.vars,
    }, { signal: ctl.signal });
    outcome = { to: "SENT", providerMessageId: res.providerMessageId };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 280);
    // DECISION-LEDGER (Firia 2026-10-14): a definite rejection is FAILED; a timeout or ambiguous error is UNKNOWN
    // (resolved by provider lookup or a staff exit, never resent).
    outcome = e instanceof ProviderRejected && !ctl.signal.aborted
      ? { to: "FAILED", reason: `provider rejected: ${msg}` }
      : e instanceof ProviderTimeout || ctl.signal.aborted
        ? { to: "UNKNOWN", reason: "provider timeout" }
        : { to: "UNKNOWN", reason: `ambiguous provider error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
  const extra = outcome.to === "SENT" ? { provider_message_id: outcome.providerMessageId } : { block_reason: outcome.reason };
  try {
    await move(db, { id: claimed.id, version: claimed.version, state: "SENDING" }, outcome.to, by, extra);
  } catch (e) {
    if (!(e instanceof StaleOrConflict)) throw e; // the sweeper already moved it to UNKNOWN; leave it
  }
  return outcome.to;
}

export type OutboxSweepReport = { drained: number; stuckToUnknown: number; silentToUnknown: number };

/** Called from /api/cron/sweep. Never resends anything that reached SENDING. */
export async function sweepOutbox(db: Db, deps: DrainDeps, by = "system:sweeper"): Promise<OutboxSweepReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const rep: OutboxSweepReport = { drained: 0, stuckToUnknown: 0, silentToUnknown: 0 };
  const toUnknown = async (state: "SENDING" | "SENT", olderThanSecs: number, reason: string) => {
    const rows = await db.query<Pick<Row, "id" | "version" | "state">>(
      `SELECT id, version, state FROM ops.outbound_message WHERE state = $1 AND updated_at < $2::timestamptz - make_interval(secs => $3) LIMIT 500`,
      [state, now.toISOString(), olderThanSecs]);
    let n = 0;
    for (const r of rows.rows) {
      try { await move(db, r, "UNKNOWN", by, { block_reason: reason }); n++; } catch (e) { if (!(e instanceof StaleOrConflict)) throw e; }
    }
    return n;
  };
  rep.stuckToUnknown = await toUnknown("SENDING", STUCK_SENDING_SECONDS, "send outcome unknown (drainer stopped mid-send)");
  rep.silentToUnknown = await toUnknown("SENT", STATUS_CALLBACK_WINDOW_SECONDS, "no status callback in time");

  const queued = await db.query<{ id: string }>(
    `SELECT id FROM ops.outbound_message WHERE state = 'QUEUED' AND updated_at < $1::timestamptz - make_interval(secs => $2)
       AND (next_attempt_at IS NULL OR next_attempt_at <= $1) ORDER BY created_at LIMIT 200`, [now.toISOString(), SWEEP_GRACE_SECONDS]);
  for (const q of queued.rows) if ((await drain(db, q.id, deps, by)) !== "noop") rep.drained++;
  return rep;
}

/** Staff exit from UNKNOWN (DECISION-LEDGER, Firia 2026-10-14): staff record what they confirmed out of band. */
export async function resolveUnknownByStaff(db: Exec, a: { id: string; to: "DELIVERED" | "FAILED"; staffUserId: string; note: string }) {
  const r = await db.query<{ version: number }>("SELECT version FROM ops.outbound_message WHERE id = $1 AND state = 'UNKNOWN'", [a.id]);
  if (!r.rows[0]) throw new StaleOrConflict(`outbound_message ${a.id}: not UNKNOWN`);
  if (!canTransition(OUTBOUND, "UNKNOWN", a.to, "S")) throw new IllegalTransition(`outbound_message: UNKNOWN -> ${a.to} for S`);
  const u = await db.query<{ version: number }>(
    `UPDATE ops.outbound_message SET state = $1, version = version + 1, updated_at = now(), updated_by = $2, block_reason = $3
     WHERE id = $4 AND version = $5 AND state = 'UNKNOWN' RETURNING version`,
    [a.to, `staff:${a.staffUserId}`, `staff resolved: ${a.note.slice(0, 200)}`, a.id, r.rows[0].version]);
  if (!u.rows.length) throw new StaleOrConflict(`outbound_message ${a.id}: stale`);
}
