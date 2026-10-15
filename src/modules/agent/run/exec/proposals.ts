/**
 * The `human`-tier half of §11.2: `propose_manifest_reallocation` and
 * `propose_contact_or_profile_change`.
 *
 * | Tool | Precondition → effect |
 * |---|---|
 * | `propose_manifest_reallocation(infeasible_vehicle, legs, options, rationale)` | INFEASIBLE/substitution → RED exception + Teams card; **no mutation** |
 * | `propose_contact_or_profile_change(family, category, claim, source_msg)` | any phone/custody/equipment change → change request + exception |
 *
 * These are not executors, and that is the point. The policy engine returns PROPOSAL for every
 * `human`-tier call (policy.ts step 11) and the loop never calls an executor for one — so there is
 * no code path on which a `propose_*` call mutates anything, however the model phrases it. What
 * they do produce is a row for a person to decide from, written in the **same transaction** that
 * commits the PROPOSED call: a `ops.change_request` or an `ops.approval_request`, plus the
 * exception task that puts it on the Exceptions board.
 *
 * Both rows carry `approval_key` — `approvalKey(tool, args)`, the same value the call row's
 * `args_hash` holds — so a human's decision and the exact call it would release are matched on one
 * column rather than by re-serializing arguments and hoping the key order agrees.
 *
 * What is still deferred: the Teams card (B-12) and the approval *surface* that would turn a
 * decision into an applied change. A `PROPOSED` row plus an approval request is the whole of the
 * agent's side of it.
 */
import type { Exec } from "@/db/exec";
import { agentTasks } from "@/ui/copy";
import { raiseTask } from "./clarify";
import { effectId, isUuid } from "./effects";
import type { ExecutorDeps } from "./effects";

/** `ops.task.category` for the two proposals. */
export const REALLOCATION_TASK_CATEGORY = "INFEASIBLE";
export const CHANGE_REQUEST_TASK_CATEGORY = "IDENTITY_CHANGE";

/** What the loop knows about a proposed call when it commits it. */
export type ProposalInput = {
  readonly runId: string;
  readonly callId: string;
  readonly siteId: string;
  readonly seq: number;
  readonly tool: string;
  /** The stored, policy-sanitized arguments (prose already redacted). */
  readonly args: Record<string, unknown>;
  readonly idempotencyKey: string;
  /** `approvalKey(tool, args)` — what a human signature binds to. */
  readonly approvalKey: string;
  readonly now: Date;
};

/**
 * Writes the rows one proposal implies and returns what should be added to the call's result.
 * Runs inside the transaction that commits the PROPOSED row, so the proposal and the record of it
 * cannot come apart. A tool with no entry here writes nothing, which is why `{}` is a valid answer.
 */
export type ProposalWriter = (tx: Exec, input: ProposalInput) => Promise<Record<string, unknown>>;

export function proposalWriter(_deps: ExecutorDeps): ProposalWriter {
  return async (tx, input) => {
    switch (input.tool) {
      case "propose_contact_or_profile_change":
        return contactOrProfileChange(tx, input);
      case "propose_manifest_reallocation":
        return manifestReallocation(tx, input);
      default:
        return {};
    }
  };
}

/**
 * §11.2: "any phone/custody/equipment change → change request + exception". The claim is the
 * family's, in the model's words, already redacted; nothing about the profile or the contact is
 * touched (the prohibitions `edit_approved_profile` and `add_contact_or_relationship` are what
 * forbid even asking).
 */
async function contactOrProfileChange(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const familyToken = String(input.args.family_token ?? "");
  const category = String(input.args.category ?? "");
  const claim = String(input.args.claim_summary ?? "");
  const sourceMessageId = String(input.args.source_message_id ?? "");
  const by = `agent:${input.runId}`;

  // The children the change would be about: the change request names its subjects, and a family's
  // children are the subjects of anything said about that family.
  const children = await tx.query<{ child_token: string }>(
    "SELECT child_token FROM ops.child_profile WHERE family_group_id = $1 AND site_id = $2 ORDER BY child_token",
    [isUuid(familyToken) ? familyToken : null, input.siteId],
  );
  const basis = await tx.query<{ id: string }>(
    "SELECT id FROM ops.message WHERE id = $1 AND site_id = $2",
    [isUuid(sourceMessageId) ? sourceMessageId : null, input.siteId],
  );

  const changeRequestId = effectId(input.idempotencyKey, "change-request");
  await tx.query(
    `INSERT INTO ops.change_request (id, site_id, kind, subject_child_tokens, basis_message_id, confidence, payload, status,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::uuid[], $5, NULL, $6::jsonb, 'NEEDS_HUMAN', $7, $7, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      changeRequestId,
      input.siteId,
      // The §11.2 category, as the kind: PHONE, CUSTODY, EQUIPMENT, RELATIONSHIP, IDENTITY.
      category,
      children.rows.map((r) => r.child_token),
      basis.rows[0]?.id ?? null,
      JSON.stringify({ category, claim_summary: claim, family_token: familyToken, approval_key: input.approvalKey }),
      by,
    ],
  );
  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: CHANGE_REQUEST_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedContactChange,
    by,
  });
  return { change_request_id: changeRequestId, exception_task_id: taskId, mutated: false };
}

/**
 * §11.2: "INFEASIBLE/substitution → RED exception + Teams card; no mutation". The options are the
 * model's arithmetic about vehicles and legs it already had in scope; committing one is a staff
 * action through the approval request, and the Teams card that would show it is B-12.
 */
async function manifestReallocation(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const by = `agent:${input.runId}`;
  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: REALLOCATION_TASK_CATEGORY,
    severity: "RED",
    words: agentTasks.proposedReallocation,
    by,
  });
  const approvalId = effectId(input.idempotencyKey, "approval");
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      approvalId,
      input.siteId,
      taskId,
      JSON.stringify({
        infeasible_vehicle_token: input.args.infeasible_vehicle_token ?? null,
        leg_ids: input.args.leg_ids ?? [],
        options: input.args.options ?? [],
        rationale_code: input.args.rationale_code ?? null,
        approval_key: input.approvalKey,
      }),
      by,
    ],
  );
  return { approval_request_id: approvalId, exception_task_id: taskId, mutated: false };
}
