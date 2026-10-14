import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { F1_NUMBER, PEPPER, UNKNOWN_NUMBER, seedPersona, type Persona } from "@/test/messaging";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { drain, type DrainDeps } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { POST } from "@/app/api/webhooks/sms/route";
import { NO_FAULTS, simInboundPosts } from "./faults";
import type { InboundMessageEvent } from "./hook";
import { ingestInbound, parseInboundForm, signSimWebhook, SIM_SIGNATURE_HEADER, verifySimWebhook, type InboundDeps } from "./inbound";
import { SIM_CENTER_NUMBER } from "./sim-numbers";
import { DbSimMessagingProvider } from "./sim-provider";
import { HELP_REPLY_BODY } from "./templates";

const SECRET = "syn-webhook-secret-0123456789";
let pg: PGlite; let db: Db; let now: Date; let f1: Persona; let deps: InboundDeps; let drainDeps: DrainDeps;
let outboxTransport: FakeOutboxTransport; let seen: InboundMessageEvent[];

type Post = Record<string, string>;
const post = (p: Post) => {
  const raw = new URLSearchParams(p).toString();
  const parsed = parseInboundForm(new URLSearchParams(raw));
  if ("error" in parsed) throw new Error(parsed.error);
  return ingestInbound(db, deps, raw, parsed.form);
};
const sms = (o: Partial<Post> & { Body: string; MessageSid: string }): Post =>
  ({ From: F1_NUMBER, To: SIM_CENTER_NUMBER, ...o });

const messages = async () => (await db.query<{ direction: string; external_id: string; body_tokenized: string; is_own_echo: boolean; provider_index: string | null; thread_id: string }>(
  "SELECT direction, external_id, body_tokenized, is_own_echo, provider_index, thread_id FROM ops.message ORDER BY provider_index NULLS FIRST, received_at", [])).rows;
const consentEvents = async () => (await db.query<{ kind: string; at: Date }>("SELECT kind, at FROM identity.consent_event ORDER BY at", [])).rows;
const outbound = async () => (await db.query<{ id: string; template_id: string; state: string }>("SELECT id, template_id, state FROM ops.outbound_message ORDER BY created_at", [])).rows;
const threadActivity = async () => (await db.query<{ last_activity_at: Date }>("SELECT last_activity_at FROM ops.conversation_thread", [])).rows;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  now = new Date(); seen = []; outboxTransport = new FakeOutboxTransport();
  deps = { pepper: PEPPER, transport: outboxTransport, clock: () => now, hook: async (_tx, e) => { seen.push(e); } };
  drainDeps = {
    provider: new DbSimMessagingProvider(db, new VercelQueueScheduler(db, new FakeTransport(), () => now), { clock: () => now, pepper: PEPPER }),
    authorizer: dbRecipientAuthorizer(db), clock: () => now, timeoutMs: 500,
  };
  f1 = await seedPersona(db, F1_NUMBER);
  now = new Date(Date.now() + 1000);
}, 60_000);

// One PGlite per test adds up: close it, or the worker is killed part-way through the file.
afterEach(async () => { await pg.close(); });

describe("sim webhook signature (ADR-006)", () => {
  it("accepts its own signature and refuses everything else, failing closed", () => {
    const raw = "MessageSid=SM1&Body=hi";
    expect(verifySimWebhook(raw, signSimWebhook(raw, SECRET), SECRET)).toBe(true);
    expect(verifySimWebhook(raw, signSimWebhook(raw, SECRET + "x"), SECRET)).toBe(false);
    expect(verifySimWebhook(raw + "&x=1", signSimWebhook(raw, SECRET), SECRET)).toBe(false);
    expect(verifySimWebhook(raw, null, SECRET)).toBe(false);
    expect(verifySimWebhook(raw, "deadbeef", SECRET)).toBe(false);
    expect(verifySimWebhook(raw, signSimWebhook(raw, SECRET), undefined)).toBe(false);
    expect(verifySimWebhook(raw, signSimWebhook(raw, "short"), "short")).toBe(false);
  });

  it("the route answers 401 for a bad or missing signature and 400 for a signed body it cannot read", async () => {
    const raw = new URLSearchParams(sms({ MessageSid: "SM-401", Body: "hello" })).toString();
    const send = (headers: Record<string, string>, body = raw) =>
      POST(new Request("https://example.com/api/webhooks/sms", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } }));

    process.env.SIM_WEBHOOK_SECRET = SECRET;
    expect((await send({})).status).toBe(401);
    expect((await send({ [SIM_SIGNATURE_HEADER]: "not-the-signature" })).status).toBe(401);
    const unsigned = await send({ [SIM_SIGNATURE_HEADER]: signSimWebhook(raw, "another-secret-0123456789") });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ ok: false, error: "SIGNATURE_INVALID" });

    const bad = "Body=hello"; // no MessageSid
    expect((await send({ [SIM_SIGNATURE_HEADER]: signSimWebhook(bad, SECRET) }, bad)).status).toBe(400);

    delete process.env.SIM_WEBHOOK_SECRET;
    expect((await send({ [SIM_SIGNATURE_HEADER]: signSimWebhook(raw, SECRET) })).status).toBe(401);
  });
});

describe("inbound ingest (MSG-01/03/04, AT-09)", () => {
  it("stores one message, tokenizes the body and hands off once", async () => {
    const r = await post(sms({ MessageSid: "SM-1", Body: "text my new number 561-555-0107 when the van leaves", SimIndex: "1" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, known: true, echo: false, consent: null, replyQueued: false });
    const box = await messages();
    expect(box.length).toBe(1);
    expect(box[0].body_tokenized).toBe("text my new number [phone] when the van leaves");
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ siteId: SITE, contactToken: f1.contactToken, familyGroupId: f1.familyGroupId, consentKind: null });
    expect(await outbound()).toEqual([]); // a message is evidence, never a reason to send (RES-02)
  });

  it("the duplicate-inbound fault delivers the same webhook twice and leaves one record", async () => {
    const one = sms({ MessageSid: "SM-dup", Body: "Mia is staying home sick", SimIndex: "1" });
    const posts = simInboundPosts([one], { ...NO_FAULTS, duplicateInbound: true });
    expect(posts.length).toBe(2);
    const results = [];
    for (const p of posts) results.push(await post(p));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.duplicate)).toEqual([false, true]);
    expect((await messages()).length).toBe(1);
    expect(seen.length).toBe(1); // and the handoff happened once
  });

  it("the out-of-order fault cannot resurrect an old consent state or reorder the thread", async () => {
    const t1 = new Date(now.getTime() - 60_000);
    const t2 = new Date(now.getTime() - 30_000);
    const first = sms({ MessageSid: "SM-ooo-1", Body: "START", SimIndex: "1", SimSentAt: t1.toISOString() });
    const second = sms({ MessageSid: "SM-ooo-2", Body: "STOP", SimIndex: "2", SimSentAt: t2.toISOString() });
    const posts = simInboundPosts([first, second], { ...NO_FAULTS, outOfOrderInbound: true });
    expect(posts.map((p) => p.MessageSid)).toEqual(["SM-ooo-2", "SM-ooo-1"]);
    for (const p of posts) expect((await post(p)).status).toBe(200);

    expect((await messages()).map((m) => m.external_id)).toEqual(["SM-ooo-1", "SM-ooo-2"]); // read back in the order they were sent
    expect((await consentEvents()).map((c) => c.kind)).toEqual(["START", "STOP"]);
    // The newest event is still STOP, even though it was delivered first and START landed after it.
    const sup = await db.query<{ scope: string; lifted_at: Date | null }>("SELECT scope, lifted_at FROM ops.suppression", []);
    expect(sup.rows).toEqual([{ scope: "ALL", lifted_at: null }]);
    expect(new Date((await threadActivity())[0].last_activity_at).getTime()).toBe(t2.getTime());
  });

  it("an unknown sender is kept as evidence and gets no reply (AT-09)", async () => {
    const r = await post(sms({ From: UNKNOWN_NUMBER, MessageSid: "SM-unk", Body: "when are the Smith kids picked up?" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, known: false, replyQueued: false });
    expect((await messages()).length).toBe(1);
    expect(await outbound()).toEqual([]);
    expect(await consentEvents()).toEqual([]);
    expect(seen).toEqual([]);

    // Even STOP from an unknown number writes no consent and answers nothing.
    expect((await post(sms({ From: UNKNOWN_NUMBER, MessageSid: "SM-unk-2", Body: "STOP" }))).body.known).toBe(false);
    expect(await consentEvents()).toEqual([]);
    expect(await outbound()).toEqual([]);
  });

  it("our own number as the sender is an echo: stored, no handoff, no consent (MSG-03)", async () => {
    const r = await post(sms({ From: SIM_CENTER_NUMBER, MessageSid: "SM-echo", Body: "STOP" }));
    expect(r.body).toMatchObject({ echo: true, known: false });
    expect((await messages())[0].is_own_echo).toBe(true);
    expect(seen).toEqual([]);
    expect(await consentEvents()).toEqual([]);
  });

  it("HELP answers with the fixed copy through the outbox", async () => {
    const r = await post(sms({ MessageSid: "SM-help", Body: "HELP" }));
    expect(r.body).toMatchObject({ consent: "HELP", replyQueued: true });
    const rows = await outbound();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ template_id: "consent.help", state: "QUEUED" });
    expect(outboxTransport.sent).toEqual([rows[0].id]);
    expect((await consentEvents()).map((c) => c.kind)).toEqual(["HELP"]);

    expect(await drain(db, rows[0].id, drainDeps)).toBe("SENT");
    const out = (await messages()).find((m) => m.direction === "OUT");
    expect(out?.body_tokenized).toBe(HELP_REPLY_BODY);

    // The same inbound HELP twice is one answer: the reply key is the inbound message id.
    await post(sms({ MessageSid: "SM-help", Body: "HELP" }));
    expect((await outbound()).length).toBe(1);
  });

  it("STOP from a persona phone suppresses the contact and raises one follow-up task", async () => {
    const r = await post(sms({ MessageSid: "SM-stop", Body: "Stop" }));
    expect(r.body.consent).toBe("STOP");
    expect(r.body.replyQueued).toBe(false);
    const sup = await db.query<{ scope: string }>("SELECT scope FROM ops.suppression WHERE contact_token=$1 AND lifted_at IS NULL", [f1.contactToken]);
    expect(sup.rows).toEqual([{ scope: "ALL" }]);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.task WHERE category='CONSENT_OPT_OUT'", [])).rows[0].n).toBe(1);
  });

  it("refuses a number we do not serve and a destination that is not ours", async () => {
    expect((await post(sms({ MessageSid: "SM-bad-from", From: "nonsense", Body: "hi" }))).status).toBe(400);
    expect((await post(sms({ MessageSid: "SM-bad-to", To: "+15615550199", Body: "hi" }))).status).toBe(404);
    expect(await messages()).toEqual([]);
  });

  it("messages from the same unknown number stay in one thread, separate from a known family", async () => {
    await post(sms({ From: UNKNOWN_NUMBER, MessageSid: "SM-u1", Body: "hello" }));
    await post(sms({ From: UNKNOWN_NUMBER, MessageSid: "SM-u2", Body: "anyone there" }));
    await post(sms({ MessageSid: "SM-k1", Body: "hello from F1" }));
    const box = await messages();
    expect(new Set(box.slice(0, 2).map((m) => m.thread_id)).size).toBe(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.conversation_thread", [])).rows[0].n).toBe(2);
  });
});
