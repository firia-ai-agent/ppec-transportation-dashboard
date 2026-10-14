import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { drain, enqueue, sweepOutbox, STUCK_SENDING_SECONDS, type DrainDeps, type EnqueueInput } from "./outbox";
import { dbRecipientAuthorizer } from "./policy";
import { SimMessagingProvider } from "./provider";
import { FakeOutboxTransport } from "./transport";

let db: Db; let t: FakeOutboxTransport; let p: SimMessagingProvider; let deps: DrainDeps; let now: Date;
const FAM = uuidv7(); const CONTACT = uuidv7(); const CHILD = uuidv7(); const LEG = uuidv7();
const st = async (id: string) => (await db.query<{ state: string; block_reason: string | null }>("SELECT state, block_reason FROM ops.outbound_message WHERE id=$1", [id])).rows[0];
const msg = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
  siteId: SITE, purpose: "PICKUP_UPDATE", recipientRule: "guardian", recipientToken: CONTACT, channel: "SMS_1TO1",
  templateId: "pickup.eta", vars: { eta: "SYN" }, tripLegId: LEG, planVersionBasis: 1,
  notAfter: new Date(now.getTime() + 3600_000), idempotencyKey: uuidv7(), by: "test", ...o });
const put = (o: Partial<EnqueueInput> = {}) => db.tx((tx, ac) => enqueue(tx, ac, t, msg(o)));

beforeEach(async () => {
  ({ db } = await freshDb()); t = new FakeOutboxTransport(); p = new SimMessagingProvider(); now = new Date();
  deps = { provider: p, authorizer: dbRecipientAuthorizer(db), clock: () => now, timeoutMs: 50 };
  await db.query(`INSERT INTO ops.family_group (id,site_id,display_label,created_by,updated_by) VALUES ($1,$2,'F1 (Demo)','t','t')`, [FAM, SITE]);
  await db.query(`INSERT INTO identity.guardian_contact (contact_token,site_id,family_group_id,legal_name,phone_hmac,phone_enc,relationship,can_receive_updates,created_by,updated_by)
    VALUES ($1,$2,$3,'SYN Guardian','h','e','parent',true,'t','t')`, [CONTACT, SITE, FAM]);
  await db.query(`INSERT INTO ops.child_profile (child_token,site_id,family_group_id,display_name,created_by,updated_by) VALUES ($1,$2,$3,'Sam S.','t','t')`, [CHILD, SITE, FAM]);
  await db.query(`INSERT INTO ops.trip_leg (id,site_id,child_token,service_date,direction,mode,created_by,updated_by) VALUES ($1,$2,$3,current_date,'AM','CENTER','t','t')`, [LEG, SITE, CHILD]);
  await db.query(`INSERT INTO ops.contact_authorization (id,site_id,contact_token,child_token,scope,channel,valid_from,created_by,updated_by)
    VALUES ($1,$2,$3,$4,'RECEIVE_TRANSPORT_UPDATES','SMS_1TO1',now() - interval '1 day','t','t')`, [uuidv7(), SITE, CONTACT, CHILD]);
  now = new Date(Date.now() + 1000); // after the contact's valid_from
}, 60_000);

describe("outbox (ADR-003)", () => {
  it("enqueue writes QUEUED in the caller's tx and publishes only after commit; rollback leaves nothing", async () => {
    const { id } = await put();
    expect((await st(id)).state).toBe("QUEUED"); expect(t.sent).toEqual([id]);
    await expect(db.tx(async (tx, ac) => { await enqueue(tx, ac, t, msg()); throw new Error("domain failed"); })).rejects.toThrow();
    expect(t.sent.length).toBe(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(1);
  });
  it("same idempotency key is one row; drain sends once; second drain is a no-op", async () => {
    const key = uuidv7();
    const a = await put({ idempotencyKey: key }); const b = await put({ idempotencyKey: key });
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(await drain(db, a.id, deps)).toBe("SENT");
    expect(await drain(db, a.id, deps)).toBe("noop");
    expect(p.sent.length).toBe(1);
  });
  it("not_after passed → CANCELED_STALE, nothing sent", async () => {
    const { id } = await put({ notAfter: new Date(now.getTime() - 1000) });
    expect(await drain(db, id, deps)).toBe("CANCELED_STALE"); expect(p.sent.length).toBe(0);
  });
  it("plan_version_basis mismatch → CANCELED_STALE", async () => {
    const { id } = await put();
    await db.query("UPDATE ops.trip_leg SET plan_version = 2 WHERE id=$1", [LEG]);
    expect(await drain(db, id, deps)).toBe("CANCELED_STALE");
    expect((await st(id)).block_reason).toMatch(/plan_version/);
  });
  it("suppression ALL_NON_SAFETY blocks updates but not safety purposes; ALL blocks both", async () => {
    await db.query(`INSERT INTO ops.suppression (id,site_id,contact_token,scope,consent_event_id,created_by,updated_by) VALUES ($1,$2,$3,'ALL_NON_SAFETY',$4,'t','t')`, [uuidv7(), SITE, CONTACT, uuidv7()]);
    const a = await put(); const s = await put({ purpose: "SAFETY_ALERT" });
    expect(await drain(db, a.id, deps)).toBe("BLOCKED_EGRESS");
    expect(await drain(db, s.id, deps)).toBe("SENT");
    await db.query(`INSERT INTO ops.suppression (id,site_id,contact_token,scope,consent_event_id,created_by,updated_by) VALUES ($1,$2,$3,'ALL',$4,'t','t')`, [uuidv7(), SITE, CONTACT, uuidv7()]);
    const s2 = await put({ purpose: "SAFETY_ALERT" });
    expect(await drain(db, s2.id, deps)).toBe("BLOCKED_EGRESS");
  });
  it("revoked, unknown or unauthorized recipient → BLOCKED_EGRESS", async () => {
    const u = await put({ recipientToken: uuidv7() });
    expect(await drain(db, u.id, deps)).toBe("BLOCKED_EGRESS");
    await db.query("UPDATE identity.guardian_contact SET revoked_at = now() WHERE contact_token=$1", [CONTACT]);
    const r = await put();
    expect(await drain(db, r.id, deps)).toBe("BLOCKED_EGRESS");
    expect(p.sent.length).toBe(0);
  });
  it("provider timeout → UNKNOWN and is never resent (drain and sweep both leave it)", async () => {
    p.hangNext = 1;
    const { id } = await put();
    expect(await drain(db, id, deps)).toBe("UNKNOWN");
    expect(await drain(db, id, deps)).toBe("noop");
    now = new Date(now.getTime() + 3600_000);
    await sweepOutbox(db, deps);
    expect((await st(id)).state).toBe("UNKNOWN"); expect(p.sent.length).toBe(1);
  });
  it("provider error during send → UNKNOWN (no SENDING→FAILED edge in PRD §6.3), never resent", async () => {
    p.failNext = 1; const { id } = await put();
    expect(await drain(db, id, deps)).toBe("UNKNOWN");
    expect((await st(id)).block_reason).toMatch(/provider error/);
  });
  it("sweeper drains a row whose wake-up was lost, and moves stuck SENDING to UNKNOWN without resending", async () => {
    t.failNext = 1;
    const { id } = await put();
    expect(t.sent.length).toBe(0);
    const stuck = await put();
    await db.query("UPDATE ops.outbound_message SET state='SENDING' WHERE id=$1", [stuck.id]);
    now = new Date(now.getTime() + (STUCK_SENDING_SECONDS + 10) * 1000);
    const rep = await sweepOutbox(db, deps);
    expect(rep).toMatchObject({ drained: 1, stuckToUnknown: 1 });
    expect((await st(id)).state).toBe("SENT"); expect((await st(stuck.id)).state).toBe("UNKNOWN");
    expect(p.sent.map((m) => m.messageId)).toEqual([id]);
  });

  describe("send-time authorization and consent (Veri #8 b)", () => {
    const consent = (kind: string, atMs: number) => db.query(
      `INSERT INTO identity.consent_event (id,site_id,contact_token,kind,channel,at,source_mode) VALUES ($1,$2,$3,$4,'SMS_1TO1',$5,'SIMULATED')`,
      [uuidv7(), SITE, CONTACT, kind, new Date(atMs).toISOString()]);
    it("happy path: authorized contact with OPT_IN consent is sent", async () => {
      await consent("OPT_IN", now.getTime() - 60_000);
      const { id } = await put();
      expect(await drain(db, id, deps)).toBe("SENT"); expect(p.sent.length).toBe(1);
    });
    it("consent revoked (STOP) after enqueue → BLOCKED_EGRESS, not sent; a later START re-allows", async () => {
      await consent("OPT_IN", now.getTime() - 60_000);
      const { id } = await put();
      await consent("STOP", now.getTime() - 1000);
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(id)).block_reason).toMatch(/consent withdrawn \(STOP\)/);
      expect(p.sent.length).toBe(0);
      await consent("START", now.getTime() - 500);
      const again = await put();
      expect(await drain(db, again.id, deps)).toBe("SENT");
    });
    it("guardianship removed after enqueue (authorization window closed) → BLOCKED_EGRESS, not sent", async () => {
      const { id } = await put();
      await db.query("UPDATE ops.contact_authorization SET valid_to = now() - interval '1 second' WHERE contact_token = $1", [CONTACT]);
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(id)).block_reason).toMatch(/not authorized for this child/);
      expect(p.sent.length).toBe(0);
    });
    it("authorization for a different channel does not count", async () => {
      const { id } = await put({ channel: "TEAMS" });
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
    });
  });
});
