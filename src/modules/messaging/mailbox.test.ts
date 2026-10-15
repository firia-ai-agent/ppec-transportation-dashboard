import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db, Exec } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import {
  F1_NUMBER, F2_NUMBER, F3_NUMBER, PEPPER, SITE_B, UNKNOWN_NUMBER, seedPersona, seedSecondSite, seedStaff,
  type Persona as Fixture,
} from "@/test/messaging";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { fire, type Handlers } from "@/modules/jobs/runner";
import { drain, enqueue, type DrainDeps, type EnqueueInput } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { ingestInbound, parseInboundForm, type InboundDeps } from "./inbound";
import { clampLimit, DEFAULT_LIMIT, MAILBOX_ROLES, MAX_LIMIT, personaMailboxResponse, personaMessages, resolvePersona } from "./mailbox";
import { SIM_CENTER_NUMBER } from "./sim-numbers";
import { DbSimMessagingProvider, SIM_STATUS_JOB_KIND, simStatusHandler } from "./sim-provider";

let pg: PGlite; let db: Db; let now: Date; let f1: Fixture; let drainDeps: DrainDeps; let inboundDeps: InboundDeps; let outboxTransport: FakeOutboxTransport;
const handlers: Handlers = { [SIM_STATUS_JOB_KIND]: simStatusHandler };

const msg = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
  siteId: SITE, purpose: "PICKUP_UPDATE", recipientRule: "guardian", recipientToken: f1.contactToken, channel: "SMS_1TO1",
  templateId: "pickup.eta", vars: { eta: "08:12", etaEnd: "08:22", stopLabel: "OKEE-PARK" },
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
    expect(queued[0].body).toContain("Your child's van is on the way to Okeeheelee Park. Pickup 8:12\u20138:22 AM.");

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

    // A membership removed mid-session is not a role problem: the site is now one they are not a
    // member of, so the phone reads as a phone that does not exist (BUILD-PLAN §4).
    await db.query("DELETE FROM ops.site_membership WHERE user_id=$1", [staff]);
    expect(await req(staff)).toEqual({ status: 404, body: { error: "UNKNOWN_PHONE" } });
  });
});

/**
 * WHO MAY READ A FAMILY'S THREAD, and what a refusal is allowed to reveal.
 *
 * The roles are not restated here: they are read from the endpoint's row in the one access table
 * (src/auth/access.ts), which is also what the module reads, so this file tests the decision and
 * never a second copy of the policy. The row's reasoning, from PRD §1.1: the "Transport/attendance
 * coordinator, director" row's interface is the "Web console (desktop + iPad)" and the sim panel is
 * a console instrument, while "Front desk / ramp staff" have the "iPad ramp + check-in view"; PRD
 * §6.2 lists Messages as written by "adapters only" and the front desk as the writer of actual
 * attendance and custody alone. A thread is PHI-adjacent, so minimum-necessary decides the rest.
 *
 * The site-scoping answers follow the convention the rest of the app already uses (BUILD-PLAN §4,
 * src/auth/idswap.test.ts): a phone at the caller's own site with a role the row does not name is a
 * **403**, and a phone at any other site is the **same 404** as a number nobody holds.
 */
describe("the persona phone's access rules (PRD §1.1, BUILD-PLAN §4)", () => {
  const req = (userId: string | undefined, number: string = F1_NUMBER, limit?: number) =>
    personaMailboxResponse(db, { number, pepper: PEPPER, userId, limit });

  it("is open to the console roles and to nobody else, and says so from the access table", () => {
    expect([...MAILBOX_ROLES]).toEqual(["DIRECTOR", "COORDINATOR"]);
    expect(MAILBOX_ROLES).not.toContain("FRONT_DESK");
  });

  it("a director and a coordinator at the phone's site read it; the front desk is refused", async () => {
    const director = await seedStaff(db, "DIRECTOR");
    const coordinator = await seedStaff(db, "COORDINATOR");
    const frontDesk = await seedStaff(db, "FRONT_DESK");

    for (const who of [director, coordinator]) {
      const r = await req(who);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ number: F1_NUMBER, contactToken: f1.contactToken });
    }
    // Their own site, a role the row does not name: 403, which hides nothing it could hide.
    expect(await req(frontDesk)).toEqual({ status: 403, body: { error: "FORBIDDEN" } });
  });

  it("a signed-out caller is 401 and the phone is never looked up", async () => {
    const sql: string[] = [];
    const watched: Exec = { query: (q, p) => { sql.push(q as string); return db.query(q, p); } };
    const r = await personaMailboxResponse(watched, { number: F1_NUMBER, pepper: PEPPER, userId: undefined });
    expect(r).toEqual({ status: 401, body: { error: "UNAUTHENTICATED" } });
    // No session, no blind-index lookup: the number is not even hashed against the contacts table.
    expect(sql.join(" ")).not.toContain("guardian_contact");
    expect(sql).toEqual([]);
  });

  it("a user disabled while holding a session is 401, not 403", async () => {
    const director = await seedStaff(db, "DIRECTOR");
    await db.query("UPDATE ops.app_user SET disabled_at = now() WHERE id = $1", [director]);
    expect(await req(director)).toEqual({ status: 401, body: { error: "UNAUTHENTICATED" } });
  });

  it("a signed-in user who is a member of nowhere learns nothing: the same 404 as an unknown number", async () => {
    const outsider = await seedStaff(db, "DIRECTOR", null);
    const unknown = await req(outsider, UNKNOWN_NUMBER);
    expect(await req(outsider)).toEqual(unknown);
    expect(unknown).toEqual({ status: 404, body: { error: "UNKNOWN_PHONE" } });
  });

  it("a director of the other site gets the same 404 for this site's phone as for a number nobody holds", async () => {
    await seedSecondSite(db);
    const f3 = await seedPersona(db, F3_NUMBER, { siteId: SITE_B });
    const directorA = await seedStaff(db, "DIRECTOR");
    const directorB = await seedStaff(db, "DIRECTOR", SITE_B);

    // Each director reads their own site's phone...
    expect((await req(directorA, F1_NUMBER)).status).toBe(200);
    expect((await req(directorB, F3_NUMBER)).body).toMatchObject({ contactToken: f3.contactToken });

    // ...and across the boundary the answer is byte-for-byte the "no such phone" answer.
    const unknownNumber = await req(directorA, UNKNOWN_NUMBER);
    const otherSitesPhone = await req(directorA, F3_NUMBER);
    expect(otherSitesPhone).toEqual(unknownNumber);
    expect(await req(directorB, F1_NUMBER)).toEqual(unknownNumber);
    expect(unknownNumber).toEqual({ status: 404, body: { error: "UNKNOWN_PHONE" } });

    // Nothing in a refusal names a site, a contact or a family.
    const text = JSON.stringify(otherSitesPhone);
    for (const id of [SITE_B, SITE, f3.contactToken, f3.familyGroupId, f1.contactToken, F3_NUMBER]) {
      expect(text).not.toContain(id);
    }
  });

  it("a number that is not a persona phone at all is the same 404", async () => {
    const director = await seedStaff(db, "DIRECTOR");
    for (const number of ["+15615550199", "nonsense", "", SIM_CENTER_NUMBER, "../../etc/passwd"]) {
      expect({ number, r: await req(director, number) }).toEqual({
        number, r: { status: 404, body: { error: "UNKNOWN_PHONE" } },
      });
    }
  });

  it("an abusive ?limit= is clamped rather than refused, and never reaches SQL as it was sent", async () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(null)).toBe(DEFAULT_LIMIT);
    expect(clampLimit("")).toBe(DEFAULT_LIMIT);
    expect(clampLimit("abc")).toBe(DEFAULT_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
    expect(clampLimit("-5")).toBe(1);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-Infinity)).toBe(1);
    expect(clampLimit("1e9")).toBe(MAX_LIMIT);
    expect(clampLimit(Infinity)).toBe(MAX_LIMIT);
    expect(clampLimit("7.9")).toBe(7);
    expect(clampLimit(String(MAX_LIMIT + 1))).toBe(MAX_LIMIT);

    // And through the read itself: every one of them answers 200 with a page, never a 500.
    const director = await seedStaff(db, "DIRECTOR");
    for (let i = 0; i < 3; i++) await inbound(`note ${i}`, `SM-limit-${i}`);
    for (const limit of [Number.NaN, -1, 0, 1, 10 ** 9, Infinity, 2.7]) {
      const r = await req(director, F1_NUMBER, limit);
      expect({ limit, status: r.status }).toEqual({ limit, status: 200 });
      const body = r.body as { messages: unknown[] };
      expect({ limit, atMost: body.messages.length <= 3 }).toEqual({ limit, atMost: true });
      expect({ limit, atLeast: body.messages.length >= 1 }).toEqual({ limit, atLeast: true });
    }
  });
});
