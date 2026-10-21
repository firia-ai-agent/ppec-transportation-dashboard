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
import { refusalWords } from "@/modules/changes/refusal";
import { redirect } from "next/navigation";
import { canOpenForYou } from "@/auth/access";
import { clearStaleNote } from "@/modules/actions/stale-notes";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";

import type { ConfirmState } from "@/modules/actions/confirm-view";
export type { ConfirmAction, ConfirmState } from "@/modules/actions/confirm-view";

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
  if (!answer.body.ok) {
    // The action's own reason, said with the van or child it names, and where to fix it (ledger #80).
    if (answer.body.refusal) {
      const words = refusalWords(answer.body.refusal);
      return { status: "refused", message: words.says, fix: words.fix };
    }
    return { status: "refused", message: REFUSALS[answer.body.error] ?? confirmCopy.refused };
  }
  for (const path of CHANGED) revalidatePath(path);
  return { status: "done", decision: answer.body.decision };
}

/** A stale card's note on For you, dismissed (Vera, #124). A POST: a render never clears one. */
export async function dismissStaleNoteAction(form: FormData): Promise<void> {
  const caller = await getCaller();
  if (caller.kind !== "STAFF" || !caller.userId || !canOpenForYou(caller)) return;
  await clearStaleNote(getNeonDb(), { approvalId: String(form.get("card") ?? ""), userId: caller.userId, how: "DISMISSED", now: new Date() });
  revalidatePath("/family-texts");
}

/** Open Plan routes from a stale card's note: the note is cleared, then Plan routes opens. */
export async function openStaleNotePlanRoutesAction(form: FormData): Promise<void> {
  const caller = await getCaller();
  if (caller.kind === "STAFF" && caller.userId && canOpenForYou(caller)) {
    await clearStaleNote(getNeonDb(), { approvalId: String(form.get("card") ?? ""), userId: caller.userId, how: "OPENED_PLAN_ROUTES", now: new Date() });
    revalidatePath("/family-texts");
  }
  redirect(PLAN_ROUTES_PATH);
}
