/**
 * The one line a confirm card says (ledger #74 d, e), by the agent tool that prepared it and its
 * arguments — and the words of the button that refuses it. Copy only — no registry import — so the
 * proposal writer and the card read it anywhere.
 */
import { actionSummaries, confirmCopy, fill } from "@/ui/copy";

const LEG_WORDS: Readonly<Record<string, string>> = { AM: "morning", PM: "afternoon" };

/**
 * WHO AND WHERE A PLAN CARD WOULD MOVE, when the reader can be told (Vera).
 *
 * The card's arguments hold a child token and a van id, which are not words anybody reads; the
 * caller resolves them against the board the card is about and passes the names in (see
 * `confirm-cards.ts cardNames`). Both or neither: a half-named sentence ("Move Noah to a van") is
 * worse than the plain line, so a missing name falls back to it.
 */
export type CardNames = { readonly child?: string | null; readonly van?: string | null };

export function staffActionSummary(tool: string, args: Readonly<Record<string, unknown>> = {}, names: CardNames = {}): string {
  const leg = LEG_WORDS[String(args.leg ?? "")] ?? String(args.leg ?? "");
  switch (tool) {
    case "auto_plan":
      return fill(actionSummaries.autoPlan, { leg });
    case "move_child":
      return names.child && names.van
        ? fill(actionSummaries.moveChildTo, { child: names.child, van: names.van, leg })
        : fill(actionSummaries.moveChild, { leg });
    case "save_plan":
      return fill(actionSummaries.savePlan, { leg, count: Array.isArray(args.moves) ? args.moves.length : 0 });
    case "confirm_van_setup":
      return actionSummaries.confirmVan;
    case "set_child_needs":
      return actionSummaries.setNeeds;
    case "restart_demo_day":
      return actionSummaries.restart;
    case "decide_card":
      return actionSummaries.decideCard;
    case "take_alert":
      return actionSummaries.takeAlert;
    default:
      return actionSummaries.generic;
  }
}

/**
 * The words on the button that refuses this card — "Don't move", not "Don't" (Vera).
 *
 * The same switch as the line above, in the same file, so a card cannot describe one action and
 * refuse another. An unknown tool still says what is being refused rather than nothing.
 */
export function staffActionDecline(tool: string): string {
  switch (tool) {
    case "auto_plan":
      return confirmCopy.dont.autoPlan;
    case "move_child":
      return confirmCopy.dont.moveChild;
    case "save_plan":
      return confirmCopy.dont.savePlan;
    case "confirm_van_setup":
      return confirmCopy.dont.confirmVan;
    case "set_child_needs":
      return confirmCopy.dont.setNeeds;
    case "restart_demo_day":
      return confirmCopy.dont.restart;
    case "decide_card":
      return confirmCopy.dont.decideCard;
    case "take_alert":
      return confirmCopy.dont.takeAlert;
    default:
      return confirmCopy.dont.generic;
  }
}
