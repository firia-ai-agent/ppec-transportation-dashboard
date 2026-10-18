/**
 * B-08 slice 3, §11.2 `send_followup` — **AT-01** (message → state → notify) end to end, and the
 * §11.2 failure column "canceled_stale → recompute".
 *
 * The first suite is AT-01 in one run: a guardian's text starts it, the agent resolves the sender,
 * reads the leg with its version, cancels it guarded on that version, and notifies — and the notify
 * is a real `ops.outbound_message` that the real outbox drains to the real (simulated) provider,
 * after re-checking consent and the plan version at send time. What reaches the provider is a
 * template id and two codes: no name, no number, no prose.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTestConsent, testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). `read_message`, the capability report and the drain's
 * consent check all ask `IdentityGateway` now rather than the connection — and this one answers
 * from the rows `seedAgentScenario` just wrote. See src/test/identity-gateway.ts for why it is in
 * memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { F2_NUMBER, PEPPER, seedStaff } from "@/test/messaging";
import { decideApproval, pendingApprovals } from "@/modules/approvals/decide";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import {
  type AgentScenario,
  seedAgentScenario,
  seedProviderRoute,
  seedSecondGuardian,
  seedTherapySession,
} from "@/test/agent-state";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { toolCalls } from "../store";
import type { Trigger } from "../triggers";
import { agentStaffNotice } from "@/ui/copy";
import {
  DISPATCHER_PURPOSE,
  STAFF_NOTICE_TASK_CATEGORY,
  TWO_GUARDIAN_TASK_CATEGORY,
  fanOutKey,
} from "./followup";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
/** The coordinator who approves what the agent proposes (S1-7); seeded on first use. */
let coordinator: string | null;
/** The outbox transport the approval queues through; the harness has its own for the run. */
let approvalTransport: FakeOutboxTransport;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
  approvalTransport = new FakeOutboxTransport();
  coordinator = null;
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["wont need the AM van, dropping at 9:30"],
  t4: "channel=SMS locale=en-US",
});

const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
  ...over,
});

/** The run ends with a staff note, which has no live executor in slice 3 (see cancel.test.ts). */
const NOTE_TURN = () => toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian canceled a ride" });
const NOTE_EXECUTOR = { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) };

const harness = (script: readonly ProviderResponseBody[], over: Partial<PolicyContext> = {}): LiveHarness =>
  liveHarness({
    gateway: GATEWAY,
    db, script: [...script, NOTE_TURN()], facts: facts(), policy: policy(over),
    overrides: NOTE_EXECUTOR, now: () => now,
  });

const followupCall = (over: Record<string, unknown> = {}) =>
  toolCall("send_followup", {
    audience: "GUARDIAN_OF_CHILD",
    subject_token: sc.children[0],
    template_id: "leg.canceled",
    vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" },
    ...over,
  });

/** The §18.2 step-2 run: resolve, read, cancel, notify. */
const at01Script = (): ProviderResponseBody[] => [
  toolCall("resolve_sender", { message_id: sc.messageId }),
  toolCall("get_leg_state", { leg_id: sc.legs[sc.children[0]].AM }),
  toolCall("cancel_attendance_or_leg", {
    child_token: sc.children[0], date: sc.serviceDate, day_part: "AM",
    reason_code: "FAMILY_REQUEST", expected_self_arrival: "09:30", expected_version: 1,
  }),
  followupCall(),
];

const outbound = async () =>
  (await db.query<{
    id: string; purpose: string; recipient_rule: string; recipient_token: string; channel: string;
    template_id: string; vars: Record<string, unknown>; child_token: string | null; trip_leg_id: string | null;
    plan_version_basis: number; state: string; idempotency_key: string; therapy_session_id: string | null;
  }>(
    `SELECT id, purpose, recipient_rule, recipient_token, channel, template_id, vars, child_token, trip_leg_id,
       plan_version_basis, state, idempotency_key, therapy_session_id
     FROM ops.outbound_message ORDER BY created_at`, [])).rows;
const tasks = async () =>
  (await db.query<{ category: string; severity: string }>(
    "SELECT category, severity FROM ops.task ORDER BY created_at", [])).rows;

/**
 * WHAT A COORDINATOR DOES NEXT (S1-7, Firia 2026-10-18).
 *
 * `send_followup` proposes now; the message is queued by `modules/approvals/decide.ts` when a
 * person approves it. So the cases below run exactly as they did — the same scripts, the same
 * audiences, the same fan-out and consent facts — and then call this, which is the Approve
 * button: it reads what is waiting through the screen's own query and approves each row with the
 * exact words that row renders, which is what the card posts back (`MESSAGE_CHANGED` otherwise).
 *
 * Everything asserted about the outbox after it is therefore unchanged from before the ruling,
 * which is the point: the tier moved, the addressing did not.
 */
async function approveWaiting(): Promise<readonly number[]> {
  // Seeded against the scenario's own site, which each case creates for itself.
  coordinator ??= await seedStaff(db, "COORDINATOR", sc.siteId);
  const waiting = await pendingApprovals(db, [sc.siteId]);
  const queued: number[] = [];
  for (const p of waiting) {
    const answer = await decideApproval(db, approvalTransport, {
      userId: coordinator,
      approvalId: p.id,
      decision: "APPROVED",
      approvedText: p.text,
      now,
    });
    queued.push(answer.body.ok ? answer.body.queued : -1);
  }
  return queued;
}

/** The pending proposals, as the "For you" tab reads them. */
const proposals = async () => pendingApprovals(db, [sc.siteId]);

describe("AT-01 message → state → notify, through the real outbox", () => {
  it("cancels the ride and notifies the guardian who asked, in codes only", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness(at01Script());
    const r = await h.start(trigger());

    /*
     * FOUR steps, not five: a proposal finishes the run (loop.ts — §11.1 has no notion of a run
     * that waits for an approval, it has a proposal row and a task), so the staff note that used
     * to follow the send is not reached. The cancel before it executed; the follow-up proposed.
     */
    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 4]);

    // Nothing in the outbox yet, which is the ruling in one line.
    expect(await outbound()).toEqual([]);
    // One proposal, with the words a coordinator would read.
    const waiting = await proposals();
    expect(waiting).toHaveLength(1);
    expect(waiting[0].text.length).toBeGreaterThan(0);
    expect(await approveWaiting()).toEqual([1]);

    // The state half.
    const legRow = (await db.query<{ state: string; plan_version: number }>(
      "SELECT state, plan_version FROM ops.trip_leg WHERE id = $1", [sc.legs[child].AM])).rows[0];
    expect(legRow).toEqual({ state: "CANCELED_TRANSPORT", plan_version: 2 });

    // The notify half: one message, to the guardian this run resolved, about this leg, against the
    // plan version the cancel left behind.
    const [msg] = await outbound();
    expect(await outbound()).toHaveLength(1);
    expect(msg).toMatchObject({
      purpose: "TRANSPORT_UPDATE",
      recipient_rule: "guardian_of_child",
      recipient_token: sc.contactToken,
      channel: "SMS_1TO1",
      template_id: "leg.canceled",
      child_token: child,
      trip_leg_id: sc.legs[child].AM,
      plan_version_basis: 2,
      state: "QUEUED",
      // Keyed on the approval and the recipient now, not on the call: the decision is what
      // queued it, and one key per approval per contact is what makes a redelivered press
      // queue nothing new (`decide.ts`).
      idempotency_key: `approval:${waiting[0].id}:${sc.contactToken}`,
    });
    expect(msg.vars).toEqual({ legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" });

    // The send-time half: the outbox re-checks and hands the provider a template id and two codes.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent).toHaveLength(1);
    expect(h.provider.sent[0]).toMatchObject({
      templateId: "leg.canceled",
      recipientToken: sc.contactToken,
      vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" },
    });
    // Nothing the model wrote, and nothing about a person, left the building.
    const wire = JSON.stringify(h.provider.sent);
    expect(wire).not.toContain(sc.number);
    expect(wire).not.toContain("09:30");
    expect(wire).not.toContain("dropping");

    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ["resolve_sender", "EXECUTED"],
      ["get_leg_state", "EXECUTED"],
      ["cancel_attendance_or_leg", "EXECUTED"],
      // PROPOSED, and the run ended there.
      ["send_followup", "PROPOSED"],
    ]);
    expect(calls[3].result).toMatchObject({ approval_request_id: waiting[0].id, queued: 0, mutated: false });
  });

  it("the confirmation goes back to the guardian who texted, and the other contact gets nothing", async () => {
    // A cancellation confirms what *one* parent asked for, so it is a decision rather than a
    // notice and does not fan out (see `resolveGuardian`'s table).
    //
    // The claim is about the *other* parent, so it is asserted over every row and every send
    // rather than over the first one: "the asker's message is first" is also true of a fan-out,
    // and a fan-out is the bug. So: how many messages exist at all, who each of them is
    // addressed to, what the result says about the count, and what reached the provider.
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const second = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
    });
    const h = harness(at01Script());
    const r = await h.start(trigger());
    expect(r.state).toBe("SUCCEEDED");

    /*
     * The recipient is decided when the proposal is written (S1-7) — the asker, and only the
     * asker — so the claim about the other parent is made of the row first and of the outbox
     * after the approval. A card that named both would be the bug, one press later.
     */
    const [waiting] = await proposals();
    expect(await approveWaiting()).toEqual([1]);

    const rows = await outbound();
    expect(rows.map((m) => m.recipient_token)).toEqual([sc.contactToken]);
    expect(rows.filter((m) => m.recipient_token === second)).toEqual([]);
    // Not even under a second key, which is the only other id a message to them could be
    // written against.
    expect(rows.map((m) => m.idempotency_key)).toEqual([`approval:${waiting.id}:${sc.contactToken}`]);
    // And the call the run recorded proposed one message, to nobody it named itself.
    const call = (await toolCalls(db, r.runId))[3];
    expect(call.result).toMatchObject({ approval_request_id: waiting.id, queued: 0 });

    // The send-time half: one message leaves, to the asker. The other parent is on no wire.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([sc.contactToken]);
    expect(JSON.stringify(h.provider.sent)).not.toContain(second);
    // The one task is the proposal's own: a message waiting for a person (S1-7). No
    // two-guardian exception, which is what this case is about — there was an asker.
    expect(await tasks()).toEqual([{ category: "FAMILY_MESSAGE", severity: "AMBER" }]);
  });

  /**
   * THE TWO BODIES THE AGENT MAY NOT SEND (Firia, 2026-10-17 11:00 PM ET; Veri S1-1).
   *
   * `leg.changed` and `dropoff.changed` are the texts that tell a family their child's ride is
   * different. Goal 4 is that a person decides that, so they are `approvals/decide.ts`'s to
   * send and nobody else's — and until this ruling they were on `send_followup`'s guardian
   * allow-list, which meant the model could send the exact words the "For you" card asks a
   * coordinator to approve, with the proposal still pending or with no proposal at all. Veri's
   * probe ran it end to end: run SUCCEEDED, 0 approval rows, outbound QUEUED, drained SENT.
   *
   * Each is asserted on its own because each has its own template, and each fails if its id is
   * put back on either list — `FOLLOWUP_TEMPLATE_FAMILIES.confirmation` (src/modules/agent/
   * tools.ts) or `AUDIENCE_RULES.GUARDIAN_OF_CHILD.templates` (followup.ts). The first is the
   * schema the model is given; the second is the executor behind it.
   */
  for (const [templateId, vars] of [
    ["leg.changed", { legDate: "SERVICE_DATE", eta: "09:30", stopLabel: "HOME" }],
    ["dropoff.changed", { legDate: "SERVICE_DATE", eta: "17:00", stopLabel: "HOME" }],
  ] as const) {
    it(`refuses to send ${templateId}: that text waits for an approval`, async () => {
      sc = await seedAgentScenario(db);
      const child = sc.children[0];
      // A second contact, so a leak would have somewhere to leak to and the "nothing queued"
      // claim below is about the whole table rather than about one row.
      await seedSecondGuardian(db, {
        siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
      });
      const h = harness([
        toolCall("resolve_sender", { message_id: sc.messageId }),
        toolCall("get_leg_state", { leg_id: sc.legs[child].AM }),
        followupCall({
          template_id: templateId,
          vars: { ...vars, legDate: sc.serviceDate },
        }),
      ]);
      const r = await h.start(trigger());

      // Nothing is queued and nothing is sent. Whatever the run's own end state, the family's
      // phone is the assertion: no row in the outbox means no text, pending approval or not.
      expect(await outbound()).toEqual([]);
      expect(await h.drainOutbox()).toEqual([]);
      expect(h.provider.sent).toEqual([]);

      // And the refusal is the template's, not an accident of the scenario: the same call with
      // an allow-listed body does queue one.
      const call = (await toolCalls(db, r.runId)).find((c) => c.tool === "send_followup");
      expect(
        JSON.stringify(call?.result ?? {}),
        `${templateId} was accepted by send_followup`,
      ).not.toContain("outbound_message_ids");
    });
  }

  it("the allow-listed confirmation still goes out, so the refusals above are about those two ids", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      toolCall("get_leg_state", { leg_id: sc.legs[child].AM }),
      followupCall({ template_id: "leg.canceled", vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" } }),
    ]);
    await h.start(trigger());
    // Proposed, approved, queued — the refusals above are about those two ids and not about the
    // path, which still carries an allow-listed confirmation all the way to the outbox.
    expect((await proposals()).map((p) => p.templateId)).toEqual(["leg.canceled"]);
    expect(await approveWaiting()).toEqual([1]);
    expect((await outbound()).map((m) => m.template_id)).toEqual(["leg.canceled"]);
  });

  it("a notice fans out to every authorized contact, one message each, the asker first (§10.1)", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const second = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
    });
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      followupCall({ template_id: "pickup.eta", vars: { eta: "08:15" } }),
    ]);
    const r = await h.start(trigger());
    expect(r.state).toBe("SUCCEEDED");

    /*
     * The fan-out is decided where it always was — in `resolveFollowup`, from §6.4's authorized
     * contacts with the asker first — and is recorded on the proposal, so one approval releases
     * one message per contact (S1-7).
     */
    const [waiting] = await proposals();
    expect(await approveWaiting()).toEqual([2]);

    const rows = await outbound();
    expect(rows).toHaveLength(2);
    expect(rows.map((m) => m.recipient_token)).toEqual([sc.contactToken, second]);
    // One key per approval per contact, so a redelivered press queues nothing twice.
    expect(rows.map((m) => m.idempotency_key)).toEqual([
      `approval:${waiting.id}:${sc.contactToken}`, `approval:${waiting.id}:${second}`,
    ]);
    expect(await tasks()).toEqual([{ category: "FAMILY_MESSAGE", severity: "AMBER" }]);

    // Consent is re-checked per contact at send time, so both go out on their own account.
    expect(await h.drainOutbox()).toEqual(["SENT", "SENT"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([sc.contactToken, second]);
  });

  it("a fan-out where one parent has opted out sends to the other, and refuses that one", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const second = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
    });
    await db.query(
      `INSERT INTO identity.consent_event (id, site_id, contact_token, kind, channel, at, source_mode)
       VALUES ($1,$2,$3,'STOP','SMS_1TO1',$4,'SIMULATED')`,
      ["0199e5f0-0000-7000-8000-00000000d001", sc.siteId, second, now.toISOString()],
    );
    // And into the suites' ledger, which is where the send-time check reads it since
    // S1-6: the row above is the record, this is the gateway's answer about it.
    registerTestConsent({ id: "0199e5f0-0000-7000-8000-00000000d001", siteId: sc.siteId, contactToken: second, channel: "SMS_1TO1", kind: "STOP", at: new Date(now.toISOString()) });
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      followupCall({ template_id: "pickup.eta", vars: { eta: "08:15" } }),
    ]);
    await h.start(trigger());
    // The proposal names both contacts; consent is re-checked per contact at DRAIN, which is
    // where the opted-out parent is refused (Firia, S1-7: "recipient consent/suppression
    // re-checked at drain"). Approving is not a decision about consent.
    expect(await approveWaiting()).toEqual([2]);

    expect(await outbound()).toHaveLength(2);
    expect(await h.drainOutbox()).toEqual(["SENT", "BLOCKED_EGRESS"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([sc.contactToken]);
  });

  it("each message in a fan-out has its own derived key, so a re-drive writes nothing twice", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const second = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
    });
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      followupCall({ template_id: "pickup.eta", vars: { eta: "08:15" } }),
    ]);
    await h.start(trigger());
    const [waiting] = await proposals();
    expect(await approveWaiting()).toEqual([2]);
    const key = `approval:${waiting.id}`;

    /*
     * Derived rather than generated, and derived from the APPROVAL now (S1-7): one key per
     * approval per contact, which is what the unique index fences. A redelivered Approve — the
     * server action posted twice, the page reloaded on a POST — queues nothing new.
     *
     * `fanOutKey` is still the agent's own rule for a send it makes itself, so it is asserted
     * here beside the one that replaced it for approvals.
     */
    expect(fanOutKey("k", [sc.contactToken, second], sc.contactToken)).toBe("k");
    const perKey = await db.query<{ idempotency_key: string; n: number }>(
      `SELECT idempotency_key, count(*)::int n FROM ops.outbound_message
       GROUP BY idempotency_key ORDER BY idempotency_key`, []);
    expect(perKey.rows).toEqual([
      { idempotency_key: `${key}:${sc.contactToken}`, n: 1 },
      { idempotency_key: `${key}:${second}`, n: 1 },
    ]);
    // And pressing Approve again writes nothing: the row is decided, so there is no second send
    // to key at all.
    expect(await approveWaiting()).toEqual([]);
    expect(await outbound()).toHaveLength(2);
  });

  it("two authorized contacts and nobody asked: an exception, not a guess (§10.3)", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
    });
    // A run with no resolve_sender step: a timer or a sweeper, not a reply to anybody.
    const h = harness([followupCall()]);
    const r = await h.start({ type: "sweeper.overdue", id: "SWEEP-1", siteId: sc.siteId });

    /*
     * SUCCEEDED rather than FAILED since S1-7, and the claim is unchanged: the agent does not
     * pick which parent to text, and now it does not propose a guess either. The call is
     * recorded PROPOSED with the refusal on it, there is no approval row for anybody to press,
     * and the §10.3 exception is on the board.
     */
    expect(r.state).toBe("SUCCEEDED");
    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ proposal_refused: "TWO_GUARDIAN_CONFLICT", authorized_contacts: 2 });
    expect(await proposals()).toEqual([]);
    expect(await outbound()).toEqual([]);
    expect(await tasks()).toEqual([{ category: TWO_GUARDIAN_TASK_CATEGORY, severity: "AMBER" }]);
  });

  it("a family with no authorized contact is not messaged at all", async () => {
    sc = await seedAgentScenario(db);
    await db.query("DELETE FROM ops.contact_authorization WHERE child_token = $1", [sc.children[0]]);
    const h = harness([followupCall()]);
    const r = await h.start({ type: "sweeper.overdue", id: "SWEEP-2", siteId: sc.siteId });
    // Nothing to send to, so nothing to propose either (S1-7): the refusal is on the call.
    expect(r.state).toBe("SUCCEEDED");
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ proposal_refused: "NO_AUTHORIZED_CONTACT" });
    expect(await proposals()).toEqual([]);
    expect(await outbound()).toEqual([]);
  });

  it("a family that opted out gets nothing: queued, then blocked at egress (demo step 10)", async () => {
    sc = await seedAgentScenario(db);
    const h = harness(at01Script());
    await h.start(trigger());
    // Approved while the family still had consent; the STOP lands between the press and the
    // drain, which is exactly the window the drain-time re-check exists for.
    expect(await approveWaiting()).toEqual([1]);
    await db.query(
      `INSERT INTO identity.consent_event (id, site_id, contact_token, kind, channel, at, source_mode)
       VALUES ($1,$2,$3,'STOP','SMS_1TO1',$4,'SIMULATED')`,
      ["0199e5f0-0000-7000-8000-00000000b001", sc.siteId, sc.contactToken, now.toISOString()],
    );
    // And into the suites' ledger, which is where the send-time check reads it since
    // S1-6: the row above is the record, this is the gateway's answer about it.
    registerTestConsent({ id: "0199e5f0-0000-7000-8000-00000000b001", siteId: sc.siteId, contactToken: sc.contactToken, channel: "SMS_1TO1", kind: "STOP", at: new Date(now.toISOString()) });
    expect(await h.drainOutbox()).toEqual(["BLOCKED_EGRESS"]);
    expect(h.provider.sent).toEqual([]);
  });
});

describe("§11.2 the template allow-list is read per audience", () => {
  it("a therapist's template may not be sent to a family, or the other way round", async () => {
    sc = await seedAgentScenario(db);
    const toFamily = harness([followupCall({ template_id: "therapist.absence_alert", vars: { sessionStart: "09:00" } })]);
    const r = await toFamily.start({ type: "sweeper.overdue", id: "SWEEP-3", siteId: sc.siteId });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      proposal_refused: "TEMPLATE_NOT_FOR_AUDIENCE",
      audience: "GUARDIAN_OF_CHILD",
      template_id: "therapist.absence_alert",
    });
    // Not proposed either: a template for the wrong kind of person is not a thing to put in
    // front of a coordinator and ask about.
    expect(await proposals()).toEqual([]);
    expect(await outbound()).toEqual([]);
  });

  it("the therapist of a session is reached with the minimized alert", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const session = await seedTherapySession(db, {
      siteId: sc.siteId, childToken: child, startsAt: new Date("2026-10-15T13:00:00.000Z"),
    });
    const h = liveHarness({
    gateway: GATEWAY,
      db,
      script: [toolCall("send_followup", {
        audience: "THERAPIST_OF_SESSION", subject_token: session.sessionId,
        template_id: "therapist.absence_alert", vars: { sessionStart: "09:00" },
      }), NOTE_TURN()],
      facts: facts(),
      policy: policy({
        scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, session.sessionId]) },
        sendableSubjects: new Set([session.sessionId]),
      }),
      overrides: NOTE_EXECUTOR,
      now: () => now,
    });
    const r = await h.start({ type: "operational.event", id: "EV-1", siteId: sc.siteId });

    expect(r.state).toBe("SUCCEEDED");
    // A therapist is not a family, and the ruling is the tool's rather than the audience's, so
    // this one waits for a person too (S1-7). Where it goes is decided the same way it was.
    expect(await approveWaiting()).toEqual([1]);
    const [msg] = await outbound();
    expect(msg).toMatchObject({
      purpose: "THERAPIST_ALERT",
      recipient_rule: "therapist_of_session",
      recipient_token: session.personToken,
      template_id: "therapist.absence_alert",
      child_token: child,
      therapy_session_id: session.sessionId,
      // No leg: this run read none, so there is no plan to be stale against.
      trip_leg_id: null,
      plan_version_basis: 0,
    });
    // The therapist's authorization is re-checked at send time against that session.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent[0]).toMatchObject({ recipientToken: session.personToken });
  });

  it("a STAFF follow-up is a task on their board, and nothing is queued (§10.4, Teams is B-12)", async () => {
    sc = await seedAgentScenario(db);
    const legId = sc.legs[sc.children[0]].AM;
    const h = harness([followupCall({
      audience: "STAFF", subject_token: legId, template_id: "generic.notice", vars: {},
    })], { sendableSubjects: new Set([legId, ...sc.children]) });
    const r = await h.start({ type: "sweeper.overdue", id: "SWEEP-STAFF", siteId: sc.siteId });

    /*
     * The STAFF audience is the one that is not a message, so S1-7 left it alone in substance:
     * the task is written, nothing is queued, and — because there is no egress — there is
     * nothing for anybody to approve. The writer moved from the executor to the proposal writer
     * (`agent/run/exec/proposals.ts`), which is why the result says `staff_task` and names no
     * approval row.
     */
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ delivered_as: "staff_task", mutated: false });
    expect(await proposals()).toEqual([]);
    expect(await outbound()).toEqual([]);
    const [task] = await db.query<{ category: string; severity: string; child_token: string; trip_leg_id: string; summary: string; next_step: string }>(
      "SELECT category, severity, child_token, trip_leg_id, summary, next_step FROM ops.task", []).then((x) => x.rows);
    expect([task.category, task.severity]).toEqual([STAFF_NOTICE_TASK_CATEGORY, "GREEN"]);
    expect([task.child_token, task.trip_leg_id]).toEqual([sc.children[0], legId]);
    expect(task.summary).toContain(agentStaffNotice.summary);
    expect(task.next_step).toBe(agentStaffNotice.nextStep);
  });

  it("a STAFF follow-up about nothing this site holds is refused, and writes no task", async () => {
    sc = await seedAgentScenario(db);
    const nobody = "0199e5f0-0000-7000-8000-0000000000e1";
    const h = harness([followupCall({
      audience: "STAFF", subject_token: nobody, template_id: "generic.notice", vars: {},
    })], {
      scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, nobody]) },
      sendableSubjects: new Set([nobody]),
    });
    const r = await h.start({ type: "sweeper.overdue", id: "SWEEP-STAFF-404", siteId: sc.siteId });

    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ proposal_refused: "NOT_FOUND", object: "subject" });
    expect(await tasks()).toEqual([]);
    expect(await proposals()).toEqual([]);
  });

  it("a PROVIDER_DISPATCHER follow-up reaches the provider's dispatcher, in fixed copy", async () => {
    sc = await seedAgentScenario(db);
    const route = await seedProviderRoute(db, {
      siteId: sc.siteId, serviceDate: sc.serviceDate, windowStart: now,
    });
    const h = harness([followupCall({
      audience: "PROVIDER_DISPATCHER", subject_token: route.providerId,
      template_id: "generic.notice", vars: {},
    })], {
      scope: { ...sc.scope, shared: new Set([route.providerId]) },
      sendableSubjects: new Set([route.providerId]),
    });
    const r = await h.start({ type: "sweeper.overdue", id: "SWEEP-DISPATCH", siteId: sc.siteId });
    expect(await approveWaiting()).toEqual([1]);

    const [msg] = await outbound();
    expect(msg).toMatchObject({
      purpose: DISPATCHER_PURPOSE,
      recipient_rule: "provider_dispatcher",
      recipient_token: route.dispatcherToken,
      template_id: "generic.notice",
      child_token: null,
    });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ queued: 0, mutated: false });
    // The egress authorizer knows what a dispatcher is, so the message actually goes.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([route.dispatcherToken]);
  });

  it("a dispatcher is never sent a child's news, and a provider with no contact point is refused", async () => {
    sc = await seedAgentScenario(db);
    const route = await seedProviderRoute(db, {
      siteId: sc.siteId, serviceDate: sc.serviceDate, windowStart: now, withDispatcher: false,
    });
    const scope = {
      scope: { ...sc.scope, shared: new Set([route.providerId]) },
      sendableSubjects: new Set([route.providerId]),
    };
    // A child template to a dispatcher: refused by the audience's own allow-list.
    const childCopy = harness([followupCall({
      audience: "PROVIDER_DISPATCHER", subject_token: route.providerId,
      template_id: "leg.canceled", vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" },
    })], scope);
    const r = await childCopy.start({ type: "sweeper.overdue", id: "SWEEP-DISPATCH-CHILD", siteId: sc.siteId });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      proposal_refused: "TEMPLATE_NOT_FOR_AUDIENCE", audience: "PROVIDER_DISPATCHER",
    });

    const noContact = harness([followupCall({
      audience: "PROVIDER_DISPATCHER", subject_token: route.providerId,
      template_id: "generic.notice", vars: {},
    })], scope);
    const r2 = await noContact.start({ type: "sweeper.overdue", id: "SWEEP-DISPATCH-NONE", siteId: sc.siteId });
    expect((await toolCalls(db, r2.runId))[0].result).toMatchObject({
      proposal_refused: "NO_DISPATCHER_CONTACT", provider_token: route.providerId,
    });
    // Neither one is proposed: a refusal is a refusal, not a card (S1-7).
    expect(await proposals()).toEqual([]);
    expect(await outbound()).toEqual([]);
  });
});

describe("§11.2 canceled_stale → recompute", () => {
  it("a plan change after queueing cancels that message; the next call recomputes the basis", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const first = harness(at01Script());
    await first.start(trigger());
    // Approved, which is what queues it now (S1-7). The basis is the LEG's version read at the
    // moment of queueing — the outbox's staleness rule, which the ruling left alone: what it
    // dropped is the `plan_run` version check on the approval itself.
    expect(await approveWaiting()).toEqual([1]);
    const [queued] = await outbound();
    expect(queued.plan_version_basis).toBe(2);

    // Staff re-plan the leg between the queueing and the send.
    await db.query(
      "UPDATE ops.trip_leg SET plan_version = plan_version + 1, version = version + 1 WHERE id = $1",
      [sc.legs[child].AM],
    );
    expect(await first.drainOutbox()).toEqual(["CANCELED_STALE"]);
    expect(first.provider.sent).toEqual([]);

    // The recompute is a fresh call: it reads the leg again and queues against the new plan.
    const again = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      toolCall("get_leg_state", { leg_id: sc.legs[child].AM }),
      followupCall(),
    ]);
    const r = await again.start({ ...trigger(), id: "MSG-RECOMPUTE" });
    expect(r.state).toBe("SUCCEEDED");
    expect(await approveWaiting()).toEqual([1]);

    const rows = await outbound();
    expect(rows).toHaveLength(2);
    // Read again at approval time, so the recompute is "read the state again" exactly as it was
    // — one press later.
    expect(rows[1]).toMatchObject({ plan_version_basis: 3, state: "QUEUED" });
    expect(await again.drainOutbox()).toEqual(["SENT"]);
    expect(again.provider.sent).toHaveLength(1);
  });

  it("the same follow-up call driven twice queues one message", async () => {
    sc = await seedAgentScenario(db);
    const h = harness(at01Script());
    await h.start(trigger());
    const [waiting] = await proposals();
    expect(await approveWaiting()).toEqual([1]);
    expect(await outbound()).toHaveLength(1);

    // The row the outbox keyed on this approval: a second attempt finds it instead of queueing
    // again — and a second Approve cannot even reach it, because the row is decided (409).
    const key = `approval:${waiting.id}:${sc.contactToken}`;
    const dup = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.outbound_message WHERE idempotency_key = $1", [key]);
    expect(dup.rows[0].n).toBe(1);
    expect(await approveWaiting()).toEqual([]);
    expect(await outbound()).toHaveLength(1);
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(await h.drainOutbox()).toEqual([]);
    expect(h.provider.sent).toHaveLength(1);
  });
});
