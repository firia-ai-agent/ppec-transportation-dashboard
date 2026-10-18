/**
 * MessagingProvider.SIM (ADR-006): the real simulation backend behind the same seam the Twilio adapter will use.
 *
 * A send writes the message into the persona phone's mailbox (`ops.message`, direction OUT, provider SIM,
 * source_mode SIMULATED) and schedules the delivery status callback as a durable timer job, so the lifecycle
 * the phone shows is QUEUED → SENT → DELIVERED with a 1–3 s delay that is deterministic for a given seed.
 * Nothing here uses setTimeout: the status callback is an `ops.job` row (ADR-001), exactly like a real
 * provider's status webhook arriving later, and it survives a restart.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db, Exec } from "@/db/exec";
import { StaleOrConflict } from "@/domain/transition";
import type { Handler } from "@/modules/jobs/runner";
import { systemClock, type Clock, type JobScheduler } from "@/modules/jobs/scheduler";
import { applyProviderStatus } from "@/modules/outbox/outbox";
import { ProviderRejected, ProviderTimeout, type MessagingProvider, type OutboundPayload } from "@/modules/outbox/provider";
import { phoneHmac } from "@/modules/identity/phone";
import { NO_FAULTS, simFaultStore, type SimFaultStore } from "./faults";
import { SIM_CENTER_NUMBER, simNumberByHmac } from "./sim-numbers";
import { renderTemplate, TemplateRenderError } from "./templates";
import { uuidv7 } from "uuidv7";

export const SIM_STATUS_JOB_KIND = "sms.sim.status";
export const SIM_DELAY_MIN_MS = 1_000;
export const SIM_DELAY_MAX_MS = 3_000;
/** The "delayed delivery" fault: late but still inside STATUS_CALLBACK_WINDOW_SECONDS, so it lands DELIVERED. */
export const SIM_DELAYED_DELIVERY_EXTRA_MS = 10 * 60_000;
export const DELIVERY_FAILURE_REASON = "simulated delivery failure (demo fault)";

/** FNV-1a, so the same (seed, message) always gives the same delay — replay-safe (AT-03). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function simDeliveryDelayMs(seed: string): number {
  return SIM_DELAY_MIN_MS + (fnv1a(seed) % (SIM_DELAY_MAX_MS - SIM_DELAY_MIN_MS + 1));
}

export type SimProviderOptions = {
  /** Replay seed (MOCKS §5: same seed ⇒ same timings). */
  seed?: string;
  faults?: SimFaultStore;
  clock?: Clock;
  /** Phone blind-index pepper; defaults to the HMAC_PEPPER env value. */
  pepper?: string;
};

type Recipient = { familyGroupId: string | null; phoneHmac: string | null };

export class DbSimMessagingProvider implements MessagingProvider {
  readonly name = "SIM";
  private readonly seed: string;
  private readonly clock: Clock;
  private readonly faults: SimFaultStore;

  constructor(private db: Db, private scheduler: JobScheduler, private opts: SimProviderOptions = {}) {
    this.seed = opts.seed ?? "ppec-sim";
    this.clock = opts.clock ?? systemClock;
    this.faults = opts.faults ?? simFaultStore();
  }

  private pepper(): string {
    const p = this.opts.pepper ?? process.env.HMAC_PEPPER;
    if (!p) throw new ProviderRejected("phone pepper is not configured, cannot address the sim mailbox");
    return p;
  }

  /**
   * The display name on this message's child row, or null when it names no child (a closure
   * notice) or the row is gone. One `SELECT`, site-scoped like every other read here.
   */
  private async childName(msg: OutboundPayload): Promise<string | null> {
    if (!msg.childToken) return null;
    const r = await this.db.query<{ display_name: string | null }>(
      "SELECT display_name FROM ops.child_profile WHERE child_token = $1 AND site_id = $2",
      [msg.childToken, msg.siteId],
    );
    return r.rows[0]?.display_name ?? null;
  }

  async send(msg: OutboundPayload, opts: { signal: AbortSignal }) {
    if (opts.signal.aborted) throw new ProviderTimeout("sim: aborted before the send started");
    let body: string;
    try {
      /*
       * The child's name, read from the child's own row at send time (Firia, 10:51 PM ET: the
       * text names the child). Never a var: the outbox's allowlist refuses every name anybody
       * could type (Veri #12), and this is the database's answer, not a caller's. A row that
       * cannot be read renders "your child" and the text still goes.
       */
      body = renderTemplate(msg.templateId, msg.vars, { child: await this.childName(msg) });
    } catch (e) {
      // A bad template or a missing var is a definite refusal: FAILED, never a blind retry.
      if (e instanceof TemplateRenderError) throw new ProviderRejected(`sim: ${e.message}`);
      throw e;
    }
    const pepper = this.pepper();
    const providerMessageId = `SIM-${msg.messageId}`;
    const now = this.clock();
    const centerHmac = phoneHmac(SIM_CENTER_NUMBER, pepper);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ channel: msg.channel, recipientToken: msg.recipientToken, templateId: msg.templateId, vars: msg.vars, idempotencyKey: msg.idempotencyKey }))
      .digest("hex");

    const recipient = await this.recipient(msg);
    const personaNumber = recipient.phoneHmac ? simNumberByHmac(pepper).get(recipient.phoneHmac) : undefined;
    /*
     * **A family is texted on a synthetic number or not at all** (MOCKS §3; Veri's bar, 2026-10-17).
     *
     * The fiction block is 555-01xx and `simNumberByHmac` is its whole address book — the centre's
     * number and the eight persona phones. A family contact whose blind index is not in it is a
     * number this simulation cannot name, and the only safe thing to do with a number we cannot
     * name is refuse: `ProviderRejected`, so the message ends FAILED and is never retried into
     * somebody's real phone. Therapists and dispatchers have no family group and are not addressed
     * through the persona phones, so they are not held to this.
     */
    if (recipient.familyGroupId !== null && personaNumber === undefined) {
      throw new ProviderRejected("sim: the recipient is not a synthetic persona number");
    }
    const faults = personaNumber ? await this.faults.get(personaNumber) : NO_FAULTS;
    const delayMs = simDeliveryDelayMs(`${this.seed}:${msg.messageId}`) + (faults.delayedDelivery ? SIM_DELAYED_DELIVERY_EXTRA_MS : 0);

    await this.db.tx(async (tx, afterCommit) => {
      const threadId = await getOrCreateThread(tx, {
        siteId: msg.siteId, channel: msg.channel, counterpartyToken: msg.recipientToken,
        familyGroupId: recipient.familyGroupId, by: "system:sim-provider", at: now,
      });
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO ops.message (id, site_id, thread_id, direction, provider, external_id, from_hmac, body_tokenized,
           raw_payload_hash, idempotency_key, received_at, created_by, updated_by, source_mode)
         VALUES ($1,$2,$3,'OUT','SIM',$4,$5,$6,$7,$8,$9,$10,$10,'SIMULATED')
         ON CONFLICT (provider, external_id) DO NOTHING RETURNING id`,
        [uuidv7(), msg.siteId, threadId, providerMessageId, centerHmac, body, payloadHash, msg.idempotencyKey, now.toISOString(), "system:sim-provider"]);
      if (!ins.rows.length) return; // same message already in the mailbox: idempotent, and the job already exists
      await touchThread(tx, threadId, now);
      await this.scheduler.schedule(tx, afterCommit, {
        siteId: msg.siteId, key: `${SIM_STATUS_JOB_KIND}:${msg.messageId}`, kind: SIM_STATUS_JOB_KIND,
        payload: {
          outboundMessageId: msg.messageId,
          to: faults.deliveryFailure ? "FAILED" : "DELIVERED",
          reason: faults.deliveryFailure ? DELIVERY_FAILURE_REASON : null,
        },
        dueAt: new Date(now.getTime() + delayMs), by: "system:sim-provider",
      });
    });
    return { providerMessageId };
  }

  /** Identity lookup for addressing only: the family group the thread belongs to and the blind index. */
  private async recipient(msg: OutboundPayload): Promise<Recipient> {
    const g = await this.db.query<{ family_group_id: string; phone_hmac: string }>(
      `SELECT family_group_id, phone_hmac FROM identity.guardian_contact
       WHERE contact_token = $1 AND site_id = $2 ORDER BY valid_from DESC LIMIT 1`, [msg.recipientToken, msg.siteId]);
    if (g.rows[0]) return { familyGroupId: g.rows[0].family_group_id, phoneHmac: g.rows[0].phone_hmac };
    // Therapists and provider dispatchers have no family group; they still get a thread of their own.
    const p = await this.db.query<{ phone_hmac: string | null }>(
      "SELECT phone_hmac FROM identity.external_person_identity WHERE person_token = $1 AND site_id = $2", [msg.recipientToken, msg.siteId]);
    return { familyGroupId: null, phoneHmac: p.rows[0]?.phone_hmac ?? null };
  }
}

/**
 * One OPEN/PAUSED thread per counterparty and channel, enforced by thread_counterparty_live_uq (0006), a
 * unique index on exactly the key this lookup uses, partial on state <> 'CLOSED' so a closed conversation
 * can still be reopened in a new thread.
 *
 * Race: two first messages for the same counterparty can both read "no thread", so the insert takes the
 * conflict instead of a second row (ON CONFLICT DO NOTHING, then re-read the winner). The loser's own
 * statement waits on the winner's uncommitted insert, so by the time DO NOTHING reports nothing inserted
 * the winning row is committed and visible to the next statement.
 *
 * An unknown sender has no token to key on: those rows are NULL in the index, never conflict, and are
 * found through the from_hmac of the messages already in the thread. Two simultaneous first messages from
 * one unknown number can therefore still open two threads; the read API reads every thread of the
 * counterparty, and the thread is re-keyed as soon as the number is matched to a contact.
 */
export async function getOrCreateThread(tx: Exec, a: {
  siteId: string; channel: string; counterpartyToken: string | null; familyGroupId: string | null;
  by: string; at: Date; fromHmac?: string;
}): Promise<string> {
  const find = () => a.counterpartyToken
    ? tx.query<{ id: string }>(
      `SELECT id FROM ops.conversation_thread WHERE site_id = $1 AND counterparty_token = $2 AND channel = $3 AND state <> 'CLOSED'
       ORDER BY created_at LIMIT 1`, [a.siteId, a.counterpartyToken, a.channel])
    // Unknown sender: no token to key on, so the thread is found through the messages already in it.
    : tx.query<{ id: string }>(
      `SELECT t.id FROM ops.conversation_thread t JOIN ops.message m ON m.thread_id = t.id
       WHERE t.site_id = $1 AND t.counterparty_token IS NULL AND t.channel = $2 AND t.state <> 'CLOSED' AND m.from_hmac = $3
       ORDER BY t.created_at LIMIT 1`, [a.siteId, a.channel, a.fromHmac ?? ""]);
  const found = await find();
  if (found.rows[0]) return found.rows[0].id;
  const id = uuidv7();
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO ops.conversation_thread (id, site_id, family_group_id, counterparty_token, channel, last_activity_at, created_by, updated_by, source_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'SIMULATED')
     ON CONFLICT (site_id, counterparty_token, channel) WHERE state <> 'CLOSED' DO NOTHING RETURNING id`,
    [id, a.siteId, a.familyGroupId, a.counterpartyToken, a.channel, a.at.toISOString(), a.by]);
  if (ins.rows[0]) return ins.rows[0].id;
  const other = await find();
  if (other.rows[0]) return other.rows[0].id;
  // Only reachable if the conflicting row is invisible to this transaction (a snapshot taken before it
  // committed, i.e. an isolation level above READ COMMITTED). Fail loudly rather than write a second thread.
  throw new StaleOrConflict(`conversation_thread ${a.siteId}/${a.counterpartyToken}/${a.channel}: concurrent thread not visible`);
}

/** Activity never goes backwards, so an out-of-order webhook cannot pull a thread back up the list. */
export async function touchThread(tx: Exec, threadId: string, at: Date) {
  await tx.query(
    `UPDATE ops.conversation_thread SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz), updated_at = now()
     WHERE id = $1`, [threadId, at.toISOString()]);
}

const statusPayload = z.object({
  outboundMessageId: z.string().uuid(),
  to: z.enum(["DELIVERED", "UNDELIVERED", "FAILED"]),
  reason: z.string().max(280).nullish(),
});

/** Timer handler for `sms.sim.status` (registered in modules/jobs/handlers.ts). DB-only, like every handler. */
export const simStatusHandler: Handler = async (tx, job) => {
  const p = statusPayload.parse(job.payload);
  await applyProviderStatus(tx, { id: p.outboundMessageId, to: p.to, reason: p.reason ?? null, by: "system:sim-status" });
};
