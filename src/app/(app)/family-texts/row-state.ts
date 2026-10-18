/**
 * The pill on a conversation row (mockups/approvals.html's `.th .chip`).
 *
 * Five states, each an icon, a word and a tone — §3's rule that colour is never the only cue, and
 * Vera's that a badge may not be colour alone. They are a vocabulary of this screen rather than of
 * the schema, which is why they are here and not in `src/ui/states.ts`: nothing in the database has
 * a `change_ready` state, and adding one to `vocabularies` would break the parity test that says
 * every vocabulary there matches an enum.
 *
 * The words are `familyTexts.rowState`, so they are in copy.ts like every other word on screen.
 */
import { Bot, CheckCheck, MapPinCheck, Send, UserRound } from "lucide-react";
import { familyTexts } from "@/ui/copy";
import type { StateDescriptor } from "@/ui/states";
import type { RowState } from "./conversations";

export const ROW_STATES: Readonly<Record<RowState, StateDescriptor>> = {
  changeReady: { icon: Bot, label: familyTexts.rowState.changeReady, tone: "info" },
  needsYou: { icon: UserRound, label: familyTexts.rowState.needsYou, tone: "warn" },
  autoLate: { icon: Send, label: familyTexts.rowState.autoLate, tone: "ok" },
  autoDropped: { icon: MapPinCheck, label: familyTexts.rowState.autoDropped, tone: "ok" },
  done: { icon: CheckCheck, label: familyTexts.rowState.done, tone: "neutral" },
};
