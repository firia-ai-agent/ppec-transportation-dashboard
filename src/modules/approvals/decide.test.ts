/**
 * (d) The control case for the founder's 2026-10-17 rule: the model is **up**.
 *
 * The rule says a dead model must not be compensated for. Everything that proves it
 * (`agent/model-unavailable.test.ts`) asserts absences — no proposal, no ride change, nothing
 * sent — and absences are cheap to pass by accident. So this file drives the same family text
 * through the same loop with a model that answers, and asserts the **presences**: the requested
 * time arrives as structured output, it becomes a proposal and nothing else, a director or a
 * coordinator approving it moves the ride, and the front desk cannot.
 *
 * Together the two files pin the whole shape:
 *
 *  | the model | what the family's text produces |
 *  |---|---|
 *  | down | one staff alert, no proposal, no ride change, nothing sent |
 *  | up   | one proposal, no ride change *until a person approves*, nothing sent |
 *
 * Note what is the same in both rows: **no ride moves on the agent's say-so, ever**. That is
 * §11.2's human tier, and it is why "the assistant read it" and "the assistant could not read
 * it" differ in what a coordinator is shown and not in what the system did to the ride.
 *
 * The last suite is the one that would catch the keyword reader coming back in spirit rather
 * than in name: a model that answers in **prose** carrying "at 5" gets nowhere near the leg.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { Forbidden, SiteNotFound, Unauthenticated } from "@/auth/core";
import { rolesWhoCanOpen } from "@/auth/access";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { seedSecondSite, seedStaff } from "@/test/messaging";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import type { PolicyContext } from "@/modules/agent/policy";
import { freeText, toolCall } from "@/modules/agent/providers/fake";
import type { ProviderResponseBody } from "@/modules/agent/providers/provider";
import type { TierFacts } from "@/modules/agent/run/context";
import { type LiveHarness, liveHarness } from "@/modules/agent/run/exec/live-harness";
import { DROPOFF_CHANGE_TASK_CATEGORY } from "@/modules/agent/run/exec/proposals";
import type { Trigger } from "@/modules/agent/run/triggers";
import { MODEL_UNAVAILABLE_CATEGORY } from "@/modules/agent/staff-alert";
import { APPROVALS_PAGE, approvalRoles, canDecideApprovals, decide, pendingApprovals } from "./decide";

/** What the family wrote. The model is the only thing that may read a time out of it. */
const THEIR_WORDS = "can we do the afternoon drop at 5 today";
/** What a working model returns: the time as a **field**, not as a sentence. */
const REQUESTED_TIME = "17:00";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
  sc = await seedAgentScenario(db, { body: THEIR_WORDS, receivedAt: now });
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const childToken = () => sc.children[0];
const pmLeg = () => sc.legs[childToken()].PM;

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `leg=${pmLeg()} direction=PM version=1 service_date=${sc.serviceDate}`,
  t3: [THEIR_WORDS],
  t4: "channel=SMS locale=en-US",
});

const policy = (): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
});

const harness = (script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({ db, script, facts: facts(), policy: policy(), now: () => now });

/** The one tool call a model may make to ask for a different drop-off time. */
const proposeAtFive = (over: Record<string, unknown> = {}) =>
  toolCall("propose_dropoff_change", {
    child_token: childToken(),
    leg_id: pmLeg(),
    requested_dropoff_time: REQUESTED_TIME,
    plan_version_basis: 1,
    rationale_code: "FAMILY_REQUEST",
    ...over,
  });

const leg = async (id: string) => {
  const r = await db.query<{ id: string; window_start: Date | null; plan_version: number; state: string }>(
    "SELECT id, window_start, plan_version, state FROM ops.trip_leg WHERE id = $1",
    [id],
  );
  return r.rows[0];
};

const countOf = async (table: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`, [])).rows[0].n);

/* ────────────────── the model answers: a proposal, and the ride does not move ────────────────── */

describe("a model that reads the text proposes; it does not change the ride", () => {
  it("'at 5' as structured output becomes one approval request and moves nothing", async () => {
    const before = await leg(pmLeg());
    const h = harness([proposeAtFive()]);

    const run = await h.start(trigger());
    expect(run.state).toBe("SUCCEEDED");

    // One proposal, carrying the time exactly as the model's schema field held it.
    const pending = await pendingApprovals(db, [sc.siteId]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      legId: pmLeg(),
      childToken: childToken(),
      requestedTime: REQUESTED_TIME,
      planVersionBasis: 1,
    });

    // The exception row that puts it on the board — and no model-unavailable card, because the
    // model was available.
    const tasks = await db.query<{ category: string }>("SELECT category FROM ops.task", []);
    expect(tasks.rows.map((t) => t.category)).toEqual([DROPOFF_CHANGE_TASK_CATEGORY]);
    expect(tasks.rows.map((t) => t.category)).not.toContain(MODEL_UNAVAILABLE_CATEGORY);

    // And nothing happened to the ride or to anybody's phone.
    expect(await leg(pmLeg())).toEqual(before);
    expect(await countOf("ops.outbound_message")).toBe(0);
    expect(h.provider.sent).toEqual([]);
  });
});

/* ─────────────────────────── a person approves: now the ride moves ─────────────────────────── */

describe("approving is what moves the ride, and only two roles may", () => {
  /** Drive the run, then hand back the proposal a person now has to decide. */
  async function proposed() {
    const h = harness([proposeAtFive()]);
    await h.start(trigger());
    const [pending] = await pendingApprovals(db, [sc.siteId]);
    expect(pending).toBeDefined();
    return { h, pending };
  }

  it.each(["DIRECTOR", "COORDINATOR"] as const)("%s approving moves the leg and bumps the version", async (role) => {
    const { pending } = await proposed();
    const user = await seedStaff(db, role, sc.siteId);

    const result = await decide(db, {
      approvalId: pending.id,
      decision: "APPROVED",
      userId: user,
      by: `staff:${user}`,
    });

    expect(result).toEqual({ status: "APPLIED", legId: pmLeg(), planVersion: 2 });

    // The ride really moved: 17:00 on the leg's own service date, in the site's time zone.
    const after = await leg(pmLeg());
    expect(after.window_start).not.toBeNull();
    const localHour = new Date(after.window_start as Date).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    expect(localHour).toBe("17:00");

    // The proposal is decided, so it is no longer on the board.
    expect(await pendingApprovals(db, [sc.siteId])).toEqual([]);
    const task = await db.query<{ state: string }>("SELECT state FROM ops.task WHERE id = $1", [pending.taskId]);
    expect(task.rows[0].state).toBe("RESOLVED_APPROVED");

    // Approving a ride change is not a licence to text the family: queueing that confirmation is
    // named as a gap in this change's PR body, and until it lands nothing leaves the building.
    expect(await countOf("ops.outbound_message")).toBe(0);
  });

  it("the front desk cannot approve it, and the ride is untouched", async () => {
    const { pending } = await proposed();
    const before = await leg(pmLeg());
    const frontDesk = await seedStaff(db, "FRONT_DESK", sc.siteId);

    await expect(
      decide(db, { approvalId: pending.id, decision: "APPROVED", userId: frontDesk, by: "staff:fd" }),
    ).rejects.toBeInstanceOf(Forbidden);

    expect(await leg(pmLeg())).toEqual(before);
    // Still undecided: a refused decision is not a decision.
    expect(await pendingApprovals(db, [sc.siteId])).toHaveLength(1);
  });

  it("the roles come from the access table's /exceptions row, not from a list written here", () => {
    expect(approvalRoles()).toEqual(rolesWhoCanOpen(APPROVALS_PAGE));
    expect([...approvalRoles()].sort()).toEqual(["COORDINATOR", "DIRECTOR"]);
    expect(canDecideApprovals("DIRECTOR")).toBe(true);
    expect(canDecideApprovals("COORDINATOR")).toBe(true);
    expect(canDecideApprovals("FRONT_DESK")).toBe(false);
    expect(canDecideApprovals(null)).toBe(false);
  });

  it("a signed-out caller is unauthenticated, and another site's member gets a 404", async () => {
    const { pending } = await proposed();
    const before = await leg(pmLeg());

    await expect(
      decide(db, { approvalId: pending.id, decision: "APPROVED", userId: undefined, by: "anon" }),
    ).rejects.toBeInstanceOf(Unauthenticated);

    const otherSite = await seedSecondSite(db);
    const stranger = await seedStaff(db, "DIRECTOR", otherSite);
    // 404, not 403: a 403 would confirm that the id is real.
    await expect(
      decide(db, { approvalId: pending.id, decision: "APPROVED", userId: stranger, by: "staff:other" }),
    ).rejects.toBeInstanceOf(SiteNotFound);

    expect(await leg(pmLeg())).toEqual(before);
  });

  it("declining writes the decision and moves nothing", async () => {
    const { pending } = await proposed();
    const before = await leg(pmLeg());
    const user = await seedStaff(db, "COORDINATOR", sc.siteId);

    expect(
      await decide(db, { approvalId: pending.id, decision: "DECLINED", userId: user, by: `staff:${user}` }),
    ).toEqual({ status: "DECLINED" });

    expect(await leg(pmLeg())).toEqual(before);
    expect(await countOf("ops.outbound_message")).toBe(0);
  });

  it("the second coordinator to press is told it was already decided", async () => {
    const { pending } = await proposed();
    const a = await seedStaff(db, "COORDINATOR", sc.siteId);
    const b = await seedStaff(db, "DIRECTOR", sc.siteId);

    expect(await decide(db, { approvalId: pending.id, decision: "APPROVED", userId: a, by: "staff:a" })).toMatchObject(
      { status: "APPLIED" },
    );
    expect(await decide(db, { approvalId: pending.id, decision: "APPROVED", userId: b, by: "staff:b" })).toEqual({
      status: "ALREADY_DECIDED",
    });
    // Approved once, moved once.
    expect((await leg(pmLeg())).plan_version).toBe(2);
  });

  it("a plan that moved under the proposal writes nothing and stays decidable", async () => {
    const { pending } = await proposed();
    // Somebody corrected the ride by hand while the proposal was waiting (AT-08).
    await db.query("UPDATE ops.trip_leg SET plan_version = plan_version + 1 WHERE id = $1", [pmLeg()]);
    const before = await leg(pmLeg());
    const user = await seedStaff(db, "COORDINATOR", sc.siteId);

    expect(
      await decide(db, { approvalId: pending.id, decision: "APPROVED", userId: user, by: `staff:${user}` }),
    ).toEqual({ status: "STALE" });

    expect(await leg(pmLeg())).toEqual(before);
    // The decision rolled back with the write, so the coordinator can still decide it against
    // the plan as it now stands.
    expect(await pendingApprovals(db, [sc.siteId])).toHaveLength(1);
  });
});

/* ──────────────── free text cannot skip the approval, and cannot carry a time ──────────────── */

describe("free text in the family's message cannot skip approval", () => {
  it("a model that answers in prose is refused: no proposal, no ride change, nothing sent", async () => {
    const before = await leg(pmLeg());
    // The prose carries the answer the family asked for, times and all. §11.2 is "JSON-schema
    // tool calls only", so the gateway refuses it before the policy engine is even asked — which
    // is also why no amount of "at 5" in a family's own text can reach a leg.
    const h = harness([freeText("Sure — I've moved the drop-off to 5pm and told the driver.")]);

    const run = await h.start(trigger());

    expect(run.state).toBe("FAILED");
    expect(run.reason).toContain("gateway refused the turn");
    // And it is *not* read as the model being unavailable: a model that answered badly is not a
    // model that is down, so this raises no "needs a person" card either.
    expect(run.reason).not.toContain("model unavailable");

    expect(await pendingApprovals(db, [sc.siteId])).toEqual([]);
    expect(await countOf("ops.approval_request")).toBe(0);
    expect(await countOf("ops.task")).toBe(0);
    expect(await countOf("ops.outbound_message")).toBe(0);
    expect(await leg(pmLeg())).toEqual(before);
    expect(h.provider.sent).toEqual([]);
  });

  it("the family's own words are never the source of the time: only the schema field is", async () => {
    // The model asks for 08:15 while the family's text says "at 5". The proposal carries 08:15,
    // because the proposal is built from the validated arguments and from nothing else.
    const h = harness([proposeAtFive({ requested_dropoff_time: "08:15" })]);
    await h.start(trigger());

    const [pending] = await pendingApprovals(db, [sc.siteId]);
    expect(pending.requestedTime).toBe("08:15");
    expect(THEIR_WORDS).toContain("at 5");
  });
});
