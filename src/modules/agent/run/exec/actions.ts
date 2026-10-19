/**
 * THE AGENT ACTS AS THE PERSON WHO ASKED (ledger #74).
 *
 * The executors behind the action tools (`agent/action-tools.ts`) and the staff read tools. An
 * action runs through the one action layer (`modules/actions/registry.ts`): the same function the
 * screen's button runs, as the staff member whose ask started this run, with that person's role
 * checked against the action's own access row and their membership read from the database now
 * (`authorize`). A run nobody asked for — a family's text, an alert — has no person to act as and
 * acts as nobody: the executor refuses by name (`NO_PERSON_TO_ACT_FOR`), and such runs are never
 * offered these tools anyway (assembler.ts).
 *
 * An action the screen would refuse — a plan that moved under it, a van that does not fit — is not a
 * broken step: it is an answer, and it goes back to the model as one (`ok=false reason=…`), so the
 * agent can say what happened or try another way. Only a refusal of the *person* (no role, not a
 * member) is a failure.
 */
import { ALL_STAFF } from "@/auth/access";
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import { ridersInVan, shortfallsOfDay, usedInVan } from "@/domain/plan/board";
import { fits } from "@/domain/plan/fit";
import { hhmmOf, madeLate } from "@/domain/plan/arrivals";
import type { Placement } from "@/domain/plan/board";
import { notifyGateConfig } from "@/config/live";
import { pendingApprovals } from "@/modules/approvals/decide";
import { ACTIONS, authorize, runAction, type ActionCtx, type ActionName } from "@/modules/actions/registry";
import { actionDepsFor } from "@/modules/actions/deps";
import { dayDataSource, loadBoard, planStore } from "@/modules/plan/store";
import { ACTION_TOOLS, type ActionTool } from "../../action-tools";
import { STAFF_ALERT_TASK_CATEGORY, STAFF_ASK_TASK_CATEGORY } from "../../ask/ask-text";
import type { ToolExecutor, ToolExecutors } from "../executors";
import type { ExecutorDeps } from "./effects";
import { failed } from "./effects";

/** The staff member a run acts for: the one whose ask started it. Null for every other run. */
export async function askerOf(
  deps: Pick<ExecutorDeps, "db">,
  call: { readonly trigger: { readonly type: string; readonly id: string }; readonly siteId: string },
): Promise<ActionCtx["caller"] | null> {
  if (call.trigger.type !== "staff.ask") return null;
  const row = (
    await deps.db.query<{ created_by: string }>(
      "SELECT created_by FROM ops.task WHERE id = $1 AND site_id = $2 AND category = $3",
      [call.trigger.id, call.siteId, STAFF_ASK_TASK_CATEGORY],
    )
  ).rows[0];
  const userId = /^staff:([0-9a-f-]{36})$/i.exec(row?.created_by ?? "")?.[1];
  if (!userId) return null;
  try {
    const membership = await requireSiteAccess(deps.db, userId, call.siteId, ALL_STAFF);
    return { userId, role: membership.role };
  } catch {
    return null;
  }
}

/** A plan board read for the version a write must name (never the model's). */
const versionAt = (ctx: ActionCtx) => async (date: string, leg: "AM" | "PM") =>
  (await loadBoard(ctx.deps?.store ?? planStore(), ctx.siteId, date, leg, ctx.deps?.source ?? dayDataSource(ctx.siteId))).version;

function actionExecutor(deps: ExecutorDeps, tool: ActionTool): ToolExecutor {
  return async (call) => {
    const caller = await askerOf(deps, call);
    if (!caller) return failed("NO_PERSON_TO_ACT_FOR");
    // On the run's own connection: the same SQL board the screens read on a deployment.
    const ctx: ActionCtx = { siteId: call.siteId, caller, now: call.now, deps: actionDepsFor(deps.db, call.siteId) };
    const action = ACTIONS[tool.action as ActionName];
    try {
      await authorize(deps.db, ctx, action);
    } catch (e) {
      if (e instanceof Forbidden) return failed("NOT_YOUR_ROLE");
      if (e instanceof SiteNotFound || e instanceof Unauthenticated) return failed("NOT_A_MEMBER");
      throw e;
    }
    const answer = await runAction(tool.action as ActionName, ctx, await tool.toInput(call.args, versionAt(ctx)));
    const body = (answer.body ?? {}) as Record<string, unknown>;
    const ok = answer.status === 200 && body.ok !== false;
    return {
      status: "executed",
      data: { action: tool.action, http_status: answer.status, acted_for: `staff:${caller.userId}` },
      // What happened, as codes and counts: the model reports it to the person in its own words.
      promptFacts: {
        action: tool.action,
        ok,
        ...(ok ? {} : { reason: String(body.reason ?? body.error ?? answer.status) }),
        ...(typeof body.version === "number" ? { plan_version: body.version } : {}),
      },
    };
  };
}

/** The plan board as the person sees it: each van's counts and riders, and who does not fit. */
function getPlanExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const board = actionDepsFor(deps.db, call.siteId);
    const view = await loadBoard(board.store!, call.siteId, String(call.args.date), call.args.leg as "AM" | "PM", board.source);
    const facts: Record<string, string | number | boolean> = { plan_version: view.version, saved: view.version > 0 };
    for (const van of view.day.vans) {
      const riders = ridersInVan(view.day, view.plan, van.id);
      const used = usedInVan(view.day, view.plan, van.id);
      facts[`van_${van.slot}`] =
        `id=${van.id} name=${van.name} seats=${used.seats}/${van.setup.seats} wheelchair=${used.wheelchairSpots}/${van.setup.wheelchairSpots} ` +
        `car_seats=${used.carSeats}/${van.setup.carSeats} oxygen=${used.oxygenMounts}/${van.setup.oxygenMounts} ` +
        `lift=${van.setup.hasLift} fits=${fits(van.setup, riders)} riders=${riders.map((r) => `${r.name}:${r.token}`).join(",") || "none"}`;
    }
    const short = shortfallsOfDay(view.day, view.plan);
    facts.does_not_fit = short.map((s) => `${view.day.riders.find((r) => r.token === s.token)?.name ?? s.token}:${s.shortfall.reason}`).join(",") || "none";
    const moves = Array.isArray(call.args.moves) ? (call.args.moves as { child_token: string; bucket: Placement["bucket"]; van_id?: string | null }[]) : [];
    if (moves.length > 0) Object.assign(facts, previewFacts(view, moves));
    return { status: "executed", data: { plan_version: view.version }, promptFacts: facts };
  };
}

/**
 * WHAT A CHANGE WOULD DO, BEFORE ANYBODY MAKES IT (ledger #75): the moves applied to the board in
 * memory, then each van's fit and who would get home late by the rule the late texts are sent by
 * (`domain/plan/arrivals.ts madeLate`). So "Ava would be about 10 min later and her family gets a
 * text" is a number the agent read, not one it guessed. Nothing is saved.
 */
function previewFacts(
  view: Awaited<ReturnType<typeof loadBoard>>,
  moves: readonly { child_token: string; bucket: Placement["bucket"]; van_id?: string | null }[],
): Record<string, string | boolean> {
  const plan: Record<string, Placement> = { ...view.plan };
  for (const m of moves) {
    const was = plan[m.child_token];
    if (!was) continue;
    plan[m.child_token] = { ...was, bucket: m.bucket, vanId: m.bucket === "VAN" ? (m.van_id ?? null) : null };
  }
  const name = (token: string) => view.day.riders.find((r) => r.token === token)?.name ?? token;
  const facts: Record<string, string | boolean> = { preview: true };
  for (const van of view.day.vans) facts[`preview_van_${van.slot}_fits`] = fits(van.setup, ridersInVan(view.day, plan, van.id));
  facts.preview_home_late =
    madeLate(view.day, view.plan, plan, notifyGateConfig.shiftSeconds / 60)
      .map((l) => `${name(l.token)}:+${Math.round(l.late)}min_home_${hhmmOf(Math.round(l.arrival.arrivesAtMinute))}`)
      .join(",") || "none";
  return facts;
}

/** Open alerts a coordinator sees, newest first (never the agent's own bookkeeping rows). */
function getAlertsExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const rows = (
      await deps.db.query<{ id: string; category: string; severity: string; summary: string }>(
        `SELECT id, category, severity, summary FROM ops.task
          WHERE site_id = $1 AND state IN ('OPEN', 'IN_PROGRESS') AND category NOT IN ($2, $3) AND category NOT LIKE 'AGENT\\_%'
          ORDER BY created_at DESC LIMIT 10`,
        [call.siteId, STAFF_ASK_TASK_CATEGORY, STAFF_ALERT_TASK_CATEGORY],
      )
    ).rows;
    const facts: Record<string, string | number> = { open_alerts: rows.length };
    rows.forEach((r, i) => (facts[`alert_${i + 1}`] = `id=${r.id} ${r.severity} ${r.category}: ${r.summary.slice(0, 160)}`));
    return { status: "executed", data: { open_alerts: rows.length }, promptFacts: facts };
  };
}

/** The cards waiting for a person: the family replies (For you) and the confirm cards. */
function getCardsExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const replies = await pendingApprovals(deps.db, [call.siteId]);
    const confirms = (
      await deps.db.query<{ id: string; summary: string | null }>(
        `SELECT id, proposal->>'summary' AS summary FROM ops.approval_request
          WHERE site_id = $1 AND decided_at IS NULL AND proposal->>'kind' = 'STAFF_ACTION' ORDER BY created_at`,
        [call.siteId],
      )
    ).rows;
    const facts: Record<string, string | number> = { cards: replies.length + confirms.length };
    replies.forEach((r, i) => (facts[`reply_card_${i + 1}`] = `id=${r.id} child=${r.childLabel} text=${r.text.slice(0, 200)}`));
    confirms.forEach((c, i) => (facts[`confirm_card_${i + 1}`] = `id=${c.id} ${c.summary ?? ""}`));
    return { status: "executed", data: { cards: replies.length + confirms.length }, promptFacts: facts };
  };
}

/** Every staff executor: the auto-tier action tools and the reads. Human-tier ones are proposals. */
export function staffExecutors(deps: ExecutorDeps): ToolExecutors {
  return {
    ...Object.fromEntries(ACTION_TOOLS.filter((t) => t.tier === "auto").map((t) => [t.name, actionExecutor(deps, t)])),
    get_plan: getPlanExecutor(deps),
    get_alerts: getAlertsExecutor(deps),
    get_cards: getCardsExecutor(deps),
  };
}
