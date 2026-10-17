"use server";

/**
 * The two server actions behind the phone panel's composer (PRD §18.2 steps 9–10).
 *
 * They are actions rather than API routes because they are this screen's own controls and have no
 * other caller: a coordinator types a parent's text and presses a button, and what comes back is
 * the state the panel renders. Both are in the access table as actions
 * (src/auth/access.ts, `action:agent-turn` and `action:agent-approval`) and both check the caller
 * against the same row as the page itself — hiding a control is not a guard, and a server action
 * is a POST endpoint with no URL of its own.
 *
 * Neither writes anything. The first runs one agent turn (`modules/demo/agent-turn.ts`: the real
 * §11.1 prompt, the configured vendor with the PRD §18.1 keyword fallback, the real §11.2 policy
 * engine) and the second computes what approving its proposal would do. The *live* path that does
 * write is the webhook → run → queue one (`run/inbound-hook.ts`), which previews cannot run
 * because they hold the one production database read-only (DECISION-LEDGER #43).
 */
import { canOpenPage } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { demoDay } from "@/domain/board/day";
import {
  approveDropoff,
  demoAgentTurn,
  dropoffRequestIn,
  type ApprovedDropoff,
  type DemoAgentTurn,
} from "@/modules/demo/agent-turn";
import { apiAccess } from "@/ui/copy";

const PAGE = "/phone-preview";

/** What the panel renders after a turn: the turn itself, or the one sentence a refusal gets. */
export type TurnState =
  | { readonly status: "idle" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "answered"; readonly childKey: string; readonly text: string; readonly turn: DemoAgentTurn };

export type ApprovalState =
  | { readonly status: "idle" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "approved"; readonly applied: ApprovedDropoff };

async function allowed(): Promise<boolean> {
  return canOpenPage(await getCaller(), PAGE);
}

/** One agent turn over a staff-typed family text. */
export async function runAgentTurn(_previous: TurnState, form: FormData): Promise<TurnState> {
  if (!(await allowed())) return { status: "refused", message: apiAccess.notYourRole };
  const childKey = String(form.get("child") ?? "");
  const text = String(form.get("text") ?? "").trim().slice(0, 600);
  if (!childKey || !text) return { status: "idle" };
  const turn = await demoAgentTurn({ childKey, text, day: demoDay() });
  return { status: "answered", childKey, text, turn };
}

/**
 * Apply an approved proposal.
 *
 * The approval is re-derived from the child and the text rather than taken from the form: what a
 * coordinator approved is a *change*, and a value a browser posts back is not evidence of what
 * they were shown. On the live path the same decision is bound to `approvalKey` — the hash of the
 * exact call — which is what releases one specific call and nothing else (policy.ts).
 */
export async function approveAgentProposal(
  _previous: ApprovalState,
  form: FormData,
): Promise<ApprovalState> {
  if (!(await allowed())) return { status: "refused", message: apiAccess.notYourRole };
  const childKey = String(form.get("child") ?? "");
  const text = String(form.get("text") ?? "");
  const day = demoDay();
  const request = childKey && text ? dropoffRequestIn(childKey, text, day) : null;
  if (!request) return { status: "idle" };
  return { status: "approved", applied: approveDropoff(request, day) };
}
