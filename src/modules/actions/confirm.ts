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
import { STALE_PLAN_CARD_SQL, changeKey } from "./confirm-cards";
import { cardChild } from "./stale-notes";
import { resolveTask } from "@/modules/approvals/decide";
import { loadBoard } from "@/modules/plan/store";
import { confirmCopy } from "@/ui/copy";
import { serviceDateIso } from "@/ui/service-date";
import { refusalLogLine, refusalOf, type Refusal } from "@/modules/changes/refusal";
import { answeredByDecision, raiseNeedsPerson } from "@/modules/agent/needs-person";
import { actionDepsFor } from "./deps";
import { staffActionOutcome } from "./outcome";
import type { ActionDeps } from "./types";
import { ACTIONS, authorize, runAction, type ActionCtx, type ActionName } from "./registry";

export type ConfirmDecision = "APPROVED" | "DECLINED";

export type ConfirmAnswer =
  | { readonly status: 200; readonly body: { readonly ok: true; readonly decision: ConfirmDecision } }
  | {
      readonly status: 401 | 403 | 404 | 409 | 422;
      readonly body: { readonly ok: false; readonly error: "SIGN_IN" | "NOT_YOUR_ROLE" | "NO_SUCH_CARD" | "ALREADY_DECIDED" | "ACTION_REFUSED"; readonly reason?: string; readonly refusal?: Refusal };
    };

/** The agent's plan cards that must carry `basis_version` (PPE-112). */
const AGENT_PLAN_TOOLS: ReadonlySet<string> = new Set(["save_plan", "move_child"]);

export async function confirmStaffAction(
  db: Db,
  req: { readonly userId?: string; readonly approvalId: string; readonly decision: ConfirmDecision; readonly now: Date },
  /** Over the defaults `actionDepsFor(db)` gives — a test's outbox, say. */
  deps: ActionDeps = {},
): Promise<ConfirmAnswer> {
  if (!req.userId) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
  const row = (
    await db.query<{ id: string; site_id: string; task_id: string; created_by: string | null; stale: boolean; proposal: { kind?: string; tool?: string; args?: Record<string, unknown> } }>(
      `SELECT a.id, a.site_id, a.task_id, a.created_by, a.proposal, ${STALE_PLAN_CARD_SQL} AS stale FROM ops.approval_request a
        WHERE a.id = $1 AND a.decided_at IS NULL AND a.proposal->>'kind' = $2`,
      [/^[0-9a-f-]{36}$/i.test(req.approvalId) ? req.approvalId : null, STAFF_ACTION_KIND],
    )
  ).rows[0];
  if (!row) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };
  const tool = actionTool(String(row.proposal.tool ?? ""));
  if (!tool) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };

  let ctx: ActionCtx;
  try {
    const membership = await requireSiteAccess(db, req.userId, row.site_id, ALL_STAFF);
    ctx = { siteId: row.site_id, caller: { userId: req.userId, role: membership.role }, now: req.now, deps: { ...actionDepsFor(db, row.site_id), ...deps } };
    if (req.decision === "APPROVED") await authorize(db, ctx, ACTIONS[tool.action as ActionName]);
  } catch (e) {
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: "NOT_YOUR_ROLE" } };
    throw e;
  }

  /*
   * A PLAN CARD IS JUDGED AT APPROVE AS THE LIST JUDGES IT (PPE-112): one the board has moved past
   * is refused by id too, never applied over the newer save. And an agent's `save_plan` /
   * `move_child` card must name the board it was written on — without a numeric `basis_version`
   * Approve would read the version now and write over whatever was saved since, so it is refused.
   * Nothing is claimed; a move a person makes on the board itself never comes through here.
   */
  if (req.decision === "APPROVED") {
    const agentPlanCard = AGENT_PLAN_TOOLS.has(tool.name) && (row.created_by ?? "").startsWith("agent:");
    if (row.stale || (agentPlanCard && typeof row.proposal.args?.basis_version !== "number")) {
      const args = row.proposal.args ?? {};
      const at = { date: String(args.date ?? serviceDateIso(req.now)), leg: args.leg === "AM" ? ("AM" as const) : ("PM" as const) };
      const board = await loadBoard(ctx.deps!.store!, row.site_id, at.date, at.leg, ctx.deps!.source).catch(() => null);
      const refusal = refusalOf({ reason: "STALE_CARD", vanId: null, childToken: cardChild(args) }, at, board);
      console.warn(refusalLogLine("confirm", refusal), row.stale ? "stale" : "no-basis");
      return { status: 422, body: { ok: false, error: "ACTION_REFUSED", reason: refusal.reason, refusal } };
    }
  }

  /*
   * ONE CHANGE, ONE PRESS (Athena). The list offers the first of several pending cards for the same
   * change (`confirm-cards.ts changeKey`); a twin it hides is refused by id too, so a stale or
   * scripted press on it can neither apply the change twice nor undo a Don't.
   */
  const twins = await pendingTwins(db, row);
  if (twins.earlier.length > 0) return { status: 404, body: { ok: false, error: "NO_SUCH_CARD" } };

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
      /*
       * A REFUSED CONFIRM IS LOUD (ledger #80): the action's own reason, with the van and child it
       * names, goes to the person who pressed it, into the log, and onto the "needs a person" card.
       */
      const args = row.proposal.args ?? {};
      const at = { date: String(args.date ?? serviceDateIso(req.now)), leg: args.leg === "AM" ? ("AM" as const) : ("PM" as const) };
      const board = await loadBoard(ctx.deps!.store!, row.site_id, at.date, at.leg, ctx.deps!.source).catch(() => null);
      const refusal = refusalOf(
        { reason: String(body.reason ?? body.error ?? answer.status), vanId: typeof body.vanId === "string" ? body.vanId : null, childToken: typeof body.childToken === "string" ? body.childToken : null },
        at,
        board,
      );
      console.warn(refusalLogLine("confirm", refusal));
      await raiseNeedsPerson(db, { siteId: row.site_id, messageId: null, reason: "refused", refusal, key: `approval:${row.id}:${refusal.reason}`, approvalId: row.id, by })
        .catch((e) => console.error("[confirm] needs-person not raised", e instanceof Error ? e.message : e));
      return { status: 422, body: { ok: false, error: "ACTION_REFUSED", reason: refusal.reason, refusal } };
    }
  }
  await db.tx(async (tx) => {
    await resolveTask(tx, row.task_id, req.decision, by);
    // The hidden twins of this card are the same change: decided with it, so none resurfaces.
    for (const twin of twins.later) {
      const closed = await tx.query<{ task_id: string }>(
        `UPDATE ops.approval_request SET decision = $3, decided_by = $4, decided_at = $5, updated_at = $5, updated_by = $6, version = version + 1,
                proposal = proposal || jsonb_build_object('superseded_by', $7::text)
          WHERE id = $1 AND site_id = $2 AND decided_at IS NULL RETURNING task_id`,
        [twin, row.site_id, req.decision, req.userId, req.now, by, row.id],
      );
      for (const t of closed.rows) await resolveTask(tx, t.task_id, req.decision, by);
    }
    // A refused press on this card raised a "needs a person"; deciding it answers that too (ledger #80).
    await answeredByDecision(tx, row.id, (t, id) => resolveTask(t, id, req.decision, by));
  });
  // The card leaves one line saying how it went (ledger #75 c); a failure to word it changes nothing done.
  const outcome =
    req.decision === "APPROVED"
      ? await staffActionOutcome(db, { siteId: row.site_id, tool: tool.name, args: row.proposal.args ?? {}, since: req.now, deps: ctx.deps! }).catch(() => confirmCopy.done)
      : confirmCopy.declined;
  await db.query(
    "UPDATE ops.approval_request SET proposal = proposal || jsonb_build_object('outcome', $2::text) WHERE id = $1",
    [row.id, outcome],
  );
  return { status: 200, body: { ok: true, decision: req.decision } };
}

/**
 * The other pending cards for the same change as `row`, at its centre, split by whether the list
 * would offer them before it (same order as `confirmCards`: created_at, id).
 */
async function pendingTwins(
  db: Db,
  row: { id: string; site_id: string; proposal: { tool?: string; args?: Record<string, unknown> } },
): Promise<{ earlier: string[]; later: string[] }> {
  const key = changeKey(String(row.proposal.tool ?? ""), row.proposal.args ?? {});
  const rows = (
    await db.query<{ id: string; tool: string | null; args: Record<string, unknown> | null; earlier: boolean }>(
      `SELECT a.id, a.proposal->>'tool' AS tool, a.proposal->'args' AS args,
              (a.created_at, a.id) < (SELECT b.created_at, b.id FROM ops.approval_request b WHERE b.id = $3) AS earlier
         FROM ops.approval_request a
        WHERE a.site_id = $1 AND a.decided_at IS NULL AND a.proposal->>'kind' = $2 AND a.id <> $3
          AND a.proposal->>'tool' = $4 AND NOT ${STALE_PLAN_CARD_SQL}`,
      [row.site_id, STAFF_ACTION_KIND, row.id, String(row.proposal.tool ?? "")],
    )
  ).rows.filter((r) => changeKey(r.tool ?? "", r.args ?? {}) === key);
  return { earlier: rows.filter((r) => r.earlier).map((r) => r.id), later: rows.filter((r) => !r.earlier).map((r) => r.id) };
}
