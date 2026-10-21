"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canOpenForYou } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { getNeonDb } from "@/db/exec";
import { clearStaleNote } from "@/modules/actions/stale-notes";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";

/*
 * A stale agent plan card's note (PR 124). A file of its own, under its own access row, rather than in the
 * confirm actions: importing those pulled the action registry — and the demo reset's seed, which
 * writes identity — into the Family texts page's graph.
 */
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
