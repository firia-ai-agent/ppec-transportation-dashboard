/**
 * The decisions a person makes on a card, as actions (ledger #74): Approve / Edit / Don't send, and
 * taking a needs-a-person alert. Their own module because the server action behind the cards imports
 * only this one: the page's graph stays free of the plan writers and the demo seed.
 */
import { z } from "zod";
import { getNeonDb } from "@/db/exec";
import { openAlert } from "@/modules/agent/alert-task";
import { decideApproval } from "@/modules/approvals/decide";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
import { actionSummaries } from "@/ui/copy";
import { entry } from "./types";

export const DECISION_ACTIONS = {
  /** Approve, Edit or Don't send on a card (PRD §11.2: a person decides — the agent may only ask). */
  decide_approval: entry({
    name: "decide_approval",
    endpoint: "action:approval-decision",
    input: z.strictObject({
      approvalId: z.string().min(1).max(64),
      decision: z.enum(["APPROVED", "DECLINED"]),
      editedText: z.string().max(2000).nullable().optional(),
      approvedText: z.string().max(4000).optional(),
    }),
    confirm: true,
    describe: (i) => (i.decision === "APPROVED" ? actionSummaries.approve : actionSummaries.decline),
    run: (ctx, i) =>
      decideApproval(getNeonDb(), vercelQueueOutboxTransport, {
        userId: ctx.caller.userId,
        approvalId: i.approvalId,
        decision: i.decision,
        editedText: i.editedText ?? null,
        approvedText: i.approvedText,
        now: ctx.now,
      }),
  }),
  /** "Take" on a needs-a-person alert. */
  take_alert: entry({
    name: "take_alert",
    endpoint: "action:approval-decision",
    input: z.strictObject({ alertId: z.string().min(1).max(64) }),
    confirm: false,
    describe: () => actionSummaries.takeAlert,
    run: async (ctx, i) => {
      await openAlert(getNeonDb(), { id: i.alertId, siteIds: [ctx.siteId], by: `staff:${ctx.caller.userId}` });
      return { status: 200, body: { ok: true } };
    },
  }),

} as const;
