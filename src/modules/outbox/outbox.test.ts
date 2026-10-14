import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { CHILD_TEMPLATES, ChildReferenceRequired, TEMPLATE_VARS, TemplateVarNotAllowed, disallowedVars, drain, enqueue, resolveUnknownByStaff, sweepOutbox, STUCK_SENDING_SECONDS, type DrainDeps, type EnqueueInput } from "./outbox";
import { dbRecipientAuthorizer } from "./policy";
import { SimMessagingProvider } from "./provider";
import { FakeOutboxTransport } from "./transport";

let db: Db; let t: FakeOutboxTransport; let p: SimMessagingProvider; let deps: DrainDeps; let now: Date;
const FAM = uuidv7(); const CONTACT = uuidv7(); const CHILD = uuidv7(); const LEG = uuidv7();
const st = async (id: string) => (await db.query<{ state: string; block_reason: string | null }>("SELECT state, block_reason FROM ops.outbound_message WHERE id=$1", [id])).rows[0];
const msg = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
  siteId: SITE, purpose: "PICKUP_UPDATE", recipientRule: "guardian", recipientToken: CONTACT, channel: "SMS_1TO1",
  templateId: "pickup.eta", vars: { eta: "07:45" }, tripLegId: LEG, childToken: CHILD, planVersionBasis: 1,
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
  it("definite provider rejection → FAILED (SENDING→FAILED), never resent", async () => {
    p.rejectNext = 1; const { id } = await put();
    expect(await drain(db, id, deps)).toBe("FAILED");
    expect((await st(id)).block_reason).toMatch(/provider rejected/);
    expect(await drain(db, id, deps)).toBe("noop");
  });
  it("UNKNOWN has a staff exit (DELIVERED or FAILED); system cannot use the staff note path on non-UNKNOWN rows", async () => {
    p.failNext = 1; const a = await put();
    expect(await drain(db, a.id, deps)).toBe("UNKNOWN");
    await resolveUnknownByStaff(db, { id: a.id, to: "FAILED", staffUserId: "u1", note: "guardian says no text" });
    expect((await st(a.id)).state).toBe("FAILED");
    p.hangNext = 1; const b = await put();
    expect(await drain(db, b.id, deps)).toBe("UNKNOWN");
    await resolveUnknownByStaff(db, { id: b.id, to: "DELIVERED", staffUserId: "u1", note: "guardian confirmed by phone" });
    expect((await st(b.id)).state).toBe("DELIVERED");
    await expect(resolveUnknownByStaff(db, { id: b.id, to: "FAILED", staffUserId: "u1", note: "x" })).rejects.toThrow();
  });
  it("ambiguous provider error during send → UNKNOWN, never resent", async () => {
    p.failNext = 1; const { id } = await put();
    expect(await drain(db, id, deps)).toBe("UNKNOWN");
    expect((await st(id)).block_reason).toMatch(/ambiguous provider error/);
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

  describe("child reference (Veri #8 review)", () => {
    const THER = uuidv7(); const PERSON = uuidv7(); const SESS = uuidv7();
    const therapistAlert = (o: Partial<EnqueueInput> = {}) => msg({ purpose: "THERAPIST_ALERT", recipientRule: "therapist", recipientToken: PERSON,
      channel: "TEAMS", templateId: "therapist.absence_alert", vars: { childFirstName: "Sam" }, tripLegId: null, therapySessionId: SESS, childToken: CHILD, ...o });
    beforeEach(async () => {
      await db.query(`INSERT INTO ops.therapist (id,site_id,person_token,display_name,created_by,updated_by) VALUES ($1,$2,$3,'SYN T1','t','t')`, [THER, SITE, PERSON]);
      await db.query(`INSERT INTO ops.therapy_session (id,site_id,therapist_id,child_token,starts_at,ends_at,created_by,updated_by)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour',now() + interval '2 hours','t','t')`, [SESS, SITE, THER, CHILD]);
    });
    it("enqueue rejects child data, a therapySessionId or a trip leg without a child reference", async () => {
      for (const o of [
        { tripLegId: null, childToken: null, templateId: "generic.notice", vars: {}, therapySessionId: SESS },
        { childToken: null },
        { tripLegId: null, childToken: null, templateId: "therapist.absence_alert", vars: {} },
      ] as Partial<EnqueueInput>[]) await expect(put(o)).rejects.toBeInstanceOf(ChildReferenceRequired);
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(0);
    });
    it("enqueue rejects a child reference that disagrees with the leg or session", async () => {
      await expect(put({ childToken: uuidv7() })).rejects.toBeInstanceOf(ChildReferenceRequired);
      await expect(db.tx((tx, ac) => enqueue(tx, ac, t, therapistAlert({ childToken: uuidv7() })))).rejects.toBeInstanceOf(ChildReferenceRequired);
    });
    it("non-child message (no child data) needs no child reference and sends", async () => {
      const { id } = await put({ tripLegId: null, childToken: null, templateId: "center.closure", vars: { date: "2026-10-14", reasonCode: "WEATHER" } });
      expect(await drain(db, id, deps)).toBe("SENT");
    });
    it("AT-14 therapist alert: sends while the therapist owns the child's session", async () => {
      const { id } = await db.tx((tx, ac) => enqueue(tx, ac, t, therapistAlert()));
      expect(await drain(db, id, deps)).toBe("SENT");
    });
    it("AT-14 therapist alert: session reassigned or canceled after enqueue → BLOCKED_EGRESS, not sent", async () => {
      const a = await db.tx((tx, ac) => enqueue(tx, ac, t, therapistAlert()));
      const OTHER = uuidv7();
      await db.query(`INSERT INTO ops.therapist (id,site_id,person_token,display_name,created_by,updated_by) VALUES ($1,$2,$3,'SYN T2','t','t')`, [OTHER, SITE, uuidv7()]);
      await db.query("UPDATE ops.therapy_session SET therapist_id = $1 WHERE id = $2", [OTHER, SESS]);
      expect(await drain(db, a.id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(a.id)).block_reason).toMatch(/not authorized for this child/);
      await db.query("UPDATE ops.therapy_session SET therapist_id = $1, status = 'CANCELED' WHERE id = $2", [THER, SESS]);
      const b = await db.tx((tx, ac) => enqueue(tx, ac, t, therapistAlert()));
      expect(await drain(db, b.id, deps)).toBe("BLOCKED_EGRESS");
      expect(p.sent.length).toBe(0);
    });
    it("a row with child data but no child reference (written around the guard) is blocked at send time", async () => {
      const { id } = await put({ tripLegId: null, childToken: null, templateId: "center.closure", vars: {} });
      await db.query(`UPDATE ops.outbound_message SET vars = '{"childFirstName":"Sam"}'::jsonb WHERE id = $1`, [id]);
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(id)).block_reason).toMatch(/vars not permitted for template center.closure/);
    });
    it("per-template allowlist: unknown template or any var off the template's list is rejected at enqueue", async () => {
      for (const o of [
        { tripLegId: null, childToken: null, templateId: "generic.notice", vars: { childFirstName: "Sam" } },
        { tripLegId: null, childToken: null, templateId: "center.closure", vars: { kidName: "Sam" } },
        { vars: { eta: "07:45", notes: "x" } },
        { tripLegId: null, childToken: null, templateId: "no.such.template", vars: {} },
      ] as Partial<EnqueueInput>[]) await expect(put(o)).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(0);
    });
    it("therapist path follows the recipient's actual type, not the recipient_rule string", async () => {
      // rule says guardian, token is a therapist → therapist check (owns the session) → sends
      const a = await db.tx((tx, ac) => enqueue(tx, ac, t, therapistAlert({ recipientRule: "guardian" })));
      expect(await drain(db, a.id, deps)).toBe("SENT");
      // rule says therapist, token is a guardian contact → guardian per-child check, not the therapist check
      const b = await put({ recipientRule: "therapist-on-duty", idempotencyKey: uuidv7() });
      expect(await drain(db, b.id, deps)).toBe("SENT");
      // and a therapist token on a rule that looks like a guardian cannot borrow guardian authorization once the session moves
      await db.query("UPDATE ops.therapy_session SET status = 'CANCELED' WHERE id = $1", [SESS]);
      const c = await db.tx((tx, ac) => enqueue(tx, ac, t, therapistAlert({ recipientRule: "guardian", idempotencyKey: uuidv7() })));
      expect(await drain(db, c.id, deps)).toBe("BLOCKED_EGRESS");
    });
  });

  // Veri #12 review: no free text in outbound vars — only fixed codes and constrained formats go out.
  describe("var value rules (Veri #12 review)", () => {
    const closure = (vars: Record<string, unknown>): Partial<EnqueueInput> =>
      ({ tripLegId: null, childToken: null, templateId: "center.closure", vars });
    it("reasonCode takes only the template's codes; free text in it is rejected at enqueue", async () => {
      for (const o of [
        closure({ date: "2026-10-14", reasonCode: "Sam B. is staying home" }),
        closure({ date: "2026-10-14", reasonCode: "weather" }), // codes are exact
        closure({ date: "2026-10-14", reasonCode: "VEHICLE_UNAVAILABLE" }), // the other template's enum
        closure({ date: "2026-10-14", reasonCode: "" }),
        closure({ date: "2026-10-14", reasonCode: 3 }),
        { vars: { legDate: "2026-10-14", reasonCode: "Sam's mum called" }, templateId: "leg.canceled" },
        { vars: { legDate: "2026-10-14", reasonCode: "HOLIDAY" }, templateId: "leg.canceled" }, // center.closure's enum
      ] as Partial<EnqueueInput>[]) await expect(put(o)).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(0);
      // the codes themselves are fine
      await put(closure({ date: "2026-10-14", reasonCode: "EMERGENCY" }));
      await put({ templateId: "leg.canceled", vars: { childFirstName: "Sam", legDate: "2026-10-14", reasonCode: "FAMILY_REQUEST" } });
    });
    it("generic.notice is fixed copy: any var at all is rejected", async () => {
      for (const vars of [{ text: "Sam B. will be collected at 4" }, { text: "" }, { date: "2026-10-14" }, { reasonCode: "WEATHER" }]) {
        await expect(put({ tripLegId: null, childToken: null, templateId: "generic.notice", vars })).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      }
      await put({ tripLegId: null, childToken: null, templateId: "generic.notice", vars: {} });
    });
    it("time, date and stop-label vars must match their format; childFirstName is bounded", async () => {
      for (const vars of [
        { eta: "SYN" }, { eta: "later today" }, { eta: "25:00" }, { eta: "7:45" }, { eta: 745 },
        { eta: "07:45", stopLabel: "the Henderson house" }, { eta: "07:45", stopLabel: "stop-1" },
        { eta: "07:45", childFirstName: "S".repeat(41) }, { eta: "07:45", childFirstName: " " },
      ]) await expect(put({ vars })).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      await expect(put({ tripLegId: null, childToken: null, templateId: "center.closure", vars: { date: "14/10/2026" } })).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(0);
      // valid shapes: HH:MM, ISO timestamp, YYYY-MM-DD, short stop token
      await put({ vars: { eta: "07:45", stopLabel: "STOP-12", childFirstName: "Sam" } });
      await put({ vars: { eta: "2026-10-14T07:45:00Z" } });
      await put(closure({ date: "2026-10-14" }));
    });
    // Veri FAILed the earlier "any non-blank string <= 40" rule: a full name must never ride out as a first name.
    it("childFirstName is one given-name token: a full name, a surname initial or a digit is rejected", async () => {
      const NBSP = String.fromCharCode(0xa0);
      for (const childFirstName of [
        "Mia Rivera", "Mia R.", "Mia R", "Mia  Rivera", "Mia\tRivera", `Mia${NBSP}Rivera`, // a surname or an initial, however spaced
        "", " ", "mia2", "M.", "Mia,", "Mia!", "Mia\n", "Mia_Rivera", "Mia.Rivera", // blank, digits, other punctuation
        "-Mia", "Mia-", "'Mia", "Mia'", "O''Hara", "Anne-Marie-Claire", "Anne--Marie", // one internal hyphen/apostrophe only
        "A".repeat(21), "S".repeat(41), // over-length
      ]) await expect(put({ vars: { eta: "07:45", childFirstName } })).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      for (const childFirstName of [7, null, ["Mia"], { first: "Mia" }]) {
        await expect(put({ vars: { eta: "07:45", childFirstName } })).rejects.toBeInstanceOf(TemplateVarNotAllowed);
      }
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(0);
      // accepted: a plain given name, one internal hyphen or apostrophe, non-ASCII letters, 1 and 20 chars
      const ok = ["Mia", "A", "Ng", "Anne-Marie", "D'Andre", "D’Andre", "José", "Łukasz", "Мария", "A".repeat(20)];
      for (const childFirstName of ok) await put({ vars: { eta: "07:45", childFirstName } });
      expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(ok.length);
    });
    it("a row edited around the guard to carry a full name is blocked at send time", async () => {
      const { id } = await put();
      await db.query(`UPDATE ops.outbound_message SET vars = '{"eta":"07:45","childFirstName":"Mia Rivera"}'::jsonb WHERE id = $1`, [id]);
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(id)).block_reason).toMatch(/vars not permitted for template pickup.eta/);
      expect((await st(id)).block_reason).not.toMatch(/Rivera/); // the rejected value is never echoed
      expect(p.sent.length).toBe(0);
    });
    it("childFirstName is listed only on child templates, and refused on any other template", () => {
      for (const [template, rules] of Object.entries(TEMPLATE_VARS)) {
        if (Object.hasOwn(rules, "childFirstName")) expect(CHILD_TEMPLATES.has(template)).toBe(true);
      }
      // and the name is refused on a non-child template independently of that table
      expect(disallowedVars("center.closure", { childFirstName: "Sam" })).toEqual(["childFirstName"]);
      expect(disallowedVars("pickup.eta", { childFirstName: "Sam" })).toEqual([]);
    });
    it("a row edited around the guard to carry free text is blocked at send time", async () => {
      const { id } = await put(closure({ date: "2026-10-14", reasonCode: "WEATHER" }));
      await db.query(`UPDATE ops.outbound_message SET vars = '{"date":"2026-10-14","reasonCode":"Sam B. is sick today"}'::jsonb WHERE id = $1`, [id]);
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(id)).block_reason).toMatch(/vars not permitted for template center.closure/);
      expect((await st(id)).block_reason).not.toMatch(/Sam/); // the rejected value is never echoed
      expect(p.sent.length).toBe(0);
    });
    it("a row edited around the guard to carry a bad eta is blocked at send time", async () => {
      const { id } = await put();
      await db.query(`UPDATE ops.outbound_message SET vars = '{"eta":"around four-ish, ask Sam"}'::jsonb WHERE id = $1`, [id]);
      expect(await drain(db, id, deps)).toBe("BLOCKED_EGRESS");
      expect((await st(id)).block_reason).toMatch(/vars not permitted for template pickup.eta/);
      expect(p.sent.length).toBe(0);
    });
  });
});
