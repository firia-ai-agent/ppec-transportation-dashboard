import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { F1_NUMBER, F2_NUMBER, PEPPER, UNKNOWN_NUMBER, seedPersona, seedStaff, type Persona as Fixture } from "@/test/messaging";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { fire, type Handlers } from "@/modules/jobs/runner";
import { drain, enqueue, type DrainDeps, type EnqueueInput } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { ingestInbound, parseInboundForm, type InboundDeps } from "./inbound";
import { personaMailboxResponse, personaMessages, resolvePersona } from "./mailbox";
import { SIM_CENTER_NUMBER } from "./sim-numbers";
import { DbSimMessagingProvider, SIM_STATUS_JOB_KIND, simStatusHandler } from "./sim-provider";

let pg: PGlite; let db: Db; let now: Date; let f1: Fixture; let drainDeps: DrainDeps; let inboundDeps: InboundDeps; let outboxTransport: FakeOutboxTransport;
const handlers: Handlers = { [SIM_STATUS_JOB_KIND]: simStatusHandler };

const msg = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
  siteId: SITE, purpose: "PICKUP_UPDATE", recipientRule: "guardian", recipientToken: f1.contactToken, channel: "SMS_1TO1",
  templateId: "pickup.eta", vars: { childFirstName: "Syn", eta: "08:12", etaEnd: "08:22", stopLabel: "OKEE-PARK" },
  childToken: f1.childToken, planVersionBasis: 1, notAfter: new Date(now.getTime() + 3_600_000), idempotencyKey: uuidv7(), by: "test", ...o });
const put = (o: Partial<EnqueueInput> = {}) => db.tx((tx, ac) => enqueue(tx, ac, outboxTransport, msg(o)));
const inbound = (body: string, sid: string, from: string = F1_NUMBER) => {
  now = new Date(); // a webhook lands when it lands; the outbound rows carry the database clock
  const raw = new URLSearchParams({ MessageSid: sid, From: from, To: SIM_CENTER_NUMBER, Body: body }).toString();
  const p = parseInboundForm(new URLSearchParams(raw));
  if ("error" in p) throw new Error(p.error);
  return ingestInbound(db, inboundDeps, raw, p.form);
};
const box = async (number: string = F1_NUMBER) => {
  const persona = await resolvePersona(db, { number, pepper: PEPPER });
  if (!persona) throw new Error("persona not found");
  return personaMessages(db, persona);
};

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  now = new Date(); outboxTransport = new FakeOutboxTransport();
  drainDeps = {
    provider: new DbSimMessagingProvider(db, new VercelQueueScheduler(db, new FakeTransport(), () => now), { clock: () => now, pepper: PEPPER }),
    authorizer: dbRecipientAuthorizer(db), clock: () => now, timeoutMs: 500,
  };
  inboundDeps = { pepper: PEPPER, transport: outboxTransport, clock: () => now };
  f1 = await seedPersona(db, F1_NUMBER);
}, 60_000);

// One PGlite per test adds up: close it, or the worker is killed part-way through the file.
afterEach(async () => { await pg.close(); });

describe("persona phone read model (MOCKS §3, DESIGN-DIRECTION §6.3)", () => {
  it("resolves only the 555-01xx persona phones, and only ones with a contact", async () => {
    expect(await resolvePersona(db, { number: F1_NUMBER, pepper: PEPPER })).toMatchObject({ label: "F1", contactToken: f1.contactToken, siteId: SITE });
    expect(await resolvePersona(db, { number: "%2B15615550101", pepper: PEPPER })).toMatchObject({ label: "F1" });
    expect(await resolvePersona(db, { number: UNKNOWN_NUMBER, pepper: PEPPER })).toBeNull(); // a persona number with no contact yet
    expect(await resolvePersona(db, { number: SIM_CENTER_NUMBER, pepper: PEPPER })).toBeNull(); // the center is not a persona
    expect(await resolvePersona(db, { number: "nonsense", pepper: PEPPER })).toBeNull();
  });

  it("shows a bubble from QUEUED and follows it to Delivered, with the rendered body", async () => {
    const { id } = await put();
    const queued = await box();
    expect(queued.length).toBe(1);
    expect(queued[0]).toMatchObject({ direction: "OUT", state: "QUEUED", reachedPhone: false, providerMessageId: null, sourceMode: "SIMULATED" });
    expect(queued[0].body).toContain("Syn's ride is on the way to Okeeheelee Park. Pickup 8:12\u20138:22 AM.");

    await drain(db, id, drainDeps);
    expect((await box())[0]).toMatchObject({ state: "SENT", reachedPhone: true, providerMessageId: `SIM-${id}` });

    const job = (await db.query<{ id: string }>("SELECT id FROM ops.job WHERE key=$1", [`${SIM_STATUS_JOB_KIND}:${id}`])).rows[0];
    now = new Date(now.getTime() + 5_000);
    await fire(db, job.id, "test", handlers, "LOCAL", () => now);
    expect((await box())[0]).toMatchObject({ state: "DELIVERED", reachedPhone: true });
  });

  it("a blocked message is visible to staff but never marked as reaching the phone", async () => {
    await inbound("STOP", "SM-stop");
    const { id } = await put();
    expect(await drain(db, id, drainDeps)).toBe("BLOCKED_EGRESS");
    const rows = await box();
    const out = rows.find((r) => r.direction === "OUT");
    expect(out).toMatchObject({ state: "BLOCKED_EGRESS", reachedPhone: false });
    expect(out?.blockReason).toMatch(/suppressed/);
  });

  it("merges the persona's own messages in time order and keeps families apart", async () => {
    const f2 = await seedPersona(db, F2_NUMBER);
    await inbound("won't need the AM van, dropping at 9:30", "SM-1");
    const { id } = await put();
    await drain(db, id, drainDeps);
    await inbound("thanks", "SM-2");
    await inbound("hello from F2", "SM-3", F2_NUMBER);

    const rows = await box();
    expect(rows.map((r) => r.direction)).toEqual(["IN", "OUT", "IN"]);
    expect(rows[0].body).toBe("won't need the AM van, dropping at 9:30");
    expect([...rows].sort((a, b) => (a.at < b.at ? -1 : 1)).map((r) => r.id)).toEqual(rows.map((r) => r.id));

    const other = await box(F2_NUMBER);
    expect(other.map((r) => r.body)).toEqual(["hello from F2"]);
    expect(other.every((r) => r.id !== rows[0].id)).toBe(true);
    expect(f2.contactToken).not.toBe(f1.contactToken);
  });

  it("the center's own echo never shows up as something the family sent", async () => {
    await inbound("STOP", "SM-echo", SIM_CENTER_NUMBER);
    expect(await box()).toEqual([]);
  });

  it("caps the page size", async () => {
    for (let i = 0; i < 4; i++) await inbound(`note ${i}`, `SM-${i}`);
    const persona = await resolvePersona(db, { number: F1_NUMBER, pepper: PEPPER });
    expect((await personaMessages(db, persona!, 2)).map((r) => r.body)).toEqual(["note 2", "note 3"]);
    expect((await personaMessages(db, persona!, 10_000)).length).toBe(4);
  });

  it("needs a staff session, a known phone and a membership at that site", async () => {
    const staff = await seedStaff(db);
    const req = (userId: string | undefined, number: string = F1_NUMBER) => personaMailboxResponse(db, { number, pepper: PEPPER, userId });

    expect((await req(undefined)).status).toBe(401);
    expect((await req(uuidv7())).status).toBe(401); // a token for a user who is gone
    expect((await req(staff, UNKNOWN_NUMBER)).status).toBe(404);

    const ok = await req(staff);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ number: F1_NUMBER, label: "F1", contactToken: f1.contactToken });

    await db.query("DELETE FROM ops.site_membership WHERE user_id=$1", [staff]);
    expect((await req(staff)).status).toBe(403);
  });
});
