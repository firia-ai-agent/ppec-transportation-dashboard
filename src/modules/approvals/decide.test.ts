/**
 * SURF-05's decision, against a real database (demo item 2a; PRD §18.2 steps 9–10, §11.2 human
 * tier; AT-01, AT-09).
 *
 * The §11.2 human tier had no human in it: `agent/run/exec/proposals.ts` has written
 * `ops.approval_request` rows since B-08 slice 4 and its own header said what was missing — "the
 * approval *surface* that would turn a decision into an applied change". So a proposal was a row
 * nobody could say yes to. This is the suite for the yes, and for every way it must say no.
 *
 * The two Veri asked for by name come first, because they are the ones that matter:
 *
 *  - **a parent session is refused.** A family holds no console account at all in P1, so "a
 *    parent" is a caller with no staff role — signed out, or signed in with no membership
 *    anywhere. Both are refused, and so is a staff role the page's row omits, because a role that
 *    may not *read* this screen may certainly not decide on it.
 *  - **another site's proposal id is refused**, as a uniform not-found, exactly as an id that
 *    exists nowhere. A 403 there would confirm the id is real, which is the ID-swap rule
 *    (BUILD-PLAN §4: another site is a 404, not a 403).
 *
 * Then what approving actually does, which is three writes in one transaction, and the three ways
 * it refuses to do them: a decision already made, a plan that moved underneath it, and a time that
 * is not a time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { ALL_STAFF, APPROVAL_ROLES } from "@/auth/access";
import { demoChildToken, demoLegId } from "@/modules/demo/fixtures/standard";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { TEST_NOW } from "@/test/clock";
import { seedPersona, seedStaff } from "@/test/messaging";
import { freshDb, ORG, SITE } from "@/test/pglite";
import { decideApproval, pendingApprovals } from "./decide";
import type { PlanPlacementPortFor, SetChildPlacementInput } from "./plan-placement-port";

let pg: PGlite;
let db: Db;
let transport: FakeOutboxTransport;
/** The coordinator who decides, and the child whose ride the proposal is about. */
let coordinator: string;
let childToken: string;
let legId: string;

/** The other tenant, for the ID-swap row. Seeded here, as `idswap.test.ts` seeds its own. */
const SITE_B = "00000000-0000-7000-8000-00000000000b";

const CHILD_KEY = "C2";
const SERVICE_DATE = "2026-10-14";

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  transport = new FakeOutboxTransport();
  placements = [];
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
  await db.query(
    `INSERT INTO ops.site (id, org_id, name, depot_lat, depot_lng, created_by, updated_by)
     VALUES ($1, $2, 'SYN Second Site', 26.645352, -80.145541, 'test', 'test')`,
    [SITE_B, ORG],
  );

  // One family, one child, one afternoon leg — the shape a drop-off proposal is about.
  const persona = await seedPersona(db, "+15615550102", { siteId: SITE, now: TEST_NOW });
  childToken = demoChildToken(CHILD_KEY);
  legId = demoLegId(CHILD_KEY, "PM");
  await db.query(
    `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
     VALUES ($1, $2, $3, 'Noah O.', 'test', 'test')`,
    [childToken, SITE, persona.familyGroupId],
  );
  await db.query(
    `INSERT INTO ops.contact_authorization (id, site_id, contact_token, child_token, scope, channel, valid_from, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'RECEIVE_TRANSPORT_UPDATES', 'SMS_1TO1', $5, 'test', 'test')`,
    [uuidv7(), SITE, persona.contactToken, childToken, new Date(TEST_NOW.getTime() - 86_400_000).toISOString()],
  );
  await db.query(
    `INSERT INTO ops.trip_leg (id, site_id, child_token, service_date, direction, mode, state, plan_version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'PM', 'PROVIDER', 'SCHEDULED', 1, 'test', 'test')`,
    [legId, SITE, childToken, SERVICE_DATE],
  );
}, 60_000);

afterEach(async () => {
  await pg.close();
});

/** A proposal row of the shape `proposals.dropoffChange` writes, at a site of our choosing. */
async function seedProposal(
  over: { siteId?: string; legId?: string; planVersionBasis?: number; time?: string | null } = {},
): Promise<string> {
  const siteId = over.siteId ?? SITE;
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, 'PLAN_CHANGE', 'AMBER', 'OPEN', 'A family asked for a different drop-off',
       'Read the text, then decide', 'the drop-off approved or declined', 'test', 'test', 'SIMULATED')`,
    [taskId, siteId],
  );
  const id = uuidv7();
  const time = over.time === undefined ? "17:00" : over.time;
  await db.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'SIMULATED')`,
    [
      id,
      siteId,
      taskId,
      JSON.stringify({
        kind: "DROPOFF_CHANGE",
        leg_id: over.legId ?? legId,
        child_token: childToken,
        service_date: SERVICE_DATE,
        direction: "PM",
        /*
         * `plan_run.version` — the counter the board guards and the one `decideApproval` checks
         * (Firia's S1-3, 2026-10-17 11:00 PM ET). The fake port below answers version 7, so 7
         * is "the plan this proposal was computed against" and anything else is a stale one.
         */
        plan_run_version_basis: over.planVersionBasis ?? FAKE_PLAN_VERSION,
        requested_dropoff_time: time,
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        template_id: "dropoff.changed",
        vars: { legDate: SERVICE_DATE, ...(time ? { eta: time } : {}), stopLabel: "OKEE-PARK" },
        approval_key: "a-key",
      }),
    ],
  );
  return id;
}

/**
 * The board's plan port, faked (`plan-placement-port.ts`).
 *
 * The real one is proved against the real tables in `plan-placement.test.ts`; here it is a
 * recorder, so that this file can go on testing what it is about — the decision, the role, the
 * version guard and the queued text — without a seeded board behind every case. An approval the
 * board refuses is also its own case there (Firia's gap-5 ruling: it rolls everything back).
 */
let placements: SetChildPlacementInput[] = [];
/** The `plan_run.version` the fake board holds. Proposals are written against it by default. */
const FAKE_PLAN_VERSION = 7;
const fakePlacement: PlanPlacementPortFor = () => ({
  currentPlacement: async () => ({ bucket: "VAN", vehicleId: FAKE_VAN, version: FAKE_PLAN_VERSION }),
  setChildPlacement: async (input) => {
    placements.push(input);
    return { ok: true, version: input.expectedVersion + 1 };
  },
});

/** The plan this fake says the child is already in. Any id: nothing here reads a real van. */
const FAKE_VAN = "00000000-0000-7000-8000-0000000000f1";

/** The same port, refusing the way the board refuses a plan that moved. */
const refusingPlacement: PlanPlacementPortFor = () => ({
  currentPlacement: async () => ({ bucket: "VAN", vehicleId: FAKE_VAN, version: FAKE_PLAN_VERSION }),
  setChildPlacement: async (input) => {
    placements.push(input);
    return { ok: false, reason: "CHANGED" };
  },
});

const decide = (
  over: Partial<Parameters<typeof decideApproval>[2]>,
  placement: PlanPlacementPortFor = fakePlacement,
) =>
  decideApproval(
    db,
    transport,
    {
      userId: coordinator,
      approvalId: "",
      decision: "APPROVED",
      now: TEST_NOW,
      ...over,
    },
    { placement },
  );

const queued = async () =>
  (await db.query<{ template_id: string; vars: Record<string, unknown>; child_token: string; trip_leg_id: string; plan_version_basis: number; state: string }>(
    "SELECT template_id, vars, child_token, trip_leg_id, plan_version_basis, state FROM ops.outbound_message ORDER BY created_at, id",
    [],
  )).rows;

/**
 * The plan, as rows: `plan_run` and the assignments hanging off it (Veri S3).
 *
 * This file drives the board through `fakePlacement`, which records its arguments and writes
 * nothing — so on every path these two tables stay empty, and that is exactly the assertion worth
 * making about a decline. A row appearing here means something in this module reached the plan
 * tables directly, which is the second writer S1-3 deleted.
 */
const planRows = async () => ({
  runs: (await db.query<Record<string, unknown>>("SELECT id, direction, version FROM ops.plan_run", [])).rows,
  assignments: (await db.query<Record<string, unknown>>("SELECT child_token, bucket FROM ops.plan_assignment", [])).rows,
});

const leg = async () =>
  (await db.query<{ plan_version: number; version: number; window_start: Date | null }>(
    "SELECT plan_version, version, window_start FROM ops.trip_leg WHERE id = $1",
    [legId],
  )).rows[0];

describe("who may decide", () => {
  /**
   * The roles are a **named constant** in the one access table, read and never derived.
   *
   * They used to be `rolesWhoCanOpen("/exceptions")` — the row of the page the screen was on.
   * Veri called that a merge blocker and was right: `/exceptions` is being redesigned out of
   * existence (REDESIGN-SPEC §9.3 makes it a redirect), so the permission was read off a row
   * that is about to be deleted, and any edit to that route would have moved who may approve.
   */
  it("holds a decider to the named approval roles, and to nothing derived from a route", () => {
    expect([...APPROVAL_ROLES].sort()).toEqual(["COORDINATOR", "DIRECTOR"]);
        expect(APPROVAL_ROLES).not.toContain("FRONT_DESK");
    // Not open to every staff role: the front desk's job is custody at the ramp, not approvals.
    expect(APPROVAL_ROLES.length).toBeLessThan(ALL_STAFF.length);
  });

  /**
   * **A parent session is refused.** A family holds no console account in P1, so a "parent" here
   * is a caller with no staff role: signed out, or signed in with no membership. Both are refused
   * and neither is told anything about the proposal.
   */
  it("refuses a caller who is not staff: no session at all", async () => {
    const id = await seedProposal();
    expect(await decide({ approvalId: id, userId: undefined })).toEqual({
      status: 401,
      body: { ok: false, error: "SIGN_IN" },
    });
    // Nothing moved and nothing was queued.
    expect(await queued()).toEqual([]);
    expect((await leg()).plan_version).toBe(1);
    expect(await pendingApprovals(db, [SITE])).toHaveLength(1);
  });

  it("refuses a signed-in user who holds no role anywhere, which is what a parent would be", async () => {
    const id = await seedProposal();
    const noRole = await seedStaff(db, "COORDINATOR", null);

    expect(await decide({ approvalId: id, userId: noRole })).toEqual({
      status: 404,
      body: { ok: false, error: "NO_SUCH_APPROVAL" },
    });
    expect(await queued()).toEqual([]);
    expect((await leg()).plan_version).toBe(1);
  });

  it("refuses a staff role the screen's own row omits", async () => {
    const id = await seedProposal();
    const frontDesk = await seedStaff(db, "FRONT_DESK", SITE);

    expect(await decide({ approvalId: id, userId: frontDesk })).toEqual({
      status: 403,
      body: { ok: false, error: "NOT_YOUR_ROLE" },
    });
    expect(await queued()).toEqual([]);
  });
});

describe("the tenant boundary", () => {
  /**
   * **Another site's proposal id is refused**, and refused *identically* to an id that exists
   * nowhere. That equality is the assertion: a 403 here, or a different error code, would tell a
   * caller holding a guessed id that it is a real one somewhere.
   */
  it("answers another site's id and an unknown id the same way", async () => {
    const theirs = await seedProposal({ siteId: SITE_B });
    const nowhere = uuidv7();

    const toTheirs = await decide({ approvalId: theirs });
    const toNowhere = await decide({ approvalId: nowhere });

    expect(toTheirs).toEqual({ status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } });
    expect(toTheirs).toEqual(toNowhere);
    // And the row they named is untouched: still undecided, at their site.
    const theirRow = (await db.query<{ decision: string | null; decided_at: Date | null }>(
      "SELECT decision, decided_at FROM ops.approval_request WHERE id = $1",
      [theirs],
    )).rows[0];
    expect([theirRow.decision, theirRow.decided_at]).toEqual([null, null]);
    expect(await queued()).toEqual([]);
  });

  it("is not a well-formed id either: a string that is not a uuid is the same not-found", async () => {
    expect(await decide({ approvalId: "not-an-id" })).toEqual({
      status: 404,
      body: { ok: false, error: "NO_SUCH_APPROVAL" },
    });
  });

  it("lists only the sites a caller is a member of", async () => {
    await seedProposal();
    await seedProposal({ siteId: SITE_B });

    expect(await pendingApprovals(db, [SITE])).toHaveLength(1);
    expect(await pendingApprovals(db, [SITE_B])).toHaveLength(1);
    expect(await pendingApprovals(db, [])).toEqual([]);
    expect((await pendingApprovals(db, [SITE]))[0].childLabel).toBe("Noah O.");
  });
});

describe("approving", () => {
  it("moves the ride, queues the family's text, and records the decision", async () => {
    const id = await seedProposal();

    const answer = await decide({ approvalId: id });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, decision: "APPROVED" });
    expect(answer.body.ok && answer.body.queued).toBe(1);
    /*
     * The exact words the family gets — the ones the screen showed, through the one renderer.
     *
     * Human, and it names the child (Firia, 2026-10-17 10:51 PM ET); the name is resolved from the
     * child's own row at render time and is never a var (`src/modules/messaging/templates.ts`,
     * Veri #12).
     *
     * And **no clock time** in it: the COPY RULE (p-rework-approvals5; Vera's S1-2 checklist item
     * b) is the later word over the 10:51 PM example that had one. What the family needs is where
     * their child gets off, which is the thing a person just decided — the minute is traffic, and
     * this screen gives a family no ETAs at all. Asserted as the whole string rather than a
     * fragment, so a time cannot creep back in beside what is checked here.
     */
    expect(answer.body.ok && answer.body.text).toBe(
      "PPEC: Yes — Noah gets off at Okeeheelee Park today.",
    );
    expect(answer.body.ok && answer.body.text).not.toMatch(/\d{1,2}:\d{2}/);

    // 1. the decision, with who made it and when.
    const row = (await db.query<{ decision: string; decided_by: string; decided_at: Date }>(
      "SELECT decision, decided_by, decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )).rows[0];
    expect(row.decision).toBe("APPROVED");
    expect(row.decided_by).toBe(coordinator);
    expect(row.decided_at).not.toBeNull();

    /*
     * 2. the ride is NOT written. Firia's S1-3 (2026-10-17 11:00 PM ET) removed the
     *    `UPDATE ops.trip_leg` this decision used to make: the board owns where a child is, it
     *    guards `plan_run.version` rather than `trip_leg.plan_version`, and a drop-off time is
     *    not the leg's pickup window. The plan write is `setChildPlacement`, asserted below and
     *    against real rows in `plan-placement.test.ts`.
     */
    const after = await leg();
    expect(after.plan_version).toBe(1);

    /*
     * 3. the text, queued against the version the ride actually has — the outbox compares this
     *    to `trip_leg.plan_version` at drain (outbox.ts:219), so a later re-plan of the leg
     *    still makes the message CANCELED_STALE.
     */
    const [message] = await queued();
    expect(message.template_id).toBe("dropoff.changed");
    expect(message.child_token).toBe(childToken);
    expect(message.trip_leg_id).toBe(legId);
    expect(message.plan_version_basis).toBe(1);
    expect(message.state).toBe("QUEUED");
    expect(message.vars).toMatchObject({ eta: "17:00", stopLabel: "OKEE-PARK" });

    // And it leaves the list: the next render offers no decision somebody has already made.
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
  });

  /**
   * THE EDITED TIME IS WHAT GETS RECORDED — and it is not a word of the text.
   *
   * It used to be both: the body said "at 5:30 PM", so the edit was visible in the sentence. The
   * COPY RULE took the clock out of `dropoff.changed` (Vera's S1-2 item b), and that changes where
   * this claim is checkable rather than whether it holds. The edited minute is the one the message
   * *carries* — `vars.eta`, which is what the drain renders and what the plan was saved against —
   * while the words a family reads say where their child gets off and not when. So the assertion
   * moved onto the row, and the body is asserted to carry no clock at all.
   */
  it("records the time a coordinator edited, not the one the agent proposed", async () => {
    const id = await seedProposal();

    const answer = await decide({ approvalId: id, editedTime: "17:30" });

    // The edit reached the message, and the proposal's own 17:00 did not.
    expect((await queued())[0].vars).toMatchObject({ eta: "17:30" });
    expect((await queued())[0].vars).not.toMatchObject({ eta: "17:00" });
    // And the words are the same words either way, because they name no minute.
    expect(answer.body.ok && answer.body.text).toBe(
      "PPEC: Yes — Noah gets off at Okeeheelee Park today.",
    );
  });

  it("refuses a time that is not a time, before anything is written", async () => {
    const id = await seedProposal();
    for (const bad of ["5pm-ish", "25:00", "17:0", "tomorrow"]) {
      expect(await decide({ approvalId: id, editedTime: bad }), bad).toEqual({
        status: 422,
        body: { ok: false, error: "NOT_A_TIME" },
      });
    }
    expect(await queued()).toEqual([]);
    expect((await leg()).plan_version).toBe(1);
  });

  /** The race the schema comment next to the table names: two coordinators, one send. */
  it("lets exactly one decision land", async () => {
    const id = await seedProposal();

    const first = await decide({ approvalId: id });
    const second = await decide({ approvalId: id });

    expect(first.status).toBe(200);
    expect(second).toEqual({ status: 409, body: { ok: false, error: "ALREADY_DECIDED" } });
    // One text, not two — and one plan write, which is the placement and not the leg.
    expect(await queued()).toHaveLength(1);
    expect(placements).toHaveLength(1);
    expect((await leg()).plan_version).toBe(1);
  });

  /**
   * AT-08 from the other side: a manual correction invalidates a queued message, and it
   * invalidates a *pending proposal* for the same reason — the text would name a time that is no
   * longer the plan. Nothing is written, the decision is not claimed, and a coordinator can read
   * the new state and decide again.
   */
  it("refuses when the ride moved under the proposal, and claims nothing", async () => {
    const id = await seedProposal({ planVersionBasis: 1 });
    // Somebody corrected the leg by hand in between.
    await db.query("UPDATE ops.trip_leg SET plan_version = 2, version = version + 1 WHERE id = $1", [legId]);

    expect(await decide({ approvalId: id })).toEqual({
      status: 409,
      body: { ok: false, error: "PLAN_MOVED" },
    });
    expect(await queued()).toEqual([]);
    // Still undecided, so the screen can offer it again against the state as it now is.
    const row = (await db.query<{ decided_at: Date | null }>(
      "SELECT decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )).rows[0];
    expect(row.decided_at).toBeNull();
    expect(await pendingApprovals(db, [SITE])).toHaveLength(1);
  });
});

describe("not sending", () => {
  it("records the decision and does nothing else at all", async () => {
    const id = await seedProposal();

    const answer = await decide({ approvalId: id, decision: "DECLINED" });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, decision: "DECLINED", queued: 0 });
    expect((await db.query<{ decision: string }>("SELECT decision FROM ops.approval_request WHERE id = $1", [id])).rows[0].decision)
      .toBe("DECLINED");
    // The whole of what "Don't send" means: no ride moved and no message was queued.
    expect(await queued()).toEqual([]);
    expect((await leg()).plan_version).toBe(1);
    expect((await leg()).window_start).toBeNull();
    /*
     * And the PLAN (Veri S3, 2026-10-18): `plan_run` and `plan_assignment` are untouched.
     *
     * The three lines above are about the leg and the outbox, which were the two writers this
     * path used to have. Since S1-3 the plan write goes through `setChildPlacement` into
     * `plan_run` / `plan_assignment`, so "does nothing else at all" is only checked if those two
     * tables are checked — a decline that bumped a plan version would have slipped past every
     * assertion in this test as it stood. Read as rows, and also as the board writer never having
     * been called at all: `decideApproval` returns before step 2 on a DECLINE.
     */
    expect(await planRows()).toEqual({ runs: [], assignments: [] });
    expect(placements).toEqual([]);
  });

  it("cannot be decided twice either", async () => {
    const id = await seedProposal();
    await decide({ approvalId: id, decision: "DECLINED" });
    expect(await decide({ approvalId: id })).toEqual({
      status: 409,
      body: { ok: false, error: "ALREADY_DECIDED" },
    });
    expect(await queued()).toEqual([]);
  });
});

/** A row this screen has no card for is not decidable through it, whatever its id. */
describe("another kind of proposal", () => {
  it("is neither listed nor decidable here", async () => {
    const taskId = uuidv7();
    await db.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
         created_by, updated_by, source_mode)
       VALUES ($1, $2, 'INFEASIBLE', 'RED', 'OPEN', 'A vehicle cannot take its runs', 'Review the options',
         'an option approved', 'test', 'test', 'SIMULATED')`,
      [taskId, SITE],
    );
    const id = uuidv7();
    await db.query(
      `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'SIMULATED')`,
      [id, SITE, taskId, JSON.stringify({ infeasible_vehicle_token: "V1", leg_ids: [], options: [] })],
    );

    expect(await pendingApprovals(db, [SITE])).toEqual([]);
    expect(await decide({ approvalId: id })).toEqual({
      status: 404,
      body: { ok: false, error: "NO_SUCH_APPROVAL" },
    });
  });
});
