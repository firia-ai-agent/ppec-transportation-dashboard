/**
 * CONFIRMING A CARD THE AGENT PREPARED (ledger #74 d).
 *
 * The agent may only *propose* the actions PRD §11.2 forbids it to take on its own — changing a
 * child's approved needs, deciding a card, Restart. Its proposal is a `STAFF_ACTION` approval row
 * (`agent/run/exec/proposals.ts staffAction`): which action, the model's arguments, one line of
 * what it would do. This is the person's press on that card:
 *
 *  1. the row, at a centre this person belongs to — another centre's card is a uniform 404;
 *  2. the action's own access row decides whether *this* person may take it (a coordinator cannot
 *     confirm a Restart, as they cannot press Restart);
 *  3. the card is claimed — the second press gets 409, never a second action;
 *  4. Confirm runs the action through the one action layer, as this person, with the board's
 *     version read now. If the action refuses (the plan moved, a fit rule), the claim is released
 *     and the card stays pending with the reason, so nothing is recorded as done that was not;
 *  5. on success the card's task is resolved, as every decided card's is.
 */
import { ALL_STAFF } from "@/auth/access";
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import type { Db } from "@/db/exec";
import { actionTool } from "@/modules/agent/action-tools";
import { STAFF_ACTION_KIND } from "./confirm-view";
import { resolveTask } from "@/modules/approvals/decide";
import { loadBoard } from "@/modules/plan/store";
import { actionDepsFor } from "./deps";
import { ACTIONS, authorize, runAction, type ActionCtx, type ActionName } from "./registry";

export type ConfirmDecision = "APPROVED" | "DECLINED";

export type ConfirmAnswer =
  | { readonly status: 200; readonly body: { readonly ok: true; readonly decision: ConfirmDecision } }
  | {
      readonly status: 401 | 403 | 404 | 409 | 422;
      readonly body: { readonly ok: false; readonly error: "SIGN_IN" | "NOT_YOUR_ROLE" | "NO_SUCH_CARD" | "ALREADY_DECIDED" | "ACTION_REFUSED"; readonly reason?: string };
    };

export async function confirmStaffAction(
  db: Db,
  req: { readonly userId?: string; readonly approvalId: string; readonly decision: ConfirmDecision; readonly now: Date },
): Promise<ConfirmAnswer> {
  if (!req.userId) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
  const row = (
    await db.query<{ id: string; site_id: string; task_id: string; proposal: { kind?: string; tool?: string; args?: Record<string, unknown> } }>(
      `SELECT id, site_id, task_id, proposal FROM ops.approval_request
        WHERE id = $1 AND decided_at IS NULL AND proposal->>'kind' = $2`,
      [/^[0-9a-f-]{36}$/i.test(req.approvalId) ? req.approvalId : null, STAFF_ACTION_KIND],
    )
  ).rows[0];
  if (!row) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };
  const tool = actionTool(String(row.proposal.tool ?? ""));
  if (!tool) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };

  let ctx: ActionCtx;
  try {
    const membership = await requireSiteAccess(db, req.userId, row.site_id, ALL_STAFF);
    ctx = { siteId: row.site_id, caller: { userId: req.userId, role: membership.role }, now: req.now, deps: actionDepsFor(db, row.site_id) };
    if (req.decision === "APPROVED") await authorize(db, ctx, ACTIONS[tool.action as ActionName]);
  } catch (e) {
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: "NOT_YOUR_ROLE" } };
    throw e;
  }

  const by = `staff:${req.userId}`;
  const claimed = await db.query<{ id: string }>(
    `UPDATE ops.approval_request
        SET decision = $3, decided_by = $4, decided_at = $5, updated_at = $5, updated_by = $6, version = version + 1
      WHERE id = $1 AND site_id = $2 AND decided_at IS NULL RETURNING id`,
    [row.id, row.site_id, req.decision, req.userId, req.now, by],
  );
  if (claimed.rows.length !== 1) return { status: 409, body: { ok: false, error: "ALREADY_DECIDED" } };

  if (req.decision === "APPROVED") {
    const version = async (date: string, leg: "AM" | "PM") =>
      (await loadBoard(ctx.deps!.store!, row.site_id, date, leg, ctx.deps!.source)).version;
    const answer = await runAction(tool.action as ActionName, ctx, await tool.toInput(row.proposal.args ?? {}, version));
    const body = (answer.body ?? {}) as Record<string, unknown>;
    if (answer.status !== 200 || body.ok === false) {
      // Not done, so not recorded as done: the card goes back to pending with the reason.
      await db.query(
        `UPDATE ops.approval_request SET decision = NULL, decided_by = NULL, decided_at = NULL, updated_at = $2, updated_by = $3, version = version + 1
          WHERE id = $1`,
        [row.id, req.now, by],
      );
      return { status: 422, body: { ok: false, error: "ACTION_REFUSED", reason: String(body.reason ?? body.error ?? answer.status) } };
    }
  }
  await db.tx((tx) => resolveTask(tx, row.task_id, req.decision, by));
  return { status: 200, body: { ok: true, decision: req.decision } };
}
