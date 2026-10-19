/**
 * The one line a confirm card says (ledger #74 d, e), by the agent tool that prepared it and its
 * arguments. Copy only — no registry import — so the proposal writer and the card read it anywhere.
 */
import { actionSummaries, fill } from "@/ui/copy";

const LEG_WORDS: Readonly<Record<string, string>> = { AM: "morning", PM: "afternoon" };

export function staffActionSummary(tool: string, args: Readonly<Record<string, unknown>> = {}): string {
  const leg = LEG_WORDS[String(args.leg ?? "")] ?? String(args.leg ?? "");
  switch (tool) {
    case "auto_plan":
      return fill(actionSummaries.autoPlan, { leg });
    case "move_child":
      return fill(actionSummaries.moveChild, { leg });
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
