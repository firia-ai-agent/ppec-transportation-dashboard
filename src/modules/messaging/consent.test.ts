import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { F1_NUMBER, PEPPER, seedPersona, type Persona } from "@/test/messaging";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { drain, enqueue, type DrainDeps, type EnqueueInput } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { classifyConsentKeyword, recordConsent, type ConsentKind } from "./consent";
import { DbSimMessagingProvider } from "./sim-provider";

let pg: PGlite; let db: Db; let now: Date; let f1: Persona; let outboxTransport: FakeOutboxTransport; let deps: DrainDeps;

const sent = async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.message WHERE direction='OUT'", [])).rows[0].n;
const suppressions = async () => (await db.query<{ scope: string; lifted_at: Date | null; permanent_test: boolean }>(
  "SELECT scope, lifted_at, permanent_test FROM ops.suppression WHERE contact_token=$1 ORDER BY created_at", [f1.contactToken])).rows;
const tasks = async () => (await db.query<{ category: string; severity: string; summary: string }>(
  "SELECT category, severity, summary FROM ops.task ORDER BY created_at", [])).rows;
const state = async (id: string) => (await db.query<{ state: string; block_reason: string | null }>(
  "SELECT state, block_reason FROM ops.outbound_message WHERE id=$1", [id])).rows[0];

const msg = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
  siteId: SITE, purpose: "PICKUP_UPDATE", recipientRule: "guardian", recipientToken: f1.contactToken, channel: "SMS_1TO1",
  templateId: "pickup.eta", vars: { childFirstName: "Syn", eta: "8:12-8:22 AM", stopLabel: "Okeeheelee Park" },
  childToken: f1.childToken, planVersionBasis: 1, notAfter: new Date(now.getTime() + 3_600_000), idempotencyKey: uuidv7(), by: "test", ...o });
const put = (o: Partial<EnqueueInput> = {}) => db.tx((tx, ac) => enqueue(tx, ac, outboxTransport, msg(o)));
const consent = (kind: ConsentKind, atMs: number) => db.tx((tx) => recordConsent(tx, {
  siteId: SITE, contactToken: f1.contactToken, channel: "SMS_1TO1", kind, at: new Date(atMs), by: "test" }));

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  now = new Date();
  outboxTransport = new FakeOutboxTransport();
  const wake = new FakeTransport();
  deps = {
    provider: new DbSimMessagingProvider(db, new VercelQueueScheduler(db, wake, () => now), { clock: () => now, pepper: PEPPER }),
    authorizer: dbRecipientAuthorizer(db), clock: () => now, timeoutMs: 500,
  };
  f1 = await seedPersona(db, F1_NUMBER);
  now = new Date(Date.now() + 1000);
}, 60_000);

// One PGlite per test adds up: close it, or the worker is killed part-way through the file.
afterEach(async () => { await pg.close(); });

describe("consent keywords (MSG-04)", () => {
  it("recognizes carrier keywords on the whole body only", () => {
    for (const b of ["STOP", "stop", "Stop.", " STOPALL ", "unsubscribe", "QUIT"]) expect(classifyConsentKeyword(b), b).toBe("STOP");
    for (const b of ["START", "start", "unstop", "Subscribe"]) expect(classifyConsentKeyword(b), b).toBe("START");
    for (const b of ["HELP", "help!", "info"]) expect(classifyConsentKeyword(b), b).toBe("HELP");
  });

  it("recognizes plain-English opt-out", () => {
    for (const b of ["stop texting me", "Please stop sending me texts", "no more texts", "don't text me", "take me off", "opt me out", "Unsubscribe me please"]) {
      expect(classifyConsentKeyword(b), b).toBe("NL_OPT_OUT");
    }
  });

  it("leaves ordinary ride messages alone, including the word cancel and a stop label", () => {
    for (const b of ["cancel", "cancel the AM ride", "end", "won't need the AM van, dropping at 9:30", "we need to stop the morning ride, text me when done",
      "please stop at the library instead", "Mia is staying home sick", "yes", "", "   "]) {
      expect(classifyConsentKeyword(b), b).toBeNull();
    }
  });
});

describe("consent ledger and the send-time block (MSG-04, PRD §10)", () => {
  it("STOP suppresses everything, raises one AMBER follow-up, and a repeat adds nothing", async () => {
    const first = await consent("STOP", now.getTime() - 1000);
    expect(first.suppression).toBe("added");
    expect(await suppressions()).toEqual([{ scope: "ALL", lifted_at: null, permanent_test: false }]);
    expect(await tasks()).toEqual([{ category: "CONSENT_OPT_OUT", severity: "AMBER", summary: "Family opted out of text messages" }]);

    const again = await consent("STOP", now.getTime() - 500);
    expect(again.suppression).toBe("unchanged");
    expect(again.taskId).toBeNull();
    expect((await suppressions()).length).toBe(1);
    expect((await tasks()).length).toBe(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM identity.consent_event", [])).rows[0].n).toBe(2);
  });

  it("STOP while a message is queued blocks the next send: zero sends (demo step 10)", async () => {
    const { id } = await put();
    await consent("STOP", now.getTime() - 500);
    expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
    expect((await state(id)).block_reason).toMatch(/suppressed \(ALL\)/);
    expect(await sent()).toBe(0);

    const next = await put();
    expect(await drain(db, next.id, deps)).toBe("BLOCKED_EGRESS");
    expect(await sent()).toBe(0);
  });

  it("START re-enables sending and lifts the suppression", async () => {
    await consent("STOP", now.getTime() - 2000);
    const back = await consent("START", now.getTime() - 1000);
    expect(back.suppression).toBe("lifted");
    expect((await suppressions())[0].lifted_at).not.toBeNull();

    const { id } = await put();
    expect(await drain(db, id, deps)).toBe("SENT");
    expect(await sent()).toBe(1);
  });

  it("an out-of-order STOP that is older than the START leaves the contact enabled", async () => {
    await consent("START", now.getTime() - 1000);
    const late = await consent("STOP", now.getTime() - 5000); // webhook arrived late, but it was sent first
    expect(late.suppression).toBe("unchanged");
    expect(await suppressions()).toEqual([]);
    const { id } = await put();
    expect(await drain(db, id, deps)).toBe("SENT");
  });

  it("plain-English opt-out suppresses non-safety traffic and asks staff to confirm by phone", async () => {
    const r = await consent("NL_OPT_OUT", now.getTime() - 1000);
    expect(r.suppression).toBe("added");
    expect(await suppressions()).toEqual([{ scope: "ALL_NON_SAFETY", lifted_at: null, permanent_test: false }]);
    expect((await tasks())[0].summary).toMatch(/their own words/);

    const update = await put();
    expect(await drain(db, update.id, deps)).toBe("BLOCKED_EGRESS");
    // The suppression scope lets a safety purpose through, but the send-time consent check in
    // outbox/policy.dbRecipientAuthorizer blocks every opt-out kind, so safety still falls back to a
    // staff voice task (PRD l.218). Asserted here so the stricter-than-scope behavior stays visible.
    const safety = await put({ purpose: "SAFETY_ALERT", templateId: "child.not_received", vars: { childFirstName: "Syn", stopLabel: "Okeeheelee Park", eta: "8:20 AM" } });
    expect(await drain(db, safety.id, deps)).toBe("BLOCKED_EGRESS");
    expect((await state(safety.id)).block_reason).toMatch(/consent withdrawn \(NL_OPT_OUT\)/);
    expect(await sent()).toBe(0);
  });

  it("a permanent test opt-out survives a START", async () => {
    await consent("PERMANENT_TEST_OPT_OUT", now.getTime() - 2000);
    expect((await suppressions())[0]).toMatchObject({ scope: "ALL", permanent_test: true });
    const back = await consent("START", now.getTime() - 1000);
    expect(back.suppression).toBe("unchanged");
    expect((await suppressions())[0].lifted_at).toBeNull();
    const { id } = await put();
    expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
  });
});
