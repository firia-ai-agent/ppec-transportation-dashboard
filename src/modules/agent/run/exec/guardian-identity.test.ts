/**
 * B-08, the guardian-identity guards in front of a §11.2 write and in front of a §11.2 send — one
 * test per way somebody can fail to be a guardian of the child a run is about.
 *
 * AT-06's "two siblings on one number" (cancel.test.ts) is about an *authorized* contact the center
 * cannot place; these are the three cases where the contact is not authorized at all, and each of
 * them has its own row — or missing row — in `ops.contact_authorization` (§6.4: a phone match is
 * recognized, not authorized):
 *
 * | | the state | what must happen |
 * |---|---|---|
 * | an unauthorized asker | a contact point on file, authorized for no child | refused; nothing moves, nothing is sent |
 * | an expired guardian | an authorization whose window closed before the message | the same: a lapsed row is no row |
 * | a third guardian | on file for the family, listed on this child's authorization by nobody | the same, and they are in no fan-out either |
 *
 * Two layers, because the guard exists at both and a test that only drove the loop would not say
 * which one refused: `resolve_sender` (reads.ts) will not call such a sender resolved, and
 * `cancel_attendance_or_leg` (cancel.ts) refuses on the facts that run committed even when the
 * arguments it was handed look perfect. The last test is the send side: `send_followup` computes
 * its recipients from the same table, so a lapsed or unlisted contact is not a recipient.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). `read_message`, the capability report and the drain's
 * consent check all ask `IdentityGateway` now rather than the connection — and this one answers
 * from the rows `seedAgentScenario` just wrote. See src/test/identity-gateway.ts for why it is in
 * memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { phoneHmac } from "@/modules/identity/phone";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { F2_NUMBER, PEPPER } from "@/test/messaging";
import {
  type AgentScenario,
  seedAgentScenario,
  seedInbound,
  seedSecondGuardian,
} from "@/test/agent-state";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import type { ToolExecution } from "../executors";
import { type CommittedCall, toolCalls } from "../store";
import type { Trigger } from "../triggers";
import { cancelAttendanceOrLegExecutor } from "./cancel";
import { UNKNOWN_SENDER_TASK_CATEGORY } from "./reads";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
const open: PGlite[] = [];

/** F4's persona phone: a third contact point, used by no other fixture in this suite. */
const F4_NUMBER = "+15615550104";

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["can you cancel the AM van"],
  t4: "channel=SMS locale=en-US",
});

/** The run ends with a staff note, which has no live executor in this slice (see cancel.test.ts). */
const NOTE_TURN = () => toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian asked about a ride" });
const NOTE_EXECUTOR = { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) };

/**
 * A harness whose trigger message may be one this scenario did not seed — a message from a contact
 * point other than the family's own — so the message id is added to the scope the way a session
 * would have built it, and never from a tool argument.
 */
const harness = (script: readonly ProviderResponseBody[], messageId = sc.messageId): LiveHarness => {
  const policy: PolicyContext = {
    scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, messageId]) },
    sendableSubjects: new Set([sc.threadId, ...sc.children]),
    sourceMessageId: messageId,
  };
  return liveHarness({
    gateway: GATEWAY,
    db, script: [...script, NOTE_TURN()], facts: facts(), policy,
    overrides: NOTE_EXECUTOR, now: () => now,
  });
};

const trigger = (messageId = sc.messageId): Trigger => ({ type: "msg.inbound", id: messageId, siteId: sc.siteId });

/** The §11.1 shape of the run under test: resolve the sender, then try to cancel the AM leg. */
const askToCancel = (messageId = sc.messageId): ProviderResponseBody[] => [
  toolCall("resolve_sender", { message_id: messageId }),
  toolCall("cancel_attendance_or_leg", {
    child_token: sc.children[0],
    date: sc.serviceDate,
    day_part: "AM",
    reason_code: "FAMILY_REQUEST",
    expected_self_arrival: null,
    expected_version: 1,
  }),
];

const leg = async (id: string) =>
  (await db.query<{ state: string; version: number; plan_version: number }>(
    "SELECT state, version, plan_version FROM ops.trip_leg WHERE id = $1", [id])).rows[0];
const attendance = async (childToken: string) =>
  (await db.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.attendance_day WHERE child_token = $1", [childToken])).rows[0];
const exceptions = async () =>
  (await db.query<{ child_token: string }>("SELECT child_token FROM ops.attendance_exception", [])).rows;
const outbound = async () =>
  (await db.query<{ recipient_token: string; template_id: string; state: string }>(
    "SELECT recipient_token, template_id, state FROM ops.outbound_message ORDER BY created_at", [])).rows;
const tasks = async () =>
  (await db.query<{ category: string; severity: string }>(
    "SELECT category, severity FROM ops.task ORDER BY created_at", [])).rows;

/** Every leg and day of this scenario, exactly as seeded: the "nothing moved" assertion. */
const nothingMoved = async () => {
  for (const child of sc.children) {
    expect(await attendance(child)).toEqual({ state: "SCHEDULED", version: 1 });
    expect(await leg(sc.legs[child].AM)).toEqual({ state: "SCHEDULED", version: 1, plan_version: 1 });
    expect(await leg(sc.legs[child].PM)).toEqual({ state: "SCHEDULED", version: 1, plan_version: 1 });
  }
  expect(await exceptions()).toEqual([]);
};

/** One inbound message from a contact point of our choosing, in the family's thread. */
const messageFrom = (number: string): Promise<string> =>
  seedInbound(db, {
    siteId: sc.siteId,
    threadId: sc.threadId,
    fromHmac: phoneHmac(number, PEPPER),
    body: "can you cancel the AM van",
    receivedAt: now,
  });

describe("an unauthorized asker is not an asker: no write, no send", () => {
  it("a recognized contact point authorized for no child cannot have a ride canceled", async () => {
    sc = await seedAgentScenario(db);
    // Recognized — the number is still on file — and authorized for nobody (§6.4).
    await db.query("DELETE FROM ops.contact_authorization WHERE contact_token = $1", [sc.contactToken]);
    const h = harness(askToCancel());
    const r = await h.start(trigger());

    // The run ends on the read: there is no authority for the cancel to take, so it is never asked
    // for. One tool call, and it is not the write.
    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([["resolve_sender", "EXECUTED"]]);
    expect(calls[0].result).toMatchObject({ sender_known: false, reason_code: "NOT_AUTHORIZED" });
    await nothingMoved();
    // The one row this refusal writes is the staff question, and it is not a message.
    expect(await tasks()).toEqual([{ category: UNKNOWN_SENDER_TASK_CATEGORY, severity: "AMBER" }]);
    expect(await outbound()).toEqual([]);
    expect(await h.drainOutbox()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
  });

  it("the cancel executor refuses on the facts that run committed, not on the arguments it was handed", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    // The arguments of a perfectly good cancel, behind a `resolve_sender` that resolved nobody:
    // the model asserting authority it was not given is the case this guard is for.
    const unresolved: CommittedCall = {
      seq: 0,
      tool: "resolve_sender",
      status: "EXECUTED",
      argsHash: "",
      promptFacts: { sender_known: false, reason_code: "NOT_AUTHORIZED" },
    };
    const r: ToolExecution = await cancelAttendanceOrLegExecutor(harness([]).execDeps)({
      runId: "0199e5f0-0000-7000-8000-00000000f001",
      callId: "0199e5f0-0000-7000-8000-00000000f002",
      siteId: sc.siteId,
      seq: 1,
      tool: "cancel_attendance_or_leg",
      args: {
        child_token: child, date: sc.serviceDate, day_part: "AM",
        reason_code: "FAMILY_REQUEST", expected_self_arrival: null, expected_version: 1,
      },
      idempotencyKey: "agent:unauthorized:1",
      trigger: trigger(),
      now,
      committed: [unresolved],
    });

    expect(r.status).toBe("failed");
    expect(r.data).toEqual({ error_code: "UNVERIFIED_GUARDIAN", reason_code: "SENDER_UNKNOWN" });
    await nothingMoved();
    expect(await outbound()).toEqual([]);
  });
});

describe("an expired guardian is no guardian: no write, no send", () => {
  it("an authorization that closed before the message was received does not authorize it", async () => {
    sc = await seedAgentScenario(db);
    // The window the §6.4 lookup reads is the message's own arrival time, so a row that lapsed an
    // hour before it is not a row this message can be asked under.
    await db.query(
      "UPDATE ops.contact_authorization SET valid_to = $2 WHERE contact_token = $1",
      [sc.contactToken, new Date(now.getTime() - 3_600_000).toISOString()],
    );
    const h = harness(askToCancel());
    const r = await h.start(trigger());

    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([["resolve_sender", "EXECUTED"]]);
    expect(calls[0].result).toMatchObject({ sender_known: false, reason_code: "NOT_AUTHORIZED" });
    await nothingMoved();
    expect(await tasks()).toEqual([{ category: UNKNOWN_SENDER_TASK_CATEGORY, severity: "AMBER" }]);
    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
  });
});

describe("a third guardian nobody listed: no write, no send, and no fan-out", () => {
  it("a contact on file for the family but on no authorization list may not ask", async () => {
    sc = await seedAgentScenario(db);
    // On file as a guardian contact of this family — so the contact point resolves — and listed on
    // no child's authorization, which is the whole difference between recognized and authorized.
    const third = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: sc.children[0], number: F4_NUMBER, now: sc.receivedAt,
    });
    await db.query("DELETE FROM ops.contact_authorization WHERE contact_token = $1", [third]);
    const messageId = await messageFrom(F4_NUMBER);
    const h = harness(askToCancel(messageId), messageId);
    const r = await h.start(trigger(messageId));

    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([["resolve_sender", "EXECUTED"]]);
    expect(calls[0].result).toMatchObject({ sender_known: false, reason_code: "NOT_AUTHORIZED" });
    await nothingMoved();
    expect(await tasks()).toEqual([{ category: UNKNOWN_SENDER_TASK_CATEGORY, severity: "AMBER" }]);
    expect(await outbound()).toEqual([]);
    expect(h.provider.sent).toEqual([]);
  });

  it("and is in no fan-out either: a notice reaches the contacts this child's row lists, and them only", async () => {
    // Two children, so the third contact can be authorized for the *sibling* and for nobody else:
    // §6.4 is per child, and a contact authorized for one child is a stranger to the other.
    sc = await seedAgentScenario(db, { children: 2 });
    const [child, sibling] = sc.children;
    const lapsed = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: child, number: F2_NUMBER, now: sc.receivedAt,
    });
    await db.query(
      "UPDATE ops.contact_authorization SET valid_to = $2 WHERE contact_token = $1",
      [lapsed, new Date(now.getTime() - 3_600_000).toISOString()],
    );
    const siblingOnly = await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: sibling, number: F4_NUMBER, now: sc.receivedAt,
    });

    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      toolCall("send_followup", {
        audience: "GUARDIAN_OF_CHILD", subject_token: child,
        template_id: "pickup.eta", vars: { eta: "08:15" },
      }),
    ]);
    const r = await h.start(trigger());
    expect(r.state).toBe("SUCCEEDED");

    // A notice does fan out (§10.1), which is what makes this the sharp test: the only reason
    // either of these two gets nothing is that this child's authorization does not list them now.
    const rows = await outbound();
    expect(rows.map((m) => m.recipient_token)).toEqual([sc.contactToken]);
    expect(rows.filter((m) => m.recipient_token === lapsed || m.recipient_token === siblingOnly)).toEqual([]);
    expect((await toolCalls(db, r.runId))[1].result).toMatchObject({ recipients: 1 });

    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([sc.contactToken]);
    const wire = JSON.stringify(h.provider.sent);
    expect(wire).not.toContain(lapsed);
    expect(wire).not.toContain(siblingOnly);
    expect(await tasks()).toEqual([]);
  });
});
