"use server";

/**
 * A CONFIRM CARD'S TWO BUTTONS (ledger #74 d): Confirm and Don't, on a change the agent prepared.
 *
 * Its own action file, apart from Family texts' (`family-texts/actions.ts`): confirming can run any
 * action a person can take — Restart among them — and Family texts' graph stays free of those
 * writers. The bubble is what renders these cards, on every page.
 *
 * Who may is decided per action inside `confirmStaffAction` (the action's own access row, and this
 * person's membership at the card's centre); the row for this file only asks for a session.
 */
import { revalidatePath } from "next/cache";
import { getCaller } from "@/auth/caller";
import { getNeonDb } from "@/db/exec";
import { confirmStaffAction, type ConfirmDecision } from "@/modules/actions/confirm";
import { confirmCopy } from "@/ui/copy";

export type ConfirmState =
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly decision: ConfirmDecision }
  | { readonly status: "refused"; readonly message: string };

/** The action's shape, named in a `.ts` module for the same `.tsx`-scanner reason as `DecideAction`. */
export type ConfirmAction = (previous: ConfirmState, form: FormData) => Promise<ConfirmState>;

const REFUSALS: Readonly<Record<string, string>> = {
  SIGN_IN: confirmCopy.signIn,
  NOT_YOUR_ROLE: confirmCopy.notYourRole,
  NO_SUCH_CARD: confirmCopy.gone,
  ALREADY_DECIDED: confirmCopy.alreadyDecided,
  ACTION_REFUSED: confirmCopy.refused,
};

/** Every screen the actions behind these cards can change. */
const CHANGED = ["/today", "/plan-routes", "/live-map", "/ramp-ipad", "/family-texts"] as const;

export async function confirmStaffActionAction(_previous: ConfirmState, form: FormData): Promise<ConfirmState> {
  const caller = await getCaller();
  if (caller.kind !== "STAFF") return { status: "refused", message: confirmCopy.signIn };
  const approvalId = String(form.get("card") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (!approvalId || (decision !== "APPROVED" && decision !== "DECLINED")) return { status: "idle" };
  const answer = await confirmStaffAction(getNeonDb(), { userId: caller.userId, approvalId, decision, now: new Date() });
  if (!answer.body.ok) return { status: "refused", message: REFUSALS[answer.body.error] ?? confirmCopy.refused };
  for (const path of CHANGED) revalidatePath(path);
  return { status: "done", decision: answer.body.decision };
}
