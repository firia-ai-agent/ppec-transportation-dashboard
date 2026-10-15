/**
 * The operational state a B-08 slice-3 run acts on, seeded for tests: one synthetic family with a
 * guardian contact, one or two children, each child's AM and PM leg on one service date, the
 * thread the family texted into and the message that triggers the run. Test-only, like
 * `src/test/messaging.ts`, and built on it so there is one definition of "a synthetic family".
 *
 * Two things here are not conveniences:
 *  - every id is a **real uuid**, because the executors write to uuid columns. The slice-1/2 suites
 *    use fixture tokens ("C1", "L-C1-AM") and keep working; a run that touches state cannot.
 *  - `scope` is built from those ids the way a session would build it (policy.familyScope), never
 *    from a tool argument, so a test that drives the loop is scope-checked exactly like production.
 */
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { phoneHmac, tokenizeBody } from "@/modules/identity/phone";
import { type FamilyScope, familyScope } from "@/modules/agent/policy";
import { serviceDateIso } from "@/ui/service-date";
import { F1_NUMBER, PEPPER, seedPersona } from "./messaging";
import { SITE } from "./pglite";

export type ScenarioLegs = { readonly AM: string; readonly PM: string };

export type AgentScenario = {
  readonly siteId: string;
  readonly serviceDate: string;
  readonly receivedAt: Date;
  readonly number: string;
  readonly contactToken: string;
  readonly familyGroupId: string;
  /** Children this contact is authorized for, in token order — two of them makes the sibling case. */
  readonly children: readonly string[];
  readonly legs: Readonly<Record<string, ScenarioLegs>>;
  readonly threadId: string;
  readonly messageId: string;
  readonly scope: FamilyScope;
};

export type ScenarioOptions = {
  /** How many children the contact is authorized for. 2 is the AT-06 shared-number case. */
  readonly children?: number;
  readonly receivedAt?: Date;
  readonly body?: string;
  readonly siteId?: string;
  readonly number?: string;
  /** Leave the thread in another state (PAUSED_HUMAN / CLOSED) to test the "thread ACTIVE" rule. */
  readonly threadState?: "OPEN" | "PAUSED_HUMAN" | "CLOSED";
};

/** The whole scenario, in one transaction-free sequence of inserts. */
export async function seedAgentScenario(db: Db, opts: ScenarioOptions = {}): Promise<AgentScenario> {
  const siteId = opts.siteId ?? SITE;
  const number = opts.number ?? F1_NUMBER;
  const receivedAt = opts.receivedAt ?? new Date("2026-10-15T12:00:00.000Z");
  const serviceDate = serviceDateIso(receivedAt);
  const persona = await seedPersona(db, number, { siteId });
  const children = [persona.childToken];

  for (let i = 1; i < (opts.children ?? 1); i += 1) {
    const childToken = uuidv7();
    await db.query(
      `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
       VALUES ($1, $2, $3, 'Syn S.', 'test', 'test')`,
      [childToken, siteId, persona.familyGroupId],
    );
    await db.query(
      `INSERT INTO ops.contact_authorization (id, site_id, contact_token, child_token, scope, channel, valid_from, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'RECEIVE_TRANSPORT_UPDATES', 'SMS_1TO1', now() - interval '1 day', 'test', 'test')`,
      [uuidv7(), siteId, persona.contactToken, childToken],
    );
    children.push(childToken);
  }
  children.sort();

  const legs: Record<string, ScenarioLegs> = {};
  for (const childToken of children) {
    await db.query(
      `INSERT INTO ops.attendance_day (id, site_id, child_token, service_date, state, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'SCHEDULED', 'test', 'test')`,
      [uuidv7(), siteId, childToken, serviceDate],
    );
    const pair: Record<string, string> = {};
    for (const direction of ["AM", "PM"]) {
      const id = uuidv7();
      await db.query(
        `INSERT INTO ops.trip_leg (id, site_id, child_token, service_date, direction, mode, state, plan_version, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 'PROVIDER', 'SCHEDULED', 1, 'test', 'test')`,
        [id, siteId, childToken, serviceDate, direction],
      );
      pair[direction] = id;
    }
    legs[childToken] = { AM: pair.AM, PM: pair.PM };
  }

  const threadId = uuidv7();
  await db.query(
    `INSERT INTO ops.conversation_thread (id, site_id, family_group_id, counterparty_token, channel, state, last_activity_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'SMS_1TO1', $5, $6, 'test', 'test')`,
    [threadId, siteId, persona.familyGroupId, persona.contactToken, opts.threadState ?? "OPEN", receivedAt.toISOString()],
  );
  const messageId = await seedInbound(db, {
    siteId,
    threadId,
    fromHmac: phoneHmac(number, PEPPER),
    body: opts.body ?? "wont need the AM van, dropping at 9:30",
    receivedAt,
  });

  const legTokens = children.flatMap((c) => [legs[c].AM, legs[c].PM]);
  return {
    siteId,
    serviceDate,
    receivedAt,
    number,
    contactToken: persona.contactToken,
    familyGroupId: persona.familyGroupId,
    children,
    legs,
    threadId,
    messageId,
    scope: familyScope(
      persona.familyGroupId,
      [...children, ...legTokens, threadId, messageId, persona.contactToken],
      [],
      siteId,
    ),
  };
}

/** A therapist and one session for a child on a service date — the `THERAPIST_OF_SESSION` audience. */
export async function seedTherapySession(
  db: Db,
  a: { siteId: string; childToken: string; startsAt: Date; endsAt?: Date },
): Promise<{ therapistId: string; personToken: string; sessionId: string }> {
  const therapistId = uuidv7();
  const personToken = uuidv7();
  await db.query(
    `INSERT INTO ops.therapist (id, site_id, person_token, display_name, created_by, updated_by)
     VALUES ($1,$2,$3,'Syn T.','test','test')`,
    [therapistId, a.siteId, personToken],
  );
  const sessionId = uuidv7();
  await db.query(
    `INSERT INTO ops.therapy_session (id, site_id, therapist_id, child_token, starts_at, ends_at, status, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,'SCHEDULED','test','test')`,
    [sessionId, a.siteId, therapistId, a.childToken, a.startsAt.toISOString(),
      (a.endsAt ?? new Date(a.startsAt.getTime() + 45 * 60_000)).toISOString()],
  );
  return { therapistId, personToken, sessionId };
}

/** A second contact authorized for the same child: PRD §10.3's two-guardian case. */
export async function seedSecondGuardian(
  db: Db,
  a: { siteId: string; familyGroupId: string; childToken: string; number: string; pepper?: string },
): Promise<string> {
  const contactToken = uuidv7();
  await db.query(
    `INSERT INTO identity.guardian_contact (contact_token,site_id,family_group_id,legal_name,phone_hmac,phone_enc,relationship,
       can_receive_updates,valid_from,created_by,updated_by)
     VALUES ($1,$2,$3,'SYN Guardian Two',$4,'enc','parent',true, now() - interval '1 day','test','test')`,
    [contactToken, a.siteId, a.familyGroupId, phoneHmac(a.number, a.pepper ?? PEPPER)],
  );
  await db.query(
    `INSERT INTO ops.contact_authorization (id,site_id,contact_token,child_token,scope,channel,valid_from,created_by,updated_by)
     VALUES ($1,$2,$3,$4,'RECEIVE_TRANSPORT_UPDATES','SMS_1TO1', now() - interval '1 day','test','test')`,
    [uuidv7(), a.siteId, contactToken, a.childToken],
  );
  return contactToken;
}

/**
 * A PENDING acknowledgment with the outbound message it is for and, optionally, the deadline timer
 * that would escalate it — the state §11.2 `record_acknowledgment` acts on (B-05 raises these for
 * real; here they are seeded).
 */
export async function seedAcknowledgment(
  db: Db,
  a: { siteId: string; contactToken: string; childToken: string; dueAt: Date; withTimer?: boolean },
): Promise<{ ackId: string; outboundMessageId: string; timerJobId: string | null; timerKey: string | null }> {
  const outboundMessageId = uuidv7();
  await db.query(
    `INSERT INTO ops.outbound_message (id, site_id, purpose, recipient_rule, recipient_token, channel, template_id,
       vars, child_token, plan_version_basis, not_after, state, idempotency_key, created_by, updated_by)
     VALUES ($1,$2,'THERAPIST_ALERT','therapist_of_session',$3,'SMS_1TO1','therapist.absence_alert',
       '{"sessionStart":"09:00"}'::jsonb,$4,0,$5,'SENT',$6,'test','test')`,
    [outboundMessageId, a.siteId, a.contactToken, a.childToken, a.dueAt.toISOString(), `ack-seed:${outboundMessageId}`],
  );
  const timerJobId = a.withTimer === false ? null : uuidv7();
  const timerKey = timerJobId ? `ack.deadline:${outboundMessageId}` : null;
  if (timerJobId) {
    await db.query(
      `INSERT INTO ops.job (id, site_id, key, kind, payload, due_at, state, created_by, updated_by)
       VALUES ($1,$2,$3,'ack.deadline','{}'::jsonb,$4,'SCHEDULED','test','test')`,
      [timerJobId, a.siteId, timerKey, a.dueAt.toISOString()],
    );
  }
  const ackId = uuidv7();
  await db.query(
    `INSERT INTO ops.acknowledgment (id, site_id, outbound_message_id, contact_token, state, due_at, timer_job_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$6,'test','test')`,
    [ackId, a.siteId, outboundMessageId, a.contactToken, a.dueAt.toISOString(), timerJobId],
  );
  return { ackId, outboundMessageId, timerJobId, timerKey };
}

/** One inbound message in a thread. Returns its id — the `msg.inbound` trigger id. */
export async function seedInbound(
  db: Db,
  a: { siteId: string; threadId: string; fromHmac: string; body: string; receivedAt: Date; externalId?: string },
): Promise<string> {
  const id = uuidv7();
  const externalId = a.externalId ?? `SIM-${id}`;
  await db.query(
    `INSERT INTO ops.message (id, site_id, thread_id, direction, provider, external_id, from_hmac, body_tokenized,
       raw_payload_hash, idempotency_key, received_at, created_by, updated_by, source_mode)
     VALUES ($1,$2,$3,'IN','SIM',$4,$5,$6,'hash',$7,$8,'test','test','SIMULATED')`,
    [id, a.siteId, a.threadId, externalId, a.fromHmac, tokenizeBody(a.body), `sms-in:${externalId}`, a.receivedAt.toISOString()],
  );
  return id;
}
