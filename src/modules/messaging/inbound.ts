/**
 * Inbound SMS webhook (MSG-01/03/04, ADR-006, MOCKS §3).
 *
 * The persona phones post the body shape a Twilio form post has, signed with a sim HMAC header instead of
 * X-Twilio-Signature, so the handler path is identical to live: verify, tokenize, insert on
 * (provider, external_id), hand off. Everything else about the request is the same.
 *
 * Guarantees:
 *  - unsigned or wrongly signed → 401, nothing read, nothing written (fail closed, timing-safe compare);
 *  - the same provider message id twice → one row, 200 no-op (MSG-01), whatever the delivery order;
 *  - out-of-order delivery is ordered by the provider's own index and by when the phone sent it, so a late
 *    webhook cannot pull a thread back to the top or outrank a newer consent event;
 *  - our own number as the sender → is_own_echo, no handoff (MSG-03);
 *  - an unknown sender is kept as evidence and gets no reply of any kind (AT-09);
 *  - STOP/START/HELP and plain-English opt-out go to the consent ledger (MSG-04); HELP answers with fixed
 *    copy through the outbox, never with a direct send.
 *
 * The duplicate-inbound and out-of-order faults live in the sim's delivery of these posts
 * (faults.simInboundPosts), not here: faults belong in the transport, never in the handler under test.
 */
import { createHash, timingSafeEqual, createHmac } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { API, endpointRow } from "@/auth/access";
import type { Db, Exec } from "@/db/exec";
import { normalizeE164, phoneHmac, tokenizeBody } from "@/modules/identity/phone";
import { systemClock, type Clock } from "@/modules/jobs/scheduler";
import { enqueue, type OutboxTransport } from "@/modules/outbox/outbox";
import { classifyConsentKeyword, recordConsent } from "./consent";
import { noopInboundMessageHook, type InboundMessageHook } from "./hook";
import { SIM_CENTER_NUMBER } from "./sim-numbers";
import { HELP_REPLY_TEMPLATE } from "./templates";
import { getOrCreateThread, touchThread } from "./sim-provider";

/**
 * Sim stand-in for X-Twilio-Signature, taken from this webhook's own row in the one access table
 * (src/auth/access.ts, `signature-webhook`) rather than written out a second time here, so the header the
 * guard reads and the header the table documents cannot drift apart. The table names the secret's
 * environment variable; the value is read from the environment by the route and lives nowhere else.
 *
 * The fallback is a header no caller sends, so a table with this row removed fails closed with a 401
 * rather than throwing on an empty header name.
 */
const WEBHOOK_ROW = endpointRow(API.smsWebhook)?.auth;
export const SIM_SIGNATURE_HEADER =
  WEBHOOK_ROW?.kind === "signature-webhook" ? WEBHOOK_ROW.header : "x-signature-no-row-in-the-access-table";
export const INBOUND_CHANNEL = "SMS_1TO1";
/** A HELP answer that has not gone out in this long is not worth sending. */
export const HELP_REPLY_NOT_AFTER_MS = 15 * 60_000;

export function signSimWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Fail closed: an unset or empty secret, a secret too short to be one, no header, a wrong length or a
 * wrong digest ⇒ false. Never true by default, and the digests are compared with `timingSafeEqual`, so
 * a wrong signature leaks nothing about how far it got. The HMAC covers the **raw** body, so the same
 * signature over a different body does not verify.
 */
export function verifySimWebhook(rawBody: string, header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  const want = Buffer.from(signSimWebhook(rawBody, secret));
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Twilio-shaped form body. `SimIndex` and `SimSentAt` are the sim's only additions: a real provider gives us
 * ordering and timing out of band, and the sim has to say so explicitly for the out-of-order fault to mean
 * anything. Unknown fields are ignored, exactly as the live handler would.
 */
const formSchema = z.object({
  MessageSid: z.string().min(1).max(200),
  From: z.string().min(1).max(40),
  To: z.string().min(1).max(40),
  Body: z.string().max(1600).default(""),
  NumMedia: z.coerce.number().int().min(0).max(10).optional(),
  SimIndex: z.coerce.number().int().min(0).max(1_000_000).optional(),
  SimSentAt: z.coerce.date().optional(),
});

export type InboundForm = z.infer<typeof formSchema>;

export function parseInboundForm(params: URLSearchParams): { form: InboundForm } | { error: string } {
  const parsed = formSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { form: parsed.data };
}

export type InboundDeps = {
  pepper: string;
  transport: OutboxTransport;
  hook?: InboundMessageHook;
  clock?: Clock;
};

export type InboundBody = {
  ok: boolean;
  duplicate: boolean;
  messageId?: string;
  /** The sender matched a contact record. An unknown sender is stored and nothing is sent back. */
  known?: boolean;
  echo?: boolean;
  consent?: string | null;
  replyQueued?: boolean;
  error?: string;
};

type Sender = { contactToken: string; familyGroupId: string | null } | null;

/**
 * P1 shortcut, and a schema gap worth naming: nothing maps a provider number to a site, so the sim's single
 * center number resolves to the one site. A real Twilio deployment needs that mapping (one number per site,
 * or a messaging-service id on ops.site) before more than one site exists.
 */
async function siteForCenterNumber(tx: Exec, to: string): Promise<string | null> {
  if (to !== SIM_CENTER_NUMBER) return null;
  const r = await tx.query<{ id: string }>("SELECT id FROM ops.site ORDER BY created_at, id LIMIT 1", []);
  return r.rows[0]?.id ?? null;
}

/** Blind-index lookup through identity: a guardian contact first, then a therapist or provider dispatcher. */
async function resolveSender(tx: Exec, a: { siteId: string; fromHmac: string; at: Date }): Promise<Sender> {
  const g = await tx.query<{ contact_token: string; family_group_id: string }>(
    `SELECT contact_token, family_group_id FROM identity.guardian_contact
     WHERE phone_hmac = $1 AND site_id = $2 AND revoked_at IS NULL AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY valid_from DESC LIMIT 1`, [a.fromHmac, a.siteId, a.at.toISOString()]);
  if (g.rows[0]) return { contactToken: g.rows[0].contact_token, familyGroupId: g.rows[0].family_group_id };
  const p = await tx.query<{ person_token: string }>(
    "SELECT person_token FROM identity.external_person_identity WHERE phone_hmac = $1 AND site_id = $2 LIMIT 1", [a.fromHmac, a.siteId]);
  return p.rows[0] ? { contactToken: p.rows[0].person_token, familyGroupId: null } : null;
}

export async function ingestInbound(db: Db, deps: InboundDeps, rawBody: string, form: InboundForm): Promise<{ status: number; body: InboundBody }> {
  const from = normalizeE164(form.From);
  const to = normalizeE164(form.To);
  if (!from || !to) return { status: 400, body: { ok: false, duplicate: false, error: "unrecognized From or To number" } };
  const now = (deps.clock ?? systemClock)();
  // When the phone sent it, not when the webhook landed: that is what makes out-of-order delivery harmless.
  const receivedAt = form.SimSentAt ?? now;
  const fromHmac = phoneHmac(from, deps.pepper);
  const rawPayloadHash = createHash("sha256").update(rawBody).digest("hex");
  const hook = deps.hook ?? noopInboundMessageHook;

  return db.tx(async (tx, afterCommit) => {
    const siteId = await siteForCenterNumber(tx, to);
    if (!siteId) return { status: 404, body: { ok: false, duplicate: false, error: "unknown destination number" } };

    const isOwnEcho = from === SIM_CENTER_NUMBER;
    const sender = isOwnEcho ? null : await resolveSender(tx, { siteId, fromHmac, at: receivedAt });

    const threadId = await getOrCreateThread(tx, {
      siteId, channel: INBOUND_CHANNEL, counterpartyToken: sender?.contactToken ?? null,
      familyGroupId: sender?.familyGroupId ?? null, by: "system:sms-webhook", at: receivedAt, fromHmac,
    });
    const messageId = uuidv7();
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO ops.message (id, site_id, thread_id, direction, provider, external_id, from_hmac, is_own_echo,
         body_tokenized, raw_payload_hash, provider_index, idempotency_key, received_at, created_by, updated_by, source_mode)
       VALUES ($1,$2,$3,'IN','SIM',$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,'SIMULATED')
       ON CONFLICT (provider, external_id) DO NOTHING RETURNING id`,
      [messageId, siteId, threadId, form.MessageSid, fromHmac, isOwnEcho, tokenizeBody(form.Body), rawPayloadHash,
        form.SimIndex ?? null, `sms-in:${form.MessageSid}`, receivedAt.toISOString(), "system:sms-webhook"]);
    // Same provider message id as one we already hold: 200 no-op, no second effect of any kind (MSG-01).
    if (!ins.rows.length) return { status: 200, body: { ok: true, duplicate: true } };
    await touchThread(tx, threadId, receivedAt);

    // Our own number: evidence only, no handoff, so an outbound message can never trigger an agent run (MSG-03).
    if (isOwnEcho) return { status: 200, body: { ok: true, duplicate: false, messageId, known: false, echo: true } };
    // Unknown sender: kept as evidence, shown for staff triage, answered by nobody (AT-09).
    if (!sender) return { status: 200, body: { ok: true, duplicate: false, messageId, known: false, echo: false, consent: null, replyQueued: false } };

    const consentKind = classifyConsentKeyword(form.Body);
    if (consentKind) {
      await recordConsent(tx, {
        siteId, contactToken: sender.contactToken, channel: INBOUND_CHANNEL, kind: consentKind,
        at: receivedAt, evidenceMessageId: messageId, by: "system:sms-webhook",
      });
    }
    let replyQueued = false;
    if (consentKind === "HELP") {
      await enqueue(tx, afterCommit, deps.transport, {
        siteId, purpose: "CONSENT_HELP", recipientRule: "inbound_sender", recipientToken: sender.contactToken,
        channel: INBOUND_CHANNEL, templateId: HELP_REPLY_TEMPLATE, vars: {},
        planVersionBasis: 0, // no plan behind a HELP answer; the send-time plan check only runs for a ride
        notAfter: new Date(receivedAt.getTime() + HELP_REPLY_NOT_AFTER_MS),
        idempotencyKey: `${HELP_REPLY_TEMPLATE}:${messageId}`, by: "system:sms-webhook",
      });
      replyQueued = true;
    }

    await hook(tx, {
      siteId, messageId, threadId, contactToken: sender.contactToken, familyGroupId: sender.familyGroupId,
      channel: INBOUND_CHANNEL, bodyTokenized: tokenizeBody(form.Body), receivedAt,
      providerIndex: form.SimIndex ?? null, consentKind,
    }, afterCommit);
    return { status: 200, body: { ok: true, duplicate: false, messageId, known: true, echo: false, consent: consentKind, replyQueued } };
  });
}
