/**
 * The plan board's and the ramp's writes, as actions (ledger #74): Save, Auto-plan, a single move,
 * the single-move endpoint, a van confirmed at the ramp, and a child's approved needs.
 */
import { z } from "zod";
import { API } from "@/auth/access";
import { autoPlan, BUCKETS, type BoardPlan } from "@/domain/plan/board";
import type { Direction } from "@/domain/day/leg";
import {
  childNeedsBody,
  placeChildBody,
  placeChildRequest,
  putVanSetupRequest,
  savePlanBody,
  savePlanRequest,
  setChildNeedsRequest,
  vanSetupBody,
  vanShortNotifier,
} from "@/modules/plan/api";
import { dayDataSource, loadBoard, planStore } from "@/modules/plan/store";
import { actionSummaries, fill } from "@/ui/copy";
import { getNeonDb } from "@/db/exec";
import { draftReplan } from "./draft";
import { entry, type ActionCtx } from "./types";

const LEG = z.enum(["AM", "PM"]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The board as the screen would load it now, for the two actions the board does in the browser. */
const boardFor = (ctx: ActionCtx, date: string, leg: Direction) =>
  loadBoard(ctx.deps?.store ?? planStore(), ctx.siteId, date, leg, ctx.deps?.source ?? dayDataSource(ctx.siteId));

/** `savePlanRequest` with the caller's board, when it brought one. */
const save = (ctx: ActionCtx, body: Parameters<typeof savePlanRequest>[2]) =>
  savePlanRequest(ctx.siteId, ctx.caller, body, ctx.now, ctx.deps?.store, ctx.deps?.source, ctx.deps?.notify, ctx.deps?.vanShort);

/** The moves that turn one plan into another, as PlanBoard's Auto-plan sends them (`planned`). */
function plannedMoves(before: BoardPlan, after: BoardPlan) {
  return Object.entries(after)
    .filter(([token, p]) => before[token]?.bucket !== p.bucket || before[token]?.vanId !== p.vanId)
    .map(([childToken, p]) => ({ childToken, bucket: p.bucket, vanId: p.vanId, planned: true }));
}

/**
 * WHATEVER CHANGES WHO RIDES, THE AGENT HEARS (ledger #79). A child marked away or a child's needs
 * changed can leave a van no longer fitting its riders, exactly as a save or a ramp count can — so
 * after either succeeds, the same van-fit reconcile runs (`plan/van-short.ts`): a van that no
 * longer fits raises the alert that starts the agent, one that fits again stands it down. Never a
 * reason the write failed.
 */
async function reconciled<A extends { status: number }>(ctx: ActionCtx, date: string, answer: A): Promise<A> {
  if (answer.status !== 200) return answer;
  const alerts = ctx.deps?.vanShort ?? vanShortNotifier();
  await alerts({
    siteId: ctx.siteId, date, by: `staff:${ctx.caller.userId ?? "unknown"}`, now: ctx.now,
    store: ctx.deps?.store ?? planStore(), source: ctx.deps?.source ?? dayDataSource(ctx.siteId),
  }).catch((e) => console.error("[plan] van-short not reconciled", e instanceof Error ? e.message : e));
  return answer;
}

export const PLAN_ACTIONS = {
  /** The plan board's Save: the pending moves, in one transaction. */
  save_plan: entry({
    name: "save_plan",
    endpoint: API.planSave,
    input: savePlanBody,
    confirm: false,
    describe: (i) => fill(actionSummaries.savePlan, { leg: i.direction, count: i.moves.length }),
    run: (ctx, i) => save(ctx, i),
  }),
  /**
   * Re-plan (ledger #76): Auto-plan this leg into **a draft card** saying what it would change and
   * what that does to the day. Nothing is saved — Approve on the card is the save. The ramp's
   * Re-plan and the agent's `auto_plan` both run this, so a person and the agent get the same card.
   */
  auto_plan: entry({
    name: "auto_plan",
    endpoint: API.planReplan,
    input: z.strictObject({ date: DATE, direction: LEG, note: z.string().min(1).max(600).nullable().optional() }),
    confirm: false,
    describe: (i) => fill(actionSummaries.autoPlan, { leg: i.direction }),
    run: async (ctx, i) => {
      if (!ctx.caller.userId) return { status: 401, body: { ok: false, reason: "SIGN_IN" } };
      const db = ctx.deps?.db ?? getNeonDb();
      const drafted = await draftReplan(
        db,
        { store: ctx.deps?.store ?? planStore(), source: ctx.deps?.source ?? dayDataSource(ctx.siteId) },
        { siteId: ctx.siteId, date: i.date, leg: i.direction, by: `staff:${ctx.caller.userId}`, note: i.note ?? null, now: ctx.now },
      );
      return drafted.drafted
        ? { status: 200, body: { ok: true, drafted: true, cardId: drafted.approvalId } }
        : { status: 200, body: { ok: true, drafted: false, reason: drafted.reason, ...("children" in drafted ? { children: drafted.children } : {}) } };
    },
  }),
  /** One child to one place — a drag and a Save, as a person makes it (so it is pinned). */
  move_child: entry({
    name: "move_child",
    endpoint: API.planSave,
    input: z.strictObject({
      date: DATE,
      direction: LEG,
      childToken: z.string().min(1).max(64),
      bucket: z.enum(BUCKETS),
      vanId: z.string().min(1).max(64).nullable().optional(),
    }),
    confirm: false,
    describe: (i) => fill(actionSummaries.moveChild, { leg: i.direction }),
    run: async (ctx, i) => {
      const view = await boardFor(ctx, i.date, i.direction);
      const move = { childToken: i.childToken, bucket: i.bucket, vanId: i.bucket === "VAN" ? (i.vanId ?? null) : null };
      return save(ctx, { date: i.date, direction: i.direction, version: view.version, moves: [move] });
    },
  }),
  /** One child's placement, written at once (the board's single-move endpoint). */
  place_child: entry({
    name: "place_child",
    endpoint: API.planPlace,
    input: placeChildBody,
    confirm: false,
    describe: (i) => fill(actionSummaries.moveChild, { leg: i.direction }),
    run: async (ctx, i) => reconciled(ctx, i.date, await placeChildRequest(ctx.siteId, ctx.caller, i, ctx.now, ctx.deps?.store)),
  }),
  /** A van's counts as the ramp found them. */
  confirm_van_setup: entry({
    name: "confirm_van_setup",
    endpoint: API.vanSetup,
    input: vanSetupBody.extend({ vanId: z.string().min(1).max(64) }),
    confirm: false,
    describe: () => actionSummaries.confirmVan,
    run: (ctx, { vanId, ...i }) =>
      putVanSetupRequest(ctx.siteId, ctx.caller, vanId, i, ctx.now, ctx.deps?.store, ctx.deps?.vanShort, ctx.deps?.source),
  }),
  /** A child's approved needs (PRD §11.2: never the agent's alone — a person confirms). */
  set_child_needs: entry({
    name: "set_child_needs",
    endpoint: API.childNeeds,
    input: childNeedsBody.extend({ childToken: z.string().min(1).max(64) }),
    confirm: true,
    describe: () => actionSummaries.setNeeds,
    run: async (ctx, { childToken, ...i }) =>
      reconciled(ctx, i.date, await setChildNeedsRequest(ctx.siteId, ctx.caller, childToken, i, ctx.now, ctx.deps?.store, process.env, ctx.deps?.db ?? null, ctx.deps?.source)),
  }),
} as const;
