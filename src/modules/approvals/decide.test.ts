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
 * Then what approving actually does, which is three writes in one transaction, and the ways it
 * refuses to do them: a decision already made, a plan the board will not take the write for, and a
 * time that is not a time. A proposal drafted against an older plan version is *not* one of them
 * (Firia, PR #75) — that check is gone, and the case below holds it gone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { ALL_STAFF, APPROVAL_ROLES } from "@/auth/access";
import { demoChildToken, demoLegId } from "@/modules/demo/fixtures/standard";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { InMemorySimFaultStore } from "@/modules/messaging/faults";
import { recordConsent } from "@/modules/messaging/consent";
import { DbSimMessagingProvider } from "@/modules/messaging/sim-provider";
import { drain, type DrainDeps } from "@/modules/outbox/outbox";
import { gatewayRecipientAuthorizer } from "@/modules/outbox/policy";
import { TEST_NOW } from "@/test/clock";
import { testIdentityGateway } from "@/test/identity-gateway";
import { PEPPER, seedPersona, seedStaff } from "@/test/messaging";
import { freshDb, ORG, SITE } from "@/test/pglite";
import { renderTemplate, SEND_FOOTER } from "@/modules/messaging/templates";
import { decideApproval, pendingApprovals } from "./decide";
import { MESSAGE_SEND_KIND } from "./message-send";
import type { PlanPlacementPortFor, SetChildPlacementInput } from "./plan-placement-port";

let pg: PGlite;
let db: Db;
let transport: FakeOutboxTransport;
/** The coordinator who decides, and the child whose ride the proposal is about. */
let coordinator: string;
let childToken: string;
let legId: string;
/** The authorized contact a message proposal would be approved to text (S1-7). */
let contactToken: string;

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
  contactToken = persona.contactToken;
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
         * `plan_run.version` as it was when the proposal was written — recorded, and since PR #75
         * not checked by `decideApproval`. The fake port below answers version 7, so 7 is "the
         * plan this proposal was computed against" and anything else is a stale basis, which is a
         * case about what still goes through rather than what refuses.
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

/** The row `proposals.messageSend` writes for a `send_followup` to a family. */
async function seedMessage(over: { vars?: Record<string, unknown>; templateId?: string } = {}): Promise<string> {
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, 'FAMILY_MESSAGE', 'AMBER', 'OPEN', 'There is a text ready for a family',
       'Read the text, then decide', 'the text approved or declined', 'test', 'test', 'SIMULATED')`,
    [taskId, SITE],
  );
  const id = uuidv7();
  await db.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'SIMULATED')`,
    [
      id,
      SITE,
      taskId,
      JSON.stringify({
        kind: MESSAGE_SEND_KIND,
        tool: "send_followup",
        audience: "GUARDIAN_OF_CHILD",
        recipient_tokens: [contactToken],
        child_token: childToken,
        therapy_session_id: null,
        trip_leg_id: legId,
        channel: "SMS_1TO1",
        purpose: "FAMILY_TRANSPORT_UPDATE",
        recipient_rule: "authorized_contacts_for_child",
        template_id: over.templateId ?? "leg.canceled",
        vars: over.vars ?? { legDate: SERVICE_DATE, reasonCode: "FAMILY_REQUEST" },
        approval_key: "a-key",
      }),
    ],
  );
  return id;
}

/** The words the card would show for that row: one renderer, the same one the outbox uses. */
const wordsOf = (vars: Record<string, unknown> = { legDate: SERVICE_DATE, reasonCode: "FAMILY_REQUEST" }) =>
  renderTemplate("leg.canceled", vars, { child: "Noah O." });

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
  setDropoffWindow: async () => ({ ok: true }),
  recordReceiver: async () => ({ ok: true }),
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
  setDropoffWindow: async () => ({ ok: true }),
  recordReceiver: async () => ({ ok: true }),
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
   * A PROPOSAL OLDER THAN THE PLAN IS STILL APPROVABLE (Firia, PR #75).
   *
   * This case used to be a 409: the proposal's `plan_run_version_basis` was compared to the
   * plan's current version and a mismatch refused the decision. The ruling removed that check,
   * and the demo is why. `demo/approval-seed.ts:123` stamps the basis as `savedPlan?.version ?? 0`
   * — `0` on a restarted day, which writes no `plan_run` — and the walked demo's very next step is
   * staff pressing Auto-plan and Save, which bumps the version. Under the old rule the one card the
   * demo opens on became undecidable the moment the plan it is about existed.
   *
   * So a stale basis changes nothing: the decision reads the plan here, writes against the version
   * it just read (`expectedVersion`, which is the real lock and is checked in
   * `plan-placement.test.ts`), and queues the family's text.
   */
  it("approves a proposal whose plan basis is older than the saved plan (demo seed path)", async () => {
    // Basis 0, while the board this decision reads is at version 7: as stale as the demo's own row.
    const id = await seedProposal({ planVersionBasis: 0 });
    // And a hand correction of the leg on top of it, which is likewise not a reason to refuse.
    await db.query("UPDATE ops.trip_leg SET plan_version = 2, version = version + 1 WHERE id = $1", [legId]);

    const answer = await decide({ approvalId: id });

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, decision: "APPROVED", queued: 1 });
    // One text, and one plan write — guarded on the version the decision itself read, not on the
    // number the proposal was drafted against.
    expect(await queued()).toHaveLength(1);
    expect(placements).toHaveLength(1);
    expect(placements[0].expectedVersion).toBe(FAKE_PLAN_VERSION);
    // Decided, so the card is gone from the queue rather than offered again.
    const row = (await db.query<{ decided_at: Date | null }>(
      "SELECT decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )).rows[0];
    expect(row.decided_at).not.toBeNull();
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
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

/**
 * A MESSAGE APPROVAL (Firia's S1-7 ruling, 2026-10-18).
 *
 * `send_followup` and `request_clarification` propose now, so a second kind of row reaches this
 * decision — and it is guarded differently, on purpose. A message moves nothing, so there is no
 * plan write to guard and no `plan_run` version check at all; what it is guarded on instead is
 * the exact text the person approving had in front of them.
 *
 * Note what is NOT seeded in these cases: no `plan_run_version_basis` and no plan port that could
 * answer one. Nothing reads a basis on either kind any more (PR #75); the difference that remains
 * is that this kind reads no plan at all, because there is nothing for a version to be a version
 * OF.
 */
describe("a message approval: the text is the guard, and no plan is read (S1-7)", () => {
  it("queues the text for the recipient the row names, and writes no plan", async () => {
    const id = await seedMessage();
    const answer = await decide({ approvalId: id, approvedText: wordsOf() });
    expect(answer.status).toBe(200);
    expect(answer.body.ok && answer.body.queued).toBe(1);

    // One message, to the authorized contact the proposal resolved — not to anybody the decision
    // chose, and not to the coordinator.
    const out = await queued();
    expect(out.map((m) => [m.template_id, m.state])).toEqual([["leg.canceled", "QUEUED"]]);
    expect(out[0].child_token).toBe(childToken);
    // The plan port was never asked for a placement, let alone given one.
    expect(placements).toEqual([]);
  });

  it("refuses a decision whose words are not the words the row renders, and sends nothing", async () => {
    const id = await seedMessage();
    expect(await decide({ approvalId: id, approvedText: "PPEC: something else entirely." })).toEqual({
      status: 409,
      body: { ok: false, error: "MESSAGE_CHANGED" },
    });
    expect(await queued()).toEqual([]);

    // And the row is still PENDING, so the coordinator may read the new words and decide again —
    // which is the whole of "an edit resets to pending and needs fresh approval".
    const still = await pendingApprovals(db, [SITE]);
    expect(still.map((p) => p.id)).toEqual([id]);
    expect(await decide({ approvalId: id, approvedText: wordsOf() })).toMatchObject({ status: 200 });
  });

  it("refuses a decision that names no words at all", async () => {
    const id = await seedMessage();
    expect(await decide({ approvalId: id })).toEqual({
      status: 409,
      body: { ok: false, error: "MESSAGE_CHANGED" },
    });
    expect(await queued()).toEqual([]);
  });

  it("approves exactly once: the second press is 409 and queues no second text", async () => {
    const id = await seedMessage();
    expect(await decide({ approvalId: id, approvedText: wordsOf() })).toMatchObject({ status: 200 });
    expect(await decide({ approvalId: id, approvedText: wordsOf() })).toEqual({
      status: 409,
      body: { ok: false, error: "ALREADY_DECIDED" },
    });
    expect((await queued()).length).toBe(1);
  });

  it("'Don't send' writes the decision and queues nothing", async () => {
    const id = await seedMessage();
    const answer = await decide({ approvalId: id, decision: "DECLINED", approvedText: wordsOf() });
    expect(answer.body.ok && answer.body.queued).toBe(0);
    expect(await queued()).toEqual([]);
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
  });

  it("is on the For you queue beside a drop-off proposal, and reads as the same card", async () => {
    const message = await seedMessage();
    const dropoff = await seedProposal();
    const waiting = await pendingApprovals(db, [SITE]);
    expect(waiting.map((p) => p.id).sort()).toEqual([message, dropoff].sort());
    // Both render their words through the same renderer, which is what the card shows.
    expect(waiting.every((p) => p.text.length > 0)).toBe(true);
  });
});

/**
 * THE SEND HALF OF THE GATE — what reaches the family's phone, and what stops it (Veri's run-8
 * gate; Firia's approval rules, 2026-10-18).
 *
 * Everything above this line stops at `ops.outbound_message`. That is the right boundary for the
 * decision model — approving does not send, it queues, and the outbox decides — but it leaves the
 * three claims a coordinator actually relies on unproved, because each of them is about the
 * **drain**:
 *
 *  1. **a second Approve sends no second text.** "One row queued" is not that claim: a row
 *     drained twice is two sends, and the assertions above would not have noticed. So both
 *     presses are made, *every* queued row is drained, drained again, and the family's mailbox is
 *     counted.
 *  2. **an edited draft does not go out on the old signature**, and what does go out is the
 *     approved words byte for byte — the sentence the channel requires after them, and nothing
 *     else anywhere in them.
 *  3. **a STOP that lands after the approval and before the drain stops the text**, and the row
 *     records why. The approval was lawful when it was made; consent is re-read at send time,
 *     which is the entire reason approving queues rather than sends.
 *
 * The provider is the real `DbSimMessagingProvider` over the real `drain`, so "what the family
 * receives" is a row in `ops.message` — the bytes the centre handed the channel — rather than a
 * template id and a bag of vars. The footer is appended at the send step and only there
 * (`renderForSend`, S1-5), which is why the byte comparison below is the approved text plus one
 * space plus `SEND_FOOTER`: a coordinator signs the message, and the channel adds its furniture.
 */
describe("what the family actually receives", () => {
  /** The suites' identity gateway: it knows the rows `seedPersona` wrote (S1-6). */
  const GATEWAY = testIdentityGateway({ pepper: PEPPER });

  /** Two minutes after the decision — the drain is a later moment than the approval, always. */
  const DRAIN_NOW = new Date(TEST_NOW.getTime() + 2 * 60_000);

  /**
   * The real send stack, built per call so it reads the database this test was given.
   *
   * `DbSimMessagingProvider` is the one the app and the demo run: it renders the body the way a
   * send renders it, addresses the persona phone by blind index, and writes what it sent into
   * `ops.message`. An in-memory provider would have let the byte comparison below be a comparison
   * against this file's own idea of the text.
   */
  const sendStack = (): DrainDeps => ({
    provider: new DbSimMessagingProvider(
      db,
      new VercelQueueScheduler(db, new FakeTransport(), () => DRAIN_NOW),
      {
        faults: new InMemorySimFaultStore(),
        clock: () => DRAIN_NOW,
        pepper: PEPPER,
        seed: "test-seed",
        gateway: GATEWAY,
      },
    ),
    authorizer: gatewayRecipientAuthorizer(GATEWAY),
    clock: () => DRAIN_NOW,
    timeoutMs: 500,
  });

  /**
   * Drain every outbound row there is, and answer with what each one did.
   *
   * Every row, not the one this test expects: "exactly one text" is a claim about the whole
   * outbox, and a second row queued under a second key would be invisible to a drain of a known
   * id. Called twice over, a sent row answers `noop` — which is the other half of the claim.
   */
  async function drainAll(): Promise<string[]> {
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM ops.outbound_message ORDER BY created_at, id",
      [],
    );
    const out: string[] = [];
    for (const row of rows.rows) out.push(await drain(db, row.id, sendStack(), "test:drain"));
    return out;
  }

  /** The bytes that left the centre, in order: `ops.message`, which is the persona's phone. */
  const received = async () =>
    (await db.query<{ body_tokenized: string }>(
      "SELECT body_tokenized FROM ops.message WHERE direction = 'OUT' ORDER BY received_at, id",
      [],
    )).rows.map((m) => m.body_tokenized);

  /** The outbound row's own verdict and the reason it recorded for it. */
  const verdict = async () =>
    (await db.query<{ state: string; block_reason: string | null }>(
      "SELECT state, block_reason FROM ops.outbound_message ORDER BY created_at, id",
      [],
    )).rows;

  it("sends one text for two presses of Approve, and nothing for the drain that follows", async () => {
    const id = await seedMessage();

    expect(await decide({ approvalId: id, approvedText: wordsOf() })).toMatchObject({ status: 200 });
    expect(await decide({ approvalId: id, approvedText: wordsOf() })).toEqual({
      status: 409,
      body: { ok: false, error: "ALREADY_DECIDED" },
    });

    // One queued row, drained once: one text. Drained again: nothing, because the row has left
    // QUEUED and a sent message is never re-sent (ADR-003).
    expect(await drainAll()).toEqual(["SENT"]);
    expect(await drainAll()).toEqual(["noop"]);
    expect(await received()).toHaveLength(1);
  });

  it("does not send an edited draft on the old approval, and sends the approved words byte for byte", async () => {
    const id = await seedMessage();
    const asDrafted = wordsOf();

    /*
     * The draft changes under the open card — here the reason the row gives, which is the one
     * thing in these words that is not fixed copy. The card re-renders through the decision
     * model's own renderer and shows the new sentence; the signature a coordinator had already
     * given is a signature on the old one.
     */
    const editedVars = { legDate: SERVICE_DATE, reasonCode: "SCHEDULE_CHANGE" };
    await db.query(
      "UPDATE ops.approval_request SET proposal = jsonb_set(proposal, '{vars}', $2::jsonb) WHERE id = $1",
      [id, JSON.stringify(editedVars)],
    );
    const asEdited = wordsOf(editedVars);
    expect(asEdited).not.toBe(asDrafted);

    expect(await decide({ approvalId: id, approvedText: asDrafted })).toEqual({
      status: 409,
      body: { ok: false, error: "MESSAGE_CHANGED" },
    });
    // Nothing queued, so nothing to drain, so nothing on the phone: the edit did not send.
    expect(await drainAll()).toEqual([]);
    expect(await received()).toEqual([]);

    // The card now reads the edited words, still pending, still with an Approve to press.
    expect((await pendingApprovals(db, [SITE])).map((p) => p.text)).toEqual([asEdited]);

    expect(await decide({ approvalId: id, approvedText: asEdited })).toMatchObject({ status: 200 });
    expect(await drainAll()).toEqual(["SENT"]);

    /*
     * Byte for byte. Not "contains" and not a shape: the approved text, then one space, then the
     * 10DLC sentence the channel requires — which is the whole of what the send step is allowed
     * to add to a message a person signed.
     */
    expect(await received()).toEqual([`${asEdited} ${SEND_FOOTER}`]);
  });

  it("does not send a text a STOP overtook, and records why", async () => {
    const id = await seedMessage();
    expect(await decide({ approvalId: id, approvedText: wordsOf() })).toMatchObject({ status: 200 });
    expect((await verdict())[0].state).toBe("QUEUED");

    /*
     * The family texts STOP in the minute between the approval and the drain. Recorded through
     * the consent model rather than by writing `ops.suppression` by hand, because what has to
     * block the send is the projection a real STOP actually leaves behind (MSG-04).
     */
    const stop = await recordConsent(db, GATEWAY, {
      siteId: SITE,
      contactToken,
      channel: "SMS_1TO1",
      kind: "STOP",
      at: new Date(TEST_NOW.getTime() + 60_000),
      by: "test:webhook",
    });
    expect(stop.suppression).toBe("added");

    expect(await drainAll()).toEqual(["BLOCKED_EGRESS"]);
    // Not sent, and not sendable later: the row says what it is and why, in one place.
    expect(await received()).toEqual([]);
    expect(await verdict()).toEqual([{ state: "BLOCKED_EGRESS", block_reason: "suppressed (ALL)" }]);
    expect(await drainAll()).toEqual(["noop"]);
  });
});
