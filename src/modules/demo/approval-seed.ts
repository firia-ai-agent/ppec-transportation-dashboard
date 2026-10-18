/**
 * THE DEMO DAY'S APPROVAL ROW — a real one, in `ops.approval_request`.
 *
 * Firia's S1-2 (2026-10-17 11:00 PM ET): "Demo data seeds real approval rows via the demo adapter
 * (src/modules/demo/…), not UI fixtures."
 *
 * Before this, the demo's proposal card was a pure function over `demo/change-request.ts` and
 * existed only on the screen. That made the card a *picture* of a decision: its Approve posted an
 * approval id no row carried, so pressing it on a fresh deployment answered `NO_SUCH_APPROVAL`,
 * and the badge over the tab (a real `pendingApprovals` read) and the card under the parent's
 * message could not agree with each other because they had no row in common.
 *
 * So the demo writes the row. The *same* row shape `agent/run/exec/proposals.ts` writes — same
 * `kind`, same `leg_id` / `child_token` / `service_date` / `direction`, same
 * `plan_run_version_basis`, same `template_id` and `vars` — read back by the same
 * `pendingApprovals` query and decided by the same `decideApproval`. Nothing on the screen knows
 * which of the two wrote it, which is the point: the demo exercises the real path rather than a
 * parallel one.
 *
 * ## What this is NOT
 *
 * It is not a model call and it does not pretend to be one. The live turn is the agent's
 * (`demoAgentTurn` → the real OpenRouter path → `propose_dropoff_change`), and on a deployment
 * where the assistant is configured that is what writes the row a coordinator decides. This is the
 * day's *starting state* — the one proposal the walked demo opens on — written so that the screen
 * has a real row to render before anybody has run a turn.
 *
 * ## The version basis, and why it is read rather than assumed
 *
 * `plan_run_version_basis` is `plan_run.version` for this date and leg, read through the board's
 * own store in this transaction, exactly as the agent's writer reads it. At seed time no plan has
 * been saved (the seed deliberately writes no `plan_run`: §9.1, the map stays locked until the ramp
 * is confirmed), so the basis is `0`. It is read rather than assumed because the row is meant to be
 * the agent's row in every field, not because anything refuses on it: Firia's PR #75 ruling took
 * the plan-version check out of `decideApproval`, so approving this proposal after staff have
 * pressed Auto-plan and Save applies it to the plan as it then is — which is the walked demo's own
 * order of operations, and under the old rule killed the one card the demo opens on.
 *
 * ## Never against a real database
 *
 * Seed code. `src/modules/demo/seed.ts` is the only caller, `APP_DATA_CLASS=SYNTHETIC` gates it at
 * boot (ADR-015, src/lib/env.ts), every value in it comes from `fixtures/standard.ts`, and the DB
 * tests run it on PGlite.
 */
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { sqlPlanStoreIn } from "@/modules/plan/sql";
import { agentTasks } from "@/ui/copy";
import {
  DROPOFF_CHANGE_KIND,
  DROPOFF_CHANGE_TASK_CATEGORY,
  DROPOFF_CHANGE_TEMPLATE,
} from "@/modules/approvals/dropoff-change";
import { raiseTask } from "@/modules/agent/run/exec/effects";
import { CHANGE_DIRECTION, demoChangeRequests, type DemoChangeRequest } from "./change-request";
import { KIND, childByKey, childTokenOf, demoId, stopByKey } from "./fixtures/standard";
import type { ServiceDay } from "@/domain/board/day";

/** `created_by` / `updated_by` on the rows this writes. Not `agent:…`: nobody ran a turn. */
const BY = "demo:seed";

/** What the seed wrote, so its caller can report it and a test can assert on it. */
export type SeededApproval = {
  readonly approvalId: string;
  readonly taskId: string;
  readonly childToken: string;
  readonly legId: string;
  /** The `plan_run.version` the approval will be guarded on. `0` on a day with no saved plan. */
  readonly planRunVersionBasis: number;
};

/**
 * Write the day's one change-request proposal as a real approval row, or nothing if the day has
 * no change request and nothing if the leg it is about is not in this database.
 *
 * Idempotent on the demo's own id space (`demoId(KIND.approvalRequest, 1)`), so a re-seed replaces
 * the day rather than stacking proposals — and `ops.approval_request` is in `RESET_TABLES`, so
 * "Restart demo day" truncates it first and writes this again.
 */
export async function seedDemoChangeRequest(
  tx: Exec,
  a: { readonly siteId: string; readonly serviceDate: string; readonly day?: ServiceDay },
): Promise<SeededApproval | null> {
  const request = demoChangeRequests(a.day)[0];
  if (!request) return null;
  return writeOne(tx, { ...a, request });
}

async function writeOne(
  tx: Exec,
  a: { readonly siteId: string; readonly serviceDate: string; readonly request: DemoChangeRequest },
): Promise<SeededApproval | null> {
  const child = childByKey(a.request.childKey);
  if (!child) return null;
  // The seed's own derivation, read from the one helper both sides use (`childTokenOf`), so the
  // proposal cannot name a child token the seeded rows do not hold.
  const childToken = childTokenOf(a.request.childKey);
  const direction: Direction = CHANGE_DIRECTION;

  /*
   * The leg, read back from the rows the seed has just written rather than reconstructed from an
   * id scheme. `decideApproval` reads this same leg by id and refuses the approval if it is gone,
   * so a proposal that named a leg this database does not have would be a card that can only ever
   * fail — better to write no proposal at all.
   */
  const leg = await tx.query<{ id: string }>(
    `SELECT id FROM ops.trip_leg
     WHERE site_id = $1 AND child_token = $2 AND service_date = $3 AND direction = $4`,
    [a.siteId, childToken, a.serviceDate, direction],
  );
  const legId = leg.rows[0]?.id;
  if (!legId) return null;

  /*
   * The board's own counter, in this transaction — the same read the agent's writer makes.
   *
   * `sqlPlanStoreIn` and not `planStoreIn`: the chooser in `plan/store.ts` falls back to the
   * in-memory store when there is no `DATABASE_URL`, and a seed always has one by construction —
   * it is writing rows. It also keeps `@/db/exec` out of this module's *runtime* imports, which
   * matters more than it looks: `demo/reset.ts` → `seed.ts` → here is a chain
   * `src/app/api/demo/reset/route.test.ts` mocks `@/db/exec` across, and `store.ts` imports
   * `getNeonDb` as a value. `plan/sql.ts` imports the same module for types only.
   */
  const savedPlan = await sqlPlanStoreIn(tx).loadPlan(a.siteId, a.serviceDate, direction);
  const planRunVersionBasis = savedPlan?.version ?? 0;

  const taskId = await raiseTask(tx, {
    id: demoId(KIND.approvalTask, 1),
    siteId: a.siteId,
    category: DROPOFF_CHANGE_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedDropoffChange,
    by: BY,
    tripLegId: legId,
    childToken,
  });

  const approvalId = a.request.approvalId;
  const stopToken = child.stopKey ? stopByKey(child.stopKey).smsToken : "";
  const proposal = {
    kind: DROPOFF_CHANGE_KIND,
    leg_id: legId,
    child_token: childToken,
    service_date: a.serviceDate,
    direction,
    plan_run_version_basis: planRunVersionBasis,
    requested_dropoff_time: a.request.requestedHhmm,
    stop_token: stopToken,
    /* A code, never prose — the same enum `propose_dropoff_change` takes (tools.ts). */
    rationale_code: "PARENT_REQUEST",
    basis_message_id: null,
    /* The text, as a template and its vars. Rendered by the screen and by the outbox, once each. */
    template_id: DROPOFF_CHANGE_TEMPLATE,
    vars: { legDate: a.serviceDate, eta: a.request.requestedHhmm, stopLabel: stopToken },
  };
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [approvalId, a.siteId, taskId, JSON.stringify(proposal), BY],
  );
  return { approvalId, taskId, childToken, legId, planRunVersionBasis };
}
