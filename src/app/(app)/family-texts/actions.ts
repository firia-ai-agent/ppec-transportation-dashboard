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
 * §11.1 prompt, the configured vendor, the real §11.2 policy engine) and the second computes what
 * approving its proposal would do. The *live* path that does write is the webhook → run → queue
 * one (`run/inbound-hook.ts`), which previews cannot run because they hold the one production
 * database read-only (DECISION-LEDGER #43).
 *
 * There is no reader behind the model. If no model answers, the turn comes back
 * `modelUnavailable` and the panel shows the "needs a person" alert — nothing in here looks at
 * the family's words to work out what they wanted (founder, 2026-10-17).
 */
import { canOpenPage } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { demoDay } from "@/domain/board/day";
import {
  approveDropoff,
  demoAgentTurn,
  dropoffFromCall,
  type ApprovedDropoff,
  type DemoAgentTurn,
} from "@/modules/demo/agent-turn";
import { apiAccess, familyTexts } from "@/ui/copy";

const PAGE = "/family-texts";

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

/**
 * One agent turn over a staff-typed family text.
 *
 * The `catch` is not defensive habit, it is the panel's only way to say the thing out loud. A turn
 * that throws has no state in `useActionState` — React re-raises it, Next shows its error boundary
 * and the screen says nothing about the assistant at all. What throws is a configuration this
 * build can make no provider from — an agent config it cannot parse, a base URL off the host
 * allow-list. A deployment that merely may not *call* a vendor does not throw: the turn comes
 * back `answered` with `modelUnavailable`, which the panel renders as the alert.
 *
 * The error itself is not shown and not logged here: the refusals name an environment variable but
 * a thrown message is not copy, and the words a coordinator reads live in `ui/copy.ts`.
 */
export async function runAgentTurn(_previous: TurnState, form: FormData): Promise<TurnState> {
  if (!(await allowed())) return { status: "refused", message: apiAccess.notYourRole };
  const childKey = String(form.get("child") ?? "");
  const text = String(form.get("text") ?? "").trim().slice(0, 600);
  if (!childKey || !text) return { status: "idle" };
  try {
    const turn = await demoAgentTurn({ childKey, text, day: demoDay() });
    return { status: "answered", childKey, text, turn };
  } catch {
    return { status: "refused", message: familyTexts.assistantUnavailable };
  }
}

/**
 * Apply an approved proposal.
 *
 * The change is re-derived from the model's own tool call rather than trusted as posted: the form
 * carries the call back, and `dropoffFromCall` re-reads it, so the only thing that can become a
 * change is a `propose_dropoff_change` with a schema-shaped time or one of the centre's own stop
 * tokens. On the live path the same decision is bound to `approvalKey` — the hash of the exact
 * call — which is what releases one specific call and nothing else (policy.ts).
 */
export async function approveAgentProposal(
  _previous: ApprovalState,
  form: FormData,
): Promise<ApprovalState> {
  if (!(await allowed())) return { status: "refused", message: apiAccess.notYourRole };
  const childKey = String(form.get("child") ?? "");
  const tool = String(form.get("tool") ?? "");
  const day = demoDay();
  /*
   * The proposal, re-derived from the **model's own arguments** as the form carries them back,
   * and then re-read through the same `dropoffFromCall` the turn used. A browser can post any
   * shape it likes; what survives is a `propose_dropoff_change` with a schema-shaped time or one
   * of the centre's own stop tokens, which is the only thing that can become a change.
   */
  let args: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(String(form.get("args") ?? "{}"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) args = raw as Record<string, unknown>;
  } catch {
    return { status: "idle" };
  }
  const request = childKey ? dropoffFromCall(childKey, tool, args, day) : null;
  if (!request) return { status: "idle" };
  return { status: "approved", applied: approveDropoff(request, day) };
}
