/**
 * **Firia's gap-5 ruling: an approved change or cancel saves a new plan version, through the board's
 * own writer — and until that writer exists, an approval fails safe.**
 *
 * Three things, each a separate way this could go wrong:
 *
 *  1. **a change** calls `SetChildPlacement` with the child in a van, guarded on the plan version
 *     the proposal was computed against, and the writer answers with the *new* version;
 *  2. **a cancel** calls the same function with `bucket: "ABSENT"` for that leg — the same
 *     exported function the board uses, not a bucket writer of this module's own;
 *  3. **no writer at all** — which is production today, because `setChildPlacement` is on
 *     `team/ppe-rework-ramp-board` and is not merged — refuses: the decision is not claimed, the
 *     ride does not move, nothing reaches the outbox, and the coordinator reads "Couldn't update
 *     the plan". Never a fake success, and never a text to a family about a change the plan does
 *     not hold.
 *
 * The fourth suite is the rule about *where absence is read*: `plan_assignment`, and nowhere else.
 * `attendance_day` keeps its own record — the front desk's actual-attendance row is a different
 * fact, recorded by a different person — but no screen reads absence from it, and that is a grep
 * rather than a behaviour because it is a rule about the whole tree.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { decideApproval } from "@/modules/approvals/decide";
import type { SetChildPlacement, SetChildPlacementInput } from "@/modules/approvals/plan-placement-port";
import { demoChildToken, demoLegId } from "@/modules/demo/fixtures/standard";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { TEST_NOW } from "@/test/clock";
import { seedPersona, seedStaff } from "@/test/messaging";
import { freshDb, SITE } from "@/test/pglite";

/** A file's code with its comments stripped, so a sentence about a write is not read as one. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const SERVICE_DATE = "2026-10-14";
const legId = demoLegId("C2", "PM");
const childToken = demoChildToken("C2");

let pg: PGlite;
let db: Db;
let transport: FakeOutboxTransport;
let coordinator: string;
let calls: SetChildPlacementInput[];

/** The board's writer, faked: it records what it was asked for and answers a new version. */
const recorder: SetChildPlacement = async (input) => {
  calls.push(input);
  return { ok: true, planVersion: input.expectedVersion + 1 };
};

/** The same writer, refusing — a plan that moved under the proposal, as the board would say it. */
const refuses: SetChildPlacement = async (input) => {
  calls.push(input);
  return { ok: false };
};

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  transport = new FakeOutboxTransport();
  calls = [];
  coordinator = await seedStaff(db, "COORDINATOR", SITE);

  const persona = await seedPersona(db, "+15615550102", { siteId: SITE, now: TEST_NOW });
  await db.query(
    `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
     VALUES ($1, $2, $3, 'Noah O.', 'test', 'test')`,
    [childToken, SITE, persona.familyGroupId],
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

/** One undecided proposal. `cancel` makes it the cancel flavour rather than a time change. */
async function seedProposal(over: { cancel?: boolean } = {}): Promise<string> {
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, 'PLAN_CHANGE', 'AMBER', 'OPEN', 'A family asked for a different drop-off',
       'Read the text, then decide', 'the drop-off approved or declined', 'test', 'test', 'SIMULATED')`,
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
        kind: DROPOFF_CHANGE_KIND,
        leg_id: legId,
        child_token: childToken,
        service_date: SERVICE_DATE,
        direction: "PM",
        plan_version_basis: 1,
        requested_dropoff_time: over.cancel ? null : "17:00",
        ...(over.cancel ? { cancel: true } : {}),
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        template_id: over.cancel ? "leg.canceled" : "dropoff.changed",
        vars: over.cancel
          ? { legDate: SERVICE_DATE, reasonCode: "FAMILY_REQUEST" }
          : { legDate: SERVICE_DATE, eta: "17:00", stopLabel: "OKEE-PARK" },
        approval_key: "a-key",
      }),
    ],
  );
  return id;
}

const decide = (approvalId: string, placement: SetChildPlacement | null) =>
  decideApproval(db, transport, { userId: coordinator, approvalId, decision: "APPROVED", now: TEST_NOW }, { placement });

const decided = async (id: string) =>
  (
    await db.query<{ decision: string | null; decided_at: Date | null }>(
      "SELECT decision, decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )
  ).rows[0];

const outbox = async () =>
  (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;

const planVersion = async () =>
  (await db.query<{ plan_version: number }>("SELECT plan_version FROM ops.trip_leg WHERE id = $1", [legId]))
    .rows[0].plan_version;

describe("an approved change saves a new plan version, through the board's writer", () => {
  it("calls SetChildPlacement once, for this child's leg, guarded on the proposal's version", async () => {
    const id = await seedProposal();
    const answer = await decide(id, recorder);
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      siteId: SITE,
      serviceDate: SERVICE_DATE,
      direction: "PM",
      childToken,
      bucket: "VAN",
      expectedVersion: 1,
      actor: `staff:${coordinator}`,
    });
  });

  it("and the ride it moved carries a version after the one the proposal was computed against", async () => {
    const id = await seedProposal();
    await decide(id, recorder);
    expect(await planVersion()).toBe(2);
  });
});

describe("an approved cancel puts the child in the ABSENT bucket, through the same function", () => {
  it("calls the one writer with ABSENT for that leg", async () => {
    const id = await seedProposal({ cancel: true });
    const answer = await decide(id, recorder);
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].bucket).toBe("ABSENT");
    expect(calls[0].childToken).toBe(childToken);
    expect(calls[0].direction).toBe("PM");
  });

  it("writes no bucket itself: there is no plan_assignment query in this module", () => {
    // Comments stripped: prose about updating the plan is not a query (as in `no-network.test.ts`).
    expect(code(path.join(__dirname, "decide.ts"))).not.toMatch(/plan_assignment|plan_run/i);
    // And the port it calls has no implementation of its own to drift from the board's.
    expect(code(path.join(__dirname, "plan-placement-port.ts"))).not.toMatch(/\bINSERT\b|\bUPDATE\b|\.query\(/i);
  });
});

describe("with no writer wired, an approval fails safe", () => {
  it("refuses, and the coordinator is told the plan was not saved", async () => {
    const id = await seedProposal();
    expect(await decide(id, null)).toEqual({
      status: 503,
      body: { ok: false, error: "PLAN_NOT_SAVED" },
    });
  });

  it("claims nothing, moves nothing, and sends the family nothing", async () => {
    const id = await seedProposal();
    await decide(id, null);
    expect(await decided(id)).toEqual({ decision: null, decided_at: null });
    expect(await planVersion()).toBe(1);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("does the same when the writer is there and refuses", async () => {
    const id = await seedProposal();
    expect((await decide(id, refuses)).status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(await decided(id)).toEqual({ decision: null, decided_at: null });
    expect(await outbox()).toEqual([]);
  });

  it("is what production does today: the call site passes no writer", () => {
    const action = readFileSync(
      path.join(__dirname, "..", "..", "app", "(app)", "family-texts", "actions.ts"),
      "utf8",
    );
    expect(action).toMatch(/\{\s*placement:\s*null\s*\}/);
  });
});

describe("absence is read from plan_assignment and from nowhere else", () => {
  const SRC = path.join(__dirname, "..", "..");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
    });
  }

  it("has no screen that reads attendance_day", () => {
    const screens = walk(path.join(SRC, "app")).concat(walk(path.join(SRC, "ui")));
    const offenders = screens.filter((f) => /attendance_day/i.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("and the record itself is still kept, by the module that owns it", () => {
    // Not a screen: somewhere under `modules/` or `domain/` writes it, which is the point — the
    // row survives, nothing renders from it.
    const owners = walk(path.join(SRC, "modules"))
      .concat(walk(path.join(SRC, "domain")))
      .filter((f) => /attendance_day/i.test(readFileSync(f, "utf8")));
    expect(owners.length).toBeGreaterThan(0);
  });
});
