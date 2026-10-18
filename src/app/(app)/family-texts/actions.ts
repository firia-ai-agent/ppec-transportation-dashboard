"use server";

/**
 * The "For you" tab's one control (PRD §18.2 steps 9–10, §11.2 human tier; AT-01, AT-09).
 *
 * Approve, Edit and Don't send are **one** action and **one** write path: `decideApproval` in
 * `@/modules/approvals/decide`. Firia's gate 1 is that there is no second one, and the shape of
 * this file is how that is true rather than merely intended — it reads a form, calls that one
 * function, and turns a status into the sentence the screen shows. Edit is the same call with a
 * time on it; Don't send is the same call with `DECLINED`. Nothing here writes anything.
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
import { getNeonDb } from "@/db/exec";
import {
  APPROVALS_PAGE,
  type ApprovalDecision,
  type DecideError,
  decideApproval,
} from "@/modules/approvals/decide";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
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
  NOT_A_TIME: approvalCopy.notATime,
  PLAN_NOT_SAVED: approvalCopy.planNotSaved,
};

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

  const typed = String(form.get("time") ?? "").trim();
  const answer = await decideApproval(
    getNeonDb(),
    vercelQueueOutboxTransport,
    {
      // The caller's own id, off the session. Never a value the form carried: a user id in a form
      // is a user id an attacker chooses, and `requireSiteAccess` reads memberships for whoever
      // this is.
      userId: caller.kind === "STAFF" ? caller.userId : undefined,
      approvalId,
      decision: decision as ApprovalDecision,
      editedTime: typed === "" ? null : typed,
      now: new Date(),
    },
  );

  if (!answer.body.ok) return { status: "refused", message: REFUSALS[answer.body.error] };
  revalidatePath(APPROVALS_PAGE);
  return {
    status: "decided",
    decision: answer.body.decision,
    text: answer.body.text,
    queued: answer.body.queued,
  };
}
