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
 * ## The second thing a press can do, and it is not a decision (PPE-107)
 *
 * `redraftReplyAction` is the other half of the card's one form: the drop-off time used to be a
 * `GET` that re-rendered the page — wiping anything typed in the reply box — and now changing it
 * is a POST that redrafts the reply and stores it as the proposal's newest draft
 * (`modules/approvals/redraft.ts`). It is the third action in this file and it is argued for in
 * two places, here and in `agent/vendor-failure-panel.test.ts`: it decides nothing, it sends
 * nothing, it moves no ride, and it spends no model call — the redraft port's default answers
 * nothing at all and the fallback line is code-owned copy, so this file still reaches no vendor
 * (`agent/key-never-leaves.test.ts`). Its guard is this file's own row — `APPROVAL_ROLES` and the
 * caller's membership at the approval's own site — because it writes to the same row the decision
 * claims, under the same `decided_at IS NULL`.
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
import { redirect } from "next/navigation";
import { APPROVAL_ROLES, FAMILY_TEXTS_FOR_YOU } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { getNeonDb } from "@/db/exec";
import {
  APPROVALS_PAGE,
  type ApprovalDecision,
  type DecideError,
  decideApproval,
} from "@/modules/approvals/decide";
import { redraftReply } from "@/modules/approvals/redraft";
/*
 * From `alert-task.ts` and not from `staff-alert.ts`: this is a server-action module, so
 * everything it imports is on the bundle walk's server graph, and the agent's config and
 * provider errors must not be (key-never-leaves.test.ts, vendor-failure-panel.test.ts).
 */
import { openAlert } from "@/modules/agent/alert-task";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
import { REPLY_TEXT_MAX } from "@/modules/messaging/reply-text";
import { approval as approvalCopy, fill } from "@/ui/copy";

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
  MESSAGE_CHANGED: approvalCopy.messageChanged,
  DRAFT_FOR_OTHER_TIME: approvalCopy.retypeForNewTime,
  TEXT_NOT_SENDABLE: fill(approvalCopy.textNotSendable, { max: String(REPLY_TEXT_MAX) }),
  TEXT_NOT_EDITABLE: approvalCopy.textNotEditable,
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

  const typed = String(form.get("time") ?? "").trim();
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
   * THE REPLY THE COORDINATOR WROTE (PPE-97, founder's ruling of 2026-10-18).
   *
   * The card's Edit state carries the whole draft as a `<textarea>` **inside this form**, so the
   * press that approves is the press that carries the words — there is no save-the-draft endpoint
   * and no second send path, which is the ruling's own condition. Absent on an ordinary press,
   * and then the agent's draft is what goes out.
   *
   * Passed through untouched. Nothing is validated, stripped or shortened here: the shape check
   * and the 320-character cap are `decideApproval`'s, on the server, beside the decision they
   * guard — a check in this file would be a check a different caller could skip.
   */
  const written = form.get("replyText");
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
      approvedText: shown === null ? undefined : String(shown),
      editedText: written === null ? null : String(written),
      now: new Date(),
    },
  );

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

/** What the card does with a redraft: the new sentence for the box, or the one line a refusal gets. */
export type RedraftState =
  | { readonly status: "idle" }
  /**
   * Refused — and it carries the box back. A refusal that returned only a sentence would wipe
   * what the coordinator had typed, which is the PPE-107 half of this bug in a new place.
   */
  | { readonly status: "refused"; readonly message: string; readonly text: string; readonly time: string }
  | {
      readonly status: "redrafted";
      /** The sentence for the box. */
      readonly text: string;
      /** The same sentence as the card's bubble, so the press carries the words that are on screen. */
      readonly body: string;
      readonly time: string;
    };

/** The redraft action's shape, for the same `.tsx`-scanner reason as `DecideAction` above. */
export type RedraftAction = (previous: RedraftState, form: FormData) => Promise<RedraftState>;

/**
 * CHANGE THE DROP-OFF TIME, AND THE REPLY IS REDRAFTED FOR IT (PPE-106 / PPE-107).
 *
 * The card's one form, submitted by its own "Update the time" button. Plumbing again: it reads the
 * form, calls `redraftReply` and turns a status into words. Everything that matters is in that
 * function — the role and site check, the shape check on whatever is about to become a draft, the
 * `decided_at IS NULL` guard, and the choice between the coordinator's own words, a model redraft
 * and the fallback line.
 *
 * It approves nothing and queues nothing: the proposal is still pending afterwards, which is why
 * the card comes back with Approve still to press.
 */
export async function redraftReplyAction(
  _previous: RedraftState,
  form: FormData,
): Promise<RedraftState> {
  const typed = String(form.get("time") ?? "").trim();
  const written = String(form.get("replyText") ?? "");
  const caller = await getCaller();
  const role = caller.kind === "STAFF" ? caller.role : null;
  if (role === null || !APPROVAL_ROLES.includes(role)) {
    return { status: "refused", message: approvalCopy.notYourRole, text: written, time: typed };
  }
  const approvalId = String(form.get("approval") ?? "");
  if (!approvalId) return { status: "idle" };

  const answer = await redraftReply(getNeonDb(), {
    // The caller's own id, off the session, for the same reason the decision reads it there.
    userId: caller.kind === "STAFF" ? caller.userId : undefined,
    approvalId,
    time: typed,
    boxText: written,
    now: new Date(),
  });
  if (!answer.body.ok) {
    return { status: "refused", message: REFUSALS[answer.body.error], text: written, time: typed };
  }
  /*
   * The card's own page, and nothing else: a draft is not a plan change, so the three screens that
   * read the plan have nothing to re-render. This one does — the tab, the For you queue and the
   * card in the thread all read the proposal row this just wrote (`queue.ts`).
   */
  revalidatePath(APPROVALS_PAGE);
  return {
    status: "redrafted",
    text: answer.body.text,
    body: answer.body.body,
    time: answer.body.time,
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
  await openAlert(getNeonDb(), {
    id,
    // The caller's own memberships, off the session: an id from another tenant updates nothing
    // because it is not in this list, not because the row said so.
    siteIds: caller.memberships.map((m) => m.siteId),
    by: `staff:${caller.kind === "STAFF" ? caller.userId : "unknown"}`,
  });
  revalidatePath(APPROVALS_PAGE);
  /*
   * "Reply to Dara" is one press, so it does the one thing it says: the alert is taken, and the
   * coordinator lands on that family's thread, where the reply is written. The thread is a key
   * from the screen's own list of today's conversations — not an id out of a row — and an absent
   * one leaves the press as what it was before, a claim on the card (`assistantUnavailable.take`).
   */
  const thread = String(form.get("thread") ?? "");
  if (thread) redirect(`${FAMILY_TEXTS_FOR_YOU}&thread=${encodeURIComponent(thread)}`);
}

/** The take action's shape, for the same `.tsx`-scanner reason as `DecideAction` above. */
export type TakeAlertAction = (form: FormData) => Promise<void>;
