/**
 * EVERYTHING A PERSON CAN CHANGE FROM THE UI, ONCE (ledger #74).
 *
 * One entry per human write: the Save on the plan board, a child's needs, a van confirmed at the
 * ramp, Restart, a decision on a card, taking an alert — plus the two things the board does in the
 * browser before it saves (Auto-plan, a single move). Each entry is the input the screen sends,
 * already a zod schema, and the domain function the screen's route already called. Nothing moves
 * here: the functions are the ones they were, with the same refusals, locks and side effects.
 *
 * Two callers read this table. The routes and server actions behind the screens call `run`, and
 * the agent's action tools are generated from it (`modules/agent/action-tools.ts`), so the agent can
 * do exactly what a person can — no more, through no other path. `parity.test.ts` fails when a
 * screen gains a write this table does not hold.
 *
 * WHO MAY: `endpoint` names the action's row in the one access table (src/auth/access.ts). The
 * screens keep their own guard (`requireApiSession`); a caller with no screen in front of it — the
 * agent, acting for the person who asked — goes through `authorize`, which is the same row's roles
 * plus the membership check every id-taking handler runs (`requireSiteAccess`).
 *
 * `confirm` marks the three actions PRD §11.2 forbids the agent to take on its own (editing approved
 * needs, deciding an approval, Restart): the agent may only propose them, as a card a person presses.
 */
import { endpointRow } from "@/auth/access";
import { requireSiteAccess } from "@/auth/core";
import type { Exec } from "@/db/exec";
import { DECISION_ACTIONS } from "./decisions";
import { DEMO_ACTIONS } from "./demo";
import { PLAN_ACTIONS } from "./plan";
import type { ActionAnswer, ActionCtx, ActionEntry } from "./types";

export type { ActionAnswer, ActionCtx, ActionEntry } from "./types";

export const ACTIONS = { ...PLAN_ACTIONS, ...DEMO_ACTIONS, ...DECISION_ACTIONS } as const;

export type ActionName = keyof typeof ACTIONS;

/** Every entry, as a list — what the agent's tools and the parity test walk. */
export const ACTION_LIST: readonly ActionEntry<unknown>[] = Object.values(ACTIONS) as unknown as readonly ActionEntry<unknown>[];

/**
 * Which server-action export is which entry. One server-action file holds several actions under one
 * access row, so the parity test checks them by export name.
 */
export const SERVER_ACTION_EXPORTS: Readonly<Record<string, ActionName>> = {
  decideApprovalAction: "decide_approval",
  takeAlertAction: "take_alert",
};

/**
 * May this person take this action at this site? The action's own row's roles, and the person's
 * membership read from the database now (`requireSiteAccess`). Throws the same errors a route maps
 * to 401 / 403 / 404. For callers with no screen in front of them; the screens keep their guard.
 */
export async function authorize(db: Exec, ctx: ActionCtx, action: { readonly endpoint: string }): Promise<void> {
  const row = endpointRow(action.endpoint);
  if (!row || row.auth.kind !== "session") throw new Error(`no session row for ${action.endpoint}`);
  await requireSiteAccess(db, ctx.caller.userId, ctx.siteId, row.auth.roles);
}

/** Parse, then run: the one way a caller with untrusted input (the agent) takes an action. */
export async function runAction(name: ActionName, ctx: ActionCtx, raw: unknown): Promise<ActionAnswer> {
  const action = ACTIONS[name] as ActionEntry<unknown>;
  const parsed = action.input.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { ok: false, reason: "BAD_INPUT" } };
  return action.run(ctx, parsed.data);
}
