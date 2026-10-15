/**
 * The `ops.task` rows a refused agent step raises (PRD §11.2: an out-of-policy tool call is
 * "rejected + logged", and AGT-02 wants the human half of that — the thing a coordinator now has
 * to decide — to exist as work rather than as a row in an audit table nobody opens).
 *
 * A BLOCK decision carries its tasks (`PolicyDecision.tasks`): a `staff_review` for the refused
 * step, plus an `identity_change_request` when the thread behind it claims a new number or a new
 * guardian. Those are written here, in the **same transaction** as the BLOCKED commit (loop.ts),
 * so there is no state in which a call is recorded blocked and the question it raised is lost, or
 * a task exists for a call that never committed.
 *
 * **Exactly once per call**, two ways over:
 *
 *  1. The commit is fenced on PENDING (`commitCall`), and the inserts are in its transaction. Two
 *     drivers settling the same row therefore serialize on the row lock, and the loser sees zero
 *     rows updated and writes nothing at all.
 *  2. The id of each task row is *derived* from the call's idempotency key and the task's place in
 *     the decision (`policyTaskId`), and the insert is `ON CONFLICT (id) DO NOTHING`. So even a
 *     driver that somehow got past the fence — a future per-run lease, a hand-run replay, another
 *     process on another deployment — re-derives the same primary keys and inserts nothing.
 *
 * The staff-visible words are `src/ui/copy.ts` (`agentPolicyTask`); what this module decides is
 * which copy and which category a task type gets, and nothing else.
 */
import type { Exec } from "@/db/exec";
import { agentPolicyTask, fill } from "@/ui/copy";
import type { PolicyTask } from "../policy";
import { sha256Hex } from "../redact";
import type { RunRow, ToolCallRow } from "./store";
import { triggerLabel } from "./triggers";

/**
 * `ops.task.category` per task type, and the copy a coordinator reads. Written out per type rather
 * than derived from the name, so a fourth `PolicyTask` type is a compile error here — "the agent
 * raised something nobody wrote words for" is exactly the failure this file exists to prevent.
 *
 * Severity is AMBER throughout: a refused step is work for a human today, and not the RED of a
 * child who is somewhere nobody expected (`task_open_idx` sorts the board by it).
 */
type TaskCopy = { readonly summary: string; readonly nextStep: string; readonly predicate: string };

const TASK_ROWS: Readonly<Record<PolicyTask["type"], { category: string; copy: TaskCopy }>> = {
  staff_review: { category: "AGENT_POLICY_STAFF_REVIEW", copy: agentPolicyTask.staffReview },
  identity_change_request: { category: "AGENT_IDENTITY_CHANGE_REQUEST", copy: agentPolicyTask.identityChangeRequest },
  unknown_sender: { category: "AGENT_UNKNOWN_SENDER", copy: agentPolicyTask.unknownSender },
};

/** The categories above, for a reader (the Exceptions board, a test) that wants all of them. */
export const AGENT_POLICY_TASK_CATEGORIES: Readonly<Record<PolicyTask["type"], string>> = Object.freeze(
  Object.fromEntries(Object.entries(TASK_ROWS).map(([type, row]) => [type, row.category])),
) as Readonly<Record<PolicyTask["type"], string>>;

/**
 * The primary key of task `index` of the decision persisted on one call. Derived from the call's
 * idempotency key — the one identifier of a call that a resume recomputes rather than reads — so
 * the second attempt at raising these tasks derives the same ids and conflicts instead of writing
 * a second set.
 *
 * Shaped as a uuid because `ops.task.id` is one: a sha256 of the seed with the version nibble set
 * to 8 (RFC 9562's "custom" version, which is what this is — not a namespaced v5) and the variant
 * bits set. The derivation is stable, so it is also readable from SQL if a row ever has to be
 * matched back to its call by hand.
 */
export function policyTaskId(idempotencyKey: string, index: number): string {
  const h = sha256Hex(`ops.task:agent_policy_task:${idempotencyKey}:${index}`);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * The ids the tasks of one blocked call will have — before they are written, because they are
 * derived. The commit that raises them can therefore record them on the call in the same write
 * (loop.ts) instead of reading them back out of the insert.
 */
export function policyTaskIds(call: ToolCallRow, tasks: readonly PolicyTask[]): string[] {
  return tasks.map((_task, index) => policyTaskId(call.idempotencyKey, index));
}

/**
 * Write one `ops.task` per task the blocked decision raised, in the caller's transaction, and hand
 * back the ids. Returns an empty list for a decision with no tasks, which is the honest answer:
 * the block is still recorded on the call either way.
 */
export async function writePolicyTasks(
  tx: Exec,
  args: { run: RunRow; call: ToolCallRow; tasks: readonly PolicyTask[]; by: string },
): Promise<string[]> {
  const ids: string[] = [];
  const derived = policyTaskIds(args.call, args.tasks);
  for (const [index, task] of args.tasks.entries()) {
    const id = derived[index];
    const { category, copy } = TASK_ROWS[task.type];
    await tx.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, 'AMBER', 'OPEN', $4, $5, $6, $7, $7, 'SIMULATED')
       ON CONFLICT (id) DO NOTHING`,
      [
        id, args.run.siteId, category,
        fill(agentPolicyTask.locator, {
          summary: copy.summary,
          trigger: triggerLabel(args.run.trigger),
          step: args.call.seq,
        }),
        copy.nextStep, copy.predicate, args.by,
      ],
    );
    ids.push(id);
  }
  return ids;
}
