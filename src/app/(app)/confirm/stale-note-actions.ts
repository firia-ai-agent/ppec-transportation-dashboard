"use server";

/**
 * A STALE AGENT PLAN CARD'S NOTE: Dismiss, and Open Plan routes. Both clear the note for someone
 * who may open For you, at the note's own centre (`clearStaleNote`); neither changes the day.
 *
 * Its own action file, apart from the confirm card's (`confirm/actions.ts`): Family texts renders
 * these notes, and the confirm card's file reaches every action writer, the demo reset and the
 * demo seed among them. Family texts' graph stays free of those.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canOpenForYou } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { getNeonDb } from "@/db/exec";
import { clearStaleNote } from "@/modules/actions/stale-notes";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";

/** A stale card's note on For you, dismissed. A POST: a render never clears one. */
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
