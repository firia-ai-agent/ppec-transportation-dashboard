import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { F1_NUMBER, PEPPER, seedPersona, type Persona } from "@/test/messaging";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { fire, type Handlers } from "@/modules/jobs/runner";
import { drain, enqueue, type DrainDeps, type EnqueueInput } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { InMemorySimFaultStore } from "./faults";
import { DbSimMessagingProvider, SIM_DELAY_MAX_MS, SIM_DELAY_MIN_MS, SIM_STATUS_JOB_KIND, simDeliveryDelayMs, simStatusHandler } from "./sim-provider";

let db: Db; let now: Date; let f1: Persona;
let outboxTransport: FakeOutboxTransport; let wake: FakeTransport; let faults: InMemorySimFaultStore;
let provider: DbSimMessagingProvider; let deps: DrainDeps;
const handlers: Handlers = { [SIM_STATUS_JOB_KIND]: simStatusHandler };

const state = async (id: string) => (await db.query<{ state: string; block_reason: string | null; provider_message_id: string | null }>(
  "SELECT state, block_reason, provider_message_id FROM ops.outbound_message WHERE id=$1", [id])).rows[0];
const mailbox = async () => (await db.query<{ direction: string; external_id: string; body_tokenized: string; source_mode: string; from_hmac: string }>(
  "SELECT direction, external_id, body_tokenized, source_mode, from_hmac FROM ops.message ORDER BY received_at, id", [])).rows;
const statusJob = async (messageId: string) => (await db.query<{ id: string; due_at: Date; payload: { to: string } }>(
  "SELECT id, due_at, payload FROM ops.job WHERE key=$1", [`${SIM_STATUS_JOB_KIND}:${messageId}`])).rows[0];

const msg = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
  siteId: SITE, purpose: "PICKUP_UPDATE", recipientRule: "guardian", recipientToken: f1.contactToken, channel: "SMS_1TO1",
  templateId: "pickup.eta", vars: { childFirstName: "Syn", eta: "8:12-8:22 AM", stopLabel: "Okeeheelee Park" },
  childToken: f1.childToken, planVersionBasis: 1, notAfter: new Date(now.getTime() + 3_600_000), idempotencyKey: uuidv7(), by: "test", ...o });
const put = (o: Partial<EnqueueInput> = {}) => db.tx((tx, ac) => enqueue(tx, ac, outboxTransport, msg(o)));

beforeEach(async () => {
  ({ db } = await freshDb());
  now = new Date();
  outboxTransport = new FakeOutboxTransport(); wake = new FakeTransport(); faults = new InMemorySimFaultStore();
  provider = new DbSimMessagingProvider(db, new VercelQueueScheduler(db, wake, () => now), { faults, clock: () => now, pepper: PEPPER, seed: "test-seed" });
  deps = { provider, authorizer: dbRecipientAuthorizer(db), clock: () => now, timeoutMs: 500 };
  f1 = await seedPersona(db, F1_NUMBER);
  now = new Date(Date.now() + 1000); // after the contact's valid_from
}, 60_000);

describe("MessagingProvider.SIM (ADR-006, MOCKS §3)", () => {
  it("QUEUED → SENT puts the rendered message in the persona mailbox and arms the delivery callback", async () => {
    const { id } = await put();
    expect((await state(id)).state).toBe("QUEUED");
    expect(await mailbox()).toEqual([]);

    expect(await drain(db, id, deps)).toBe("SENT");
    const sent = await state(id);
    expect(sent.provider_message_id).toBe(`SIM-${id}`);
    const box = await mailbox();
    expect(box.length).toBe(1);
    expect(box[0]).toMatchObject({ direction: "OUT", external_id: `SIM-${id}`, source_mode: "SIMULATED" });
    expect(box[0].body_tokenized).toContain("Syn's ride is on the way to Okeeheelee Park");
    expect(box[0].body_tokenized).toContain("[DEMO]");
    expect(box[0].from_hmac).not.toContain("555"); // the center's number is stored as a blind index only

    const job = await statusJob(id);
    const delay = new Date(job.due_at).getTime() - now.getTime();
    expect(delay).toBeGreaterThanOrEqual(SIM_DELAY_MIN_MS);
    expect(delay).toBeLessThanOrEqual(SIM_DELAY_MAX_MS);
    expect(wake.sent).toEqual([expect.objectContaining({ jobId: job.id })]);

    now = new Date(now.getTime() + SIM_DELAY_MAX_MS);
    expect(await fire(db, job.id, "test", handlers, "LOCAL", () => now)).toBe("fired");
    expect((await state(id)).state).toBe("DELIVERED");
  });

  it("the delivery-failure fault ends at FAILED with a reason, and the message still shows what was sent", async () => {
    await faults.set(F1_NUMBER, { deliveryFailure: true });
    const { id } = await put();
    expect(await drain(db, id, deps)).toBe("SENT");
    const job = await statusJob(id);
    expect(job.payload.to).toBe("FAILED");
    now = new Date(now.getTime() + SIM_DELAY_MAX_MS);
    await fire(db, job.id, "test", handlers, "LOCAL", () => now);
    const after = await state(id);
    expect(after.state).toBe("FAILED");
    expect(after.block_reason).toMatch(/simulated delivery failure/);
    expect((await mailbox()).length).toBe(1);
  });

  it("the delayed-delivery fault still delivers, just later than the 1-3 s window", async () => {
    await faults.set(F1_NUMBER, { delayedDelivery: true });
    const { id } = await put();
    await drain(db, id, deps);
    const job = await statusJob(id);
    expect(new Date(job.due_at).getTime() - now.getTime()).toBeGreaterThan(SIM_DELAY_MAX_MS);
    now = new Date(new Date(job.due_at).getTime() + 1000);
    await fire(db, job.id, "test", handlers, "LOCAL", () => now);
    expect((await state(id)).state).toBe("DELIVERED");
  });

  it("the delay is deterministic from the seed, not from the wall clock", () => {
    const a = simDeliveryDelayMs("test-seed:abc");
    expect(simDeliveryDelayMs("test-seed:abc")).toBe(a);
    expect(simDeliveryDelayMs("other-seed:abc")).not.toBe(a);
    const spread = new Set(Array.from({ length: 50 }, (_, i) => simDeliveryDelayMs(`s:${i}`)));
    expect(spread.size).toBeGreaterThan(10);
    for (const d of spread) { expect(d).toBeGreaterThanOrEqual(SIM_DELAY_MIN_MS); expect(d).toBeLessThanOrEqual(SIM_DELAY_MAX_MS); }
  });

  it("a second drain of the same message adds no mailbox row and no second callback", async () => {
    const { id } = await put();
    await drain(db, id, deps);
    expect(await drain(db, id, deps)).toBe("noop");
    await provider.send({ messageId: id, siteId: SITE, idempotencyKey: "k", channel: "SMS_1TO1", recipientToken: f1.contactToken, templateId: "pickup.eta", vars: { childFirstName: "Syn", eta: "x", stopLabel: "y" } }, { signal: new AbortController().signal });
    expect((await mailbox()).length).toBe(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.job", [])).rows[0].n).toBe(1);
  });

  it("an unrenderable template is a definite refusal: FAILED, nothing in the mailbox", async () => {
    const { id } = await put({ templateId: "generic.notice", vars: {}, childToken: null, tripLegId: null });
    expect(await drain(db, id, deps)).toBe("FAILED");
    expect((await state(id)).block_reason).toMatch(/needs var text/);
    expect(await mailbox()).toEqual([]);
  });

  it("a status callback that arrives before the send finished is retried, not lost", async () => {
    const { id } = await put();
    await db.query("UPDATE ops.outbound_message SET state='SENDING' WHERE id=$1", [id]);
    await db.tx((tx, ac) => new VercelQueueScheduler(db, wake, () => now).schedule(tx, ac, {
      siteId: SITE, key: `${SIM_STATUS_JOB_KIND}:${id}`, kind: SIM_STATUS_JOB_KIND, payload: { outboundMessageId: id, to: "DELIVERED" }, dueAt: now, by: "test" }));
    const job = await statusJob(id);
    now = new Date(now.getTime() + 1000);
    expect(await fire(db, job.id, "test", handlers, "LOCAL", () => now)).toBe("failed");
    await db.query("UPDATE ops.outbound_message SET state='SENT' WHERE id=$1", [id]);
    expect(await fire(db, job.id, "test", handlers, "LOCAL", () => now)).toBe("fired");
    expect((await state(id)).state).toBe("DELIVERED");
  });
});
