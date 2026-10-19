"use server";

/**
 * The "For you" tab's one control (PRD §18.2 steps 9–10, §11.2 human tier; AT-01, AT-09).
 *
 * Approve, Edit and Don't send are **one** action and **one** write path: `decideApproval` in
 * `@/modules/approvals/decide`. Firia's gate 1 is that there is no second one, and the shape of
 * this file is how that is true rather than merely intended — it reads a form, calls that one
 * function, and turns a status into the sentence the screen shows. Edit is the same call with the
 * coordinator's words on it; Don't send is the same call with `DECLINED`. Nothing here writes
 * anything.
 *
 * A server action rather than an API route because it is this screen's own button, and it carries
 * its own row in the one access table (`action:approval-decision`): a server action **is** a POST
 * endpoint with no URL of its own, and hiding a button is not a guard.
 *
 * ## The role check, twice, and neither is redundant
 *
 * `APPROVAL_ROLES` here refuses a role outright, before anything is read. `decideApproval` checks
 * the same constant again *together with the caller's membership at the approval's own site* —
 * the check that cannot be made here, because the site is a property of the row and not of the
 * request. Veri's merge blocker is why both read the named constant in `src/auth/access.ts`
 * instead of the roles of some page: `/exceptions` is being redesigned away, and a permission
 * read off a route is a permission a route change can move.
 *
 * ## The plan it saves
 *
 * An approved change or cancel saves a new plan version through the board's own
 * `setChildPlacement` (`modules/approvals/plan-placement-port.ts`) — this file passes no writer of
 * its own, so the default `decideApproval` uses is that one and there is no second path into
 * `plan_run` / `plan_assignment`. If the board refuses, the whole decision rolls back and the
 * family is not texted (Firia's gap-5 ruling: fail safe, never a fake success).
 */
import { revalidatePath } from "next/cache";
import { APPROVAL_ROLES } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { APPROVALS_PAGE, type ApprovalDecision, type DecideError } from "@/modules/approvals/decide";
/*
 * The one action layer. This is a server-action module, so everything the registry imports is on
 * the bundle walk's server graph — and the agent's config and provider errors must not be
 * (key-never-leaves.test.ts, vendor-failure-panel.test.ts): the registry takes `openAlert` from
 * `alert-task.ts`, never from `staff-alert.ts`.
 */
// Only the decisions group: the page's graph stays free of the plan writers and the demo seed.
import { DECISION_ACTIONS as ACTIONS } from "@/modules/actions/decisions";
import { screenCtx } from "@/modules/actions/screen";
import { approval as approvalCopy } from "@/ui/copy";

/** What the screen renders after a decision: what happened, or the one sentence a refusal gets. */
export type DecisionState =
  | { readonly status: "idle" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "decided"; readonly decision: ApprovalDecision; readonly text: string; readonly queued: number };

/**
 * The action's own shape, named here so the card can take it as a prop without writing an arrow
 * type of its own: `copy.test.ts` scans every `.tsx` for JSX text nodes, and a
 * `=> Promise<DecisionState>` in a component's props reads to that scanner as markup. A `.ts`
 * module is not scanned that way, so the type lives where it belongs anyway — beside the action.
 */
export type DecideAction = (previous: DecisionState, form: FormData) => Promise<DecisionState>;

/**
 * The words for each refusal. Codes stay in the model and never reach a screen (COPY-GUIDE §2):
 * this is the one place they become sentences, and every one of them says what happened and what
 * the person reading it can do.
 */
const REFUSALS: Readonly<Record<DecideError, string>> = {
  SIGN_IN: approvalCopy.signInAgain,
  NOT_YOUR_ROLE: approvalCopy.notYourRole,
  NO_SUCH_APPROVAL: approvalCopy.noSuchApproval,
  ALREADY_DECIDED: approvalCopy.alreadyDecided,
  PLAN_MOVED: approvalCopy.planMoved,
  NOT_EDITABLE: approvalCopy.notEditable,
  EDIT_NOT_SENDABLE: approvalCopy.editNotSendable,
  MESSAGE_CHANGED: approvalCopy.messageChanged,
  PLAN_NOT_SAVED: approvalCopy.planNotSaved,
  TIME_NOT_SAVED: approvalCopy.timeNotSaved,
};

/**
 * The pages a decision changes. `APPROVALS_PAGE` is the card's own; the other three read the plan
 * this decision just moved (`modules/plan/leg-facts.ts`, `modules/plan/store.ts`).
 */
const CHANGED_BY_A_DECISION = [APPROVALS_PAGE, "/today", "/plan-routes", "/live-map"] as const;

export async function decideApprovalAction(
  _previous: DecisionState,
  form: FormData,
): Promise<DecisionState> {
  const caller = await getCaller();
  const role = caller.kind === "STAFF" ? caller.role : null;
  if (role === null || !APPROVAL_ROLES.includes(role)) {
    return { status: "refused", message: approvalCopy.notYourRole };
  }
  const approvalId = String(form.get("approval") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (!approvalId || (decision !== "APPROVED" && decision !== "DECLINED")) return { status: "idle" };

  /*
   * THE COORDINATOR'S WORDS, when the card was in its Edit state. Not trusted as anything but a
   * candidate: `decideApproval` holds them to the reply rule and refuses the decision otherwise.
   */
  const edited = form.get("edited");
  /*
   * THE WORDS THE SCREEN SHOWED, carried with the decision (S1-7).
   *
   * Not trusted as copy — nothing is sent from it, and `decideApproval` renders the message from
   * the row either way. It is trusted as an *answer*: this is what the person who pressed the
   * button had in front of them, and a decision whose words no longer match the row is refused
   * rather than sent. That is what makes "an edit needs fresh approval" structural instead of a
   * habit of the screen.
   */
  const shown = form.get("text");
  /*
   * THE ONE ACTION LAYER (modules/actions/registry.ts, ledger #74): the same `decide_approval` the
   * agent's confirm card runs. The actor is the caller off the session — never a user id the form
   * carried, which would be one an attacker chooses; `decideApproval` re-reads their membership.
   */
  if (caller.kind !== "STAFF") return { status: "refused", message: approvalCopy.notYourRole };
  const answer = await ACTIONS.decide_approval.run(screenCtx(caller), {
    approvalId,
    decision: decision as ApprovalDecision,
    editedText: typeof edited === "string" ? edited : null,
    approvedText: shown === null ? undefined : String(shown),
  });

  if (!answer.body.ok) return { status: "refused", message: REFUSALS[answer.body.error] };
  /*
   * EVERY SCREEN THAT SHOWS THE RIDE, not just the one the button is on (Firia, 11:11 AM ET
   * 2026-10-18: "without a second Save").
   *
   * An approved change writes the plan — the placement, the leg's drop-off time, the receiver on
   * the child's file — and three screens render that plan from rows: the board, the plan routes
   * board and the live map. They are server components behind `force-dynamic`, so what they need
   * is for this request to drop their cached render, which is what each of these does. Same
   * mechanism the rest of the app uses after a write; a coordinator who presses Approve and walks
   * to Today must not have to save anything to see the time they just agreed.
   */
  for (const path of CHANGED_BY_A_DECISION) revalidatePath(path);
  return {
    status: "decided",
    decision: answer.body.decision,
    text: answer.body.text,
    queued: answer.body.queued,
  };
}

/**
 * MARK A "NEEDS A PERSON" ALERT TAKEN — on a press, and on nothing else (Firia's S1-4,
 * 2026-10-18 12:13 AM ET).
 *
 * `openAlert` is an UPDATE: `OPEN → IN_PROGRESS`. It used to run inside the `/exceptions` page's
 * GET render, so the act of *looking* claimed the alert — which meant a link prefetch could claim
 * one nobody had read, and a reload could tell a second coordinator that somebody was already on
 * it. A state change belongs to a POST, and a server action is a POST.
 *
 * Nothing on the "For you" tab's render path calls `openAlert` any more; the only caller in
 * `src/app` is this function. `src/app/(app)/family-texts/alert-taken-on-post.test.ts` holds both
 * halves of that.
 *
 * Same two role checks as the decision above, for the same two reasons: `APPROVAL_ROLES` refuses
 * a role outright here, and the UPDATE is scoped to the caller's own memberships, which is the
 * check that cannot be made from the request alone. A front desk reaches neither the page nor
 * this action.
 */
export async function takeAlertAction(form: FormData): Promise<void> {
  const caller = await getCaller();
  const role = caller.kind === "STAFF" ? caller.role : null;
  if (role === null || !APPROVAL_ROLES.includes(role)) return;
  const id = String(form.get("alert") ?? "");
  if (!id) return;
  if (caller.kind !== "STAFF") return;
  // The one action layer (ledger #74), scoped to the caller's own centre off the session: an id
  // from another tenant updates nothing because it is not at that site, not because the row said so.
  await ACTIONS.take_alert.run(screenCtx(caller), { alertId: id });
  revalidatePath(APPROVALS_PAGE);
}

/** The take action's shape, for the same `.tsx`-scanner reason as `DecideAction` above. */
export type TakeAlertAction = (form: FormData) => Promise<void>;
