"use server";

/**
 * The approval screen's one control (PRD §18.2 steps 9–10, §11.2 human tier; AT-01, AT-09).
 *
 * A server action rather than an API route because it is this screen's own button and has no other
 * caller — and it carries its own row in the one access table (`action:approval-decision`), because
 * a server action **is** a POST endpoint with no URL of its own. Hiding a button is not a guard.
 *
 * Everything that decides anything is in `approvals.ts`, which takes a database and answers
 * `{status, body}`: the role check, the tenant check, the decision race, the version guard and the
 * queued text. This file is the thin part — read the form, run it, turn a status into the sentence
 * the screen shows. That split is what lets the guards be tested against a real database with no
 * Next request at all (`modules/approvals/decide.test.ts`).
 *
 * `revalidatePath` on success because an approved proposal leaves the list: the next render of
 * this screen must not offer a decision somebody has already made.
 */
import { revalidatePath } from "next/cache";
import { canOpenPage } from "@/auth/access";
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
};

export async function decideApprovalAction(
  _previous: DecisionState,
  form: FormData,
): Promise<DecisionState> {
  /*
   * The role, in the action's own code, before anything else happens: a server action is a POST
   * endpoint with no URL of its own, so there is no route guard in front of it and hiding a button
   * is not a guard. Read from the one access table, for the page this control is on.
   *
   * `decideApproval` checks it again, together with the caller's membership at the approval's own
   * site — the check that cannot be done here, because the site is a property of the row and not
   * of the request. Two checks, and neither is redundant: this one refuses a role outright, that
   * one refuses a role at the wrong tenant.
   */
  const caller = await getCaller();
  if (!canOpenPage(caller, APPROVALS_PAGE)) {
    return { status: "refused", message: approvalCopy.notYourRole };
  }
  const approvalId = String(form.get("approval") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (!approvalId || (decision !== "APPROVED" && decision !== "DECLINED")) return { status: "idle" };

  const typed = String(form.get("time") ?? "").trim();
  const answer = await decideApproval(getNeonDb(), vercelQueueOutboxTransport, {
    // The caller's own id, off the session. Never a value the form carried: a user id in a form is
    // a user id an attacker chooses, and `requireSiteAccess` reads memberships for whoever this is.
    userId: caller.kind === "STAFF" ? caller.userId : undefined,
    approvalId,
    decision: decision as ApprovalDecision,
    editedTime: typed === "" ? null : typed,
    now: new Date(),
  });

  if (!answer.body.ok) return { status: "refused", message: REFUSALS[answer.body.error] };
  revalidatePath(APPROVALS_PAGE);
  return {
    status: "decided",
    decision: answer.body.decision,
    text: answer.body.text,
    queued: answer.body.queued,
  };
}
