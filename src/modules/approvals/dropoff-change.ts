/**
 * WHAT A DROP-OFF-CHANGE PROPOSAL IS CALLED — three names, shared by everything that writes one
 * and everything that reads one.
 *
 * `ops.approval_request.proposal` is a single `jsonb` column shared by every `propose_*` tool, so
 * `kind` is how a reader knows which shape it is holding. There are three writers of this shape
 * now — the agent's own `propose_dropoff_change` (`agent/run/exec/proposals.ts`), the demo seed
 * (`demo/approval-seed.ts`), and in tests the fixtures that stand in for them — and two readers,
 * `pendingApprovals` and `decideApproval`. One of those five spelling the kind differently is a
 * proposal nobody can decide, so the string lives in one place.
 *
 * ## Why its own file, rather than `proposals.ts` where it started
 *
 * Because of what importing `proposals.ts` *costs*. That module reaches the board's plan store for
 * the version basis, and `plan/store.ts` imports `getNeonDb` as a **value** — so any module that
 * wanted the name of a template ended up with a runtime dependency on the database handle. That
 * broke `src/app/api/demo/reset/route.test.ts`, which mocks `@/db/exec` with a factory: the demo
 * seed began importing `proposals.ts` for these three constants, the mocked module was evaluated
 * through `reset.ts` → `seed.ts` → `approval-seed.ts` before the test's own `vi.fn` was
 * initialized, and the whole suite failed to load with "Cannot access 'getNeonDb' before
 * initialization".
 *
 * The right fix is not a different mock. It is that **three string constants should not drag a
 * database connection behind them**. This file has no imports at all, so nothing that needs a name
 * pays for anything else. `proposals.ts` re-exports them, so its existing callers are unchanged.
 */

/**
 * `proposal ->> 'kind'` for a drop-off change, and the key the approvals screen selects on
 * (`decide.pendingApprovals`).
 */
export const DROPOFF_CHANGE_KIND = "DROPOFF_CHANGE";

/** `ops.task.category` for the exception a drop-off proposal opens: a plan change, not an identity claim. */
export const DROPOFF_CHANGE_TASK_CATEGORY = "PLAN_CHANGE";

/** The allow-listed template a family is told about an agreed drop-off with. */
export const DROPOFF_CHANGE_TEMPLATE = "dropoff.changed";
