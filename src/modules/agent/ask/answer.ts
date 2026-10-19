/**
 * WHAT A STAFF ASK'S RUN SAID BACK — the model's answer, as the bubble shows it.
 *
 * A staff ask is a run like any other (`ask/staff-ask.ts`), and the run answers the way every run
 * leaves a note for staff: `summarize_thread_for_staff`, whose `summary` the policy engine has
 * already sanitized (`staffTextFields`). The model wrote it in the prompt's tokens; this is where
 * the people come back as first names (`identity/names.namedOrNull`), so the coordinator reads
 * "Dara asked to move Noah's drop-off to 5" and never "F2 … C2". A summary that cannot be named is
 * no answer rather than a sentence with a code in it.
 *
 * And if the run proposed something, which proposal: the bubble draws that card under the answer.
 */
import type { Exec } from "@/db/exec";
import { namedOrNull } from "@/modules/identity/names";
import { toolCalls } from "../run/store";

/**
 * The tools whose `summary` answers the person who asked: the staff answer (ledger #74), and a note
 * on a family's thread when that is what the question was about. Both carry the same sanitized
 * `summary` field, so one reader serves both.
 */
export const ANSWER_TOOLS: readonly string[] = ["reply_to_staff", "summarize_thread_for_staff"];

export type AskAnswer = { readonly answer: string | null; readonly proposalId: string | null };

/** The run's answer and proposal, off its own committed call rows. */
export async function askAnswer(db: Exec, runId: string): Promise<AskAnswer> {
  const calls = await toolCalls(db, runId);
  const note = [...calls].reverse().find((c) => ANSWER_TOOLS.includes(c.tool) && c.status === "EXECUTED");
  const proposed = calls.find((c) => c.status === "PROPOSED" && typeof c.result?.approval_request_id === "string");
  return {
    answer: note ? namedOrNull(note.args.summary) : null,
    proposalId: proposed ? String(proposed.result!.approval_request_id) : null,
  };
}
