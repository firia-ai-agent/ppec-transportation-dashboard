/**
 * **Firia's gate 8, the guard half: the front desk cannot approve, and the server is what says so.**
 *
 * The courtesy half — no "For you" tab in their menu, no card in their thread — is
 * `app/(app)/family-texts/texts-screen.test.ts`. This file is the half that matters, because
 * hiding a control is not a guard: the request a front-desk account can make by hand has to be
 * refused by the code that runs it.
 *
 * ## Through the real handler, against a real database
 *
 * `decideApprovalAction` — the actual server action the button posts to, not a mock of its check —
 * driven with a front-desk session against a PGlite database that holds a real undecided proposal
 * and a real front-desk membership at its site. The assertions are the two that matter: the answer
 * is a refusal, and **the write path did not run** — the proposal is still undecided, the ride has
 * not moved, nothing is in the outbox, and the placement writer was never called.
 *
 * ## Mutation-proof, and proven so — with one honest caveat
 *
 * A guard test that passes for the wrong reason is worse than none, so this was run against two
 * deliberately broken builds (2026-10-17), and the results are recorded exactly as they came out:
 *
 *  1. **`FRONT_DESK` added to `APPROVAL_ROLES`** in `src/auth/access.ts` → **FAILED**, 3 of the 5
 *     tests here: the constant's own assertion, the real handler's refusal, and the model's 403
 *     with its "never reached the placement writer". (The fourth, "writes nothing", still passed
 *     — and that is worth knowing rather than hiding: with no plan writer wired the approval
 *     fails safe and rolls everything back anyway, so that assertion is not the one carrying this
 *     check today. It will be once `setChildPlacement` lands.)
 *  2. **the role check deleted from the action** → **PASSED here**, and **FAILED** in
 *     `one-write-path.test.ts` ("refuses before it calls anything when the role may not decide").
 *     It passes here because the model's own `requireSiteAccess` answers 403 for the same role and
 *     the action maps both to the same sentence — defence in depth doing its job, and
 *     indistinguishable from the outside. The assertion that tells them apart is the spy in that
 *     file: with the action's check gone, `decideApproval` is reached. So the pair of files is
 *     mutation-proof and neither is on its own; read them together.
 *
 * Both mutations were reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { APPROVAL_ROLES } from "@/auth/access";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { decideApproval } from "@/modules/approvals/decide";
import type { PlanPlacementPortFor, SetChildPlacementInput } from "@/modules/approvals/plan-placement-port";
import { demoChildToken, demoLegId } from "@/modules/demo/fixtures/standard";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { TEST_NOW } from "@/test/clock";
import { seedPersona, seedStaff } from "@/test/messaging";
import { freshDb, SITE } from "@/test/pglite";
import { approval as approvalCopy } from "@/ui/copy";

let pg: PGlite;
let db: Db;
let transport: FakeOutboxTransport;
let frontDesk: string;
let approvalId: string;
let placements: SetChildPlacementInput[];

const legId = demoLegId("C2", "PM");
const childToken = demoChildToken("C2");

/** A working plan port, so a refusal below is about the role and never about the plan. */
const placement: PlanPlacementPortFor = () => ({
  setDropoffWindow: async () => ({ ok: true }),
  recordReceiver: async () => ({ ok: true }),
  saveRoute: async () => ({ ok: false, reason: "NOT_IN_THIS_TEST" }),
  currentPlacement: async () => ({
    bucket: "VAN",
    vehicleId: "00000000-0000-7000-8000-0000000000f1",
    version: 7,
  }),
  setChildPlacement: async (input) => {
    placements.push(input);
    return { ok: true, version: input.expectedVersion + 1 };
  },
});

/** The caller the action sees. Replaced per test; the database membership is seeded to match. */
const caller = vi.fn();
vi.mock("@/auth/caller", () => ({ getCaller: () => caller() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
/* The action reaches for the production pool; it is handed the test database instead. */
vi.mock("@/db/exec", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/db/exec")>();
  return { ...real, getNeonDb: () => db };
});
vi.mock("@/modules/outbox/transport", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/outbox/transport")>();
  return { ...real, vercelQueueOutboxTransport: transportProxy() };
});

/** The fake transport, reached lazily: the mock is hoisted above `beforeEach`. */
function transportProxy() {
  return { send: (...args: unknown[]) => (transport as unknown as { send: (...a: unknown[]) => unknown }).send(...args) };
}

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  transport = new FakeOutboxTransport();
  placements = [];
  frontDesk = await seedStaff(db, "FRONT_DESK", SITE);

  const persona = await seedPersona(db, "+15615550102", { siteId: SITE, now: TEST_NOW });
  await db.query(
    `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
     VALUES ($1, $2, $3, 'Noah O.', 'test', 'test')`,
    [childToken, SITE, persona.familyGroupId],
  );
  await db.query(
    `INSERT INTO ops.trip_leg (id, site_id, child_token, service_date, direction, mode, state, plan_version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'PM', 'PROVIDER', 'SCHEDULED', 1, 'test', 'test')`,
    [legId, SITE, childToken, "2026-10-14"],
  );
  // A task row first: an approval request belongs to one (the schema's own FK).
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, 'PLAN_CHANGE', 'AMBER', 'OPEN', 'A family asked for a different drop-off',
       'Read the text, then decide', 'the drop-off approved or declined', 'test', 'test', 'SIMULATED')`,
    [taskId, SITE],
  );
  approvalId = uuidv7();
  await db.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'SIMULATED')`,
    [
      approvalId,
      SITE,
      taskId,
      JSON.stringify({
        kind: DROPOFF_CHANGE_KIND,
        leg_id: legId,
        child_token: childToken,
        service_date: "2026-10-14",
        direction: "PM",
        // `plan_run.version`, the counter the board guards. Recorded, not checked by
        // `decideApproval` (PR #75); the port above answers 7, so this row matches it anyway.
        plan_run_version_basis: 7,
        requested_dropoff_time: "17:00",
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        template_id: "dropoff.changed",
        vars: { legDate: "2026-10-14", eta: "17:00", stopLabel: "OKEE-PARK" },
        approval_key: "a-key",
      }),
    ],
  );
});

afterEach(async () => {
  await pg.close();
});

const form = () => {
  const f = new FormData();
  f.set("approval", approvalId);
  f.set("decision", "APPROVED");
  f.set("time", "");
  return f;
};

const stillPending = async () =>
  (
    await db.query<{ decided_at: Date | null; decision: string | null }>(
      "SELECT decided_at, decision FROM ops.approval_request WHERE id = $1",
      [approvalId],
    )
  ).rows[0];

const outbox = async () =>
  (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;

const legVersion = async () =>
  (await db.query<{ plan_version: number }>("SELECT plan_version FROM ops.trip_leg WHERE id = $1", [legId]))
    .rows[0].plan_version;

describe("the named constant this is all read from", () => {
  it("does not contain the front desk", () => {
    expect(APPROVAL_ROLES).not.toContain("FRONT_DESK");
    expect([...APPROVAL_ROLES].sort()).toEqual(["COORDINATOR", "DIRECTOR"]);
  });
});

describe("the real server action, called as the front desk", () => {
  beforeEach(() => {
    caller.mockResolvedValue({
      kind: "STAFF",
      role: "FRONT_DESK",
      userId: frontDesk,
      displayName: "SYN Frankie Front Desk",
      memberships: [{ siteId: SITE, role: "FRONT_DESK" }],
    });
  });

  it("refuses, in the words the screen shows", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    const state = await decideApprovalAction({ status: "idle" }, form());
    expect(state).toEqual({ status: "refused", message: approvalCopy.notYourRole });
  });

  it("writes nothing: the decision, the ride and the outbox are all untouched", async () => {
    const { decideApprovalAction } = await import("@/app/(app)/family-texts/actions");
    await decideApprovalAction({ status: "idle" }, form());
    expect(await stillPending()).toEqual({ decided_at: null, decision: null });
    expect(await legVersion()).toBe(1);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });
});

/**
 * And the model underneath refuses them too, with the plan writer wired and working.
 *
 * This is the defence-in-depth half: even if the action's own check were removed, the front desk
 * reaches a 403 here, and `placements` stays empty — the write path is not entered at all.
 */
describe("the decision model, called as the front desk with a working plan writer", () => {
  it("answers 403 and never reaches the placement writer", async () => {
    const answer = await decideApproval(
      db,
      transport,
      { userId: frontDesk, approvalId, decision: "APPROVED", now: TEST_NOW },
      { placement },
    );
    expect(answer).toEqual({ status: 403, body: { ok: false, error: "NOT_YOUR_ROLE" } });
    expect(placements).toEqual([]);
    expect(await stillPending()).toEqual({ decided_at: null, decision: null });
    expect(await outbox()).toEqual([]);
  });

  it("and a coordinator, on the same rows, does land — so the refusal above is about the role", async () => {
    const coordinator = await seedStaff(db, "COORDINATOR", SITE);
    const answer = await decideApproval(
      db,
      transport,
      { userId: coordinator, approvalId, decision: "APPROVED", now: TEST_NOW },
      { placement },
    );
    expect(answer.status).toBe(200);
    expect(placements).toHaveLength(1);
    expect((await stillPending()).decision).toBe("APPROVED");
  });
});
