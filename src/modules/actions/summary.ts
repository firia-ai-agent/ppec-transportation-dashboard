/**
 * The one line a confirm card says (ledger #74 d), by the agent tool that prepared it. Copy only —
 * no registry import — so the proposal writer and the card can both read it on any path.
 */
import { actionSummaries } from "@/ui/copy";

const BY_TOOL: Readonly<Record<string, string>> = {
  set_child_needs: actionSummaries.setNeeds,
  restart_demo_day: actionSummaries.restart,
  decide_card: actionSummaries.decideCard,
};

export function staffActionSummary(tool: string): string {
  return BY_TOOL[tool] ?? actionSummaries.generic;
}
