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
import { childByKey, stopByKey } from "@/modules/demo/fixtures/standard";
import { agentTasks } from "@/ui/copy";
import { demoTokenForId } from "../scope-tokens";
import { raiseTask } from "./clarify";
import { effectId, isUuid } from "./effects";
import type { ExecutorDeps } from "./effects";

/** `ops.task.category` for the three proposals. */
export const REALLOCATION_TASK_CATEGORY = "INFEASIBLE";
export const CHANGE_REQUEST_TASK_CATEGORY = "IDENTITY_CHANGE";
/** A drop-off a family asked for: a plan change a person decides, not an identity claim. */
export const DROPOFF_CHANGE_TASK_CATEGORY = "PLAN_CHANGE";

/** The allow-listed template a family is told about an agreed drop-off with. */
export const DROPOFF_CHANGE_TEMPLATE = "dropoff.changed";

/**
 * The stop a leg already drops at, as the short token the outbox's copy table keys its place names
 * by — or null when this deployment's data cannot say.
 *
 * `ops.stop_location` holds a label and a lat/lng and **no SMS token**: the token is a property of
 * the outbox's code-owned place table, not of the row. Everywhere else on this path the caller
 * supplies it (`eta-notice.ts` takes `stopToken` from the fixture), but a proposal has no such
 * caller — it is answering a family's text — so it is resolved here, the same demo-only way
 * `run/scope-tokens.ts` resolves everything else: the child's id read back to its fixture key, and
 * the fixture's own stop off that.
 *
 * Demo-only by construction, and null for anything the fixtures do not account for. Null is a
 * refusal upstream rather than a default: the one thing worse than not proposing a drop-off is
 * proposing a place to leave a child that nobody chose.
 */
function legStopToken(childToken: string): string | null {
  const childKey = demoTokenForId(childToken);
  if (!childKey) return null;
  try {
    const stopKey = childByKey(childKey).stopKey;
    return stopKey ? stopByKey(stopKey).smsToken : null;
  } catch {
    // A token that reads back to a fixture key the roster no longer has. Say nothing rather than guess.
    return null;
  }
}

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
      case "propose_dropoff_change":
        return dropoffChange(tx, input);
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

/**
 * §11.2 human tier: a drop-off a family asked for → an approval request and an exception, and no
 * mutation at all. The leg keeps its time and its stop until a coordinator says otherwise.
 *
 * ## The row carries the text, as a template and its variables
 *
 * The approval screen has to show a coordinator **the exact words the family will get** — that is
 * the whole of what they are deciding. The obvious way to do that would be to render the body here
 * and store the string, and it would be wrong: the outbox renders at send time, so a stored string
 * is a second rendering that can drift from the first, and the screen would be showing a text that
 * is merely *like* the one that goes out.
 *
 * So what is stored is the template id and the vars, and the screen renders them through the same
 * `renderTemplate` the outbox uses. One renderer, one set of words, and if the copy changes the
 * screen and the send change together.
 *
 * The vars are read off the **leg row**, not off the call: the date a family is told about is the
 * service date the leg actually has, and the stop is the one being proposed or the one the leg
 * already holds. Nothing a model wrote reaches the body — `dropoff.changed` takes a date, a clock
 * time and a stop token, and no var on it can carry prose (Veri #12).
 */
async function dropoffChange(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const legId = String(input.args.leg_id ?? "");
  const requestedTime = input.args.requested_dropoff_time === null ? null : String(input.args.requested_dropoff_time ?? "");
  const requestedStop = input.args.requested_stop_token === null ? null : String(input.args.requested_stop_token ?? "");
  const rationale = String(input.args.rationale_code ?? "");
  const sourceMessageId = String(input.args.source_message_id ?? "");
  const by = `agent:${input.runId}`;

  /*
   * The leg, at this site. A leg at another site cannot be reached — the policy engine's scope
   * check refused it long before this runs — and the `site_id` here says so again, because a
   * writer that trusted the scope check would be the one place the tenant boundary was implied
   * rather than stated (DATA-MODEL §5).
   */
  const leg = await tx.query<{
    id: string; child_token: string; service_date: string; direction: string; plan_version: number;
  }>(
    `SELECT id, child_token, service_date::text AS service_date, direction::text AS direction, plan_version
     FROM ops.trip_leg WHERE id = $1 AND site_id = $2`,
    [isUuid(legId) ? legId : null, input.siteId],
  );
  const row = leg.rows[0];
  if (!row) return { proposal_refused: "NO_SUCH_LEG", mutated: false };

  // The place the family would be told. The proposed stop when there is one, otherwise the one the
  // leg already drops at — and if neither can be named, nothing is proposed at all.
  const stopToken = requestedStop ?? legStopToken(row.child_token);
  if (!stopToken) return { proposal_refused: "NO_STOP_FOR_LEG", mutated: false };

  const basis = await tx.query<{ id: string }>(
    "SELECT id FROM ops.message WHERE id = $1 AND site_id = $2",
    [isUuid(sourceMessageId) ? sourceMessageId : null, input.siteId],
  );

  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: DROPOFF_CHANGE_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedDropoffChange,
    by,
  });

  const approvalId = effectId(input.idempotencyKey, "approval");
  const proposal = {
    kind: "DROPOFF_CHANGE",
    leg_id: row.id,
    child_token: row.child_token,
    service_date: row.service_date,
    direction: row.direction,
    /** The version a staff approval will be guarded on (AT-08: a bumped plan invalidates this). */
    plan_version_basis: row.plan_version,
    requested_dropoff_time: requestedTime,
    /** The stop as proposed, or the one the leg already holds when only the time moved. */
    stop_token: stopToken,
    rationale_code: rationale,
    basis_message_id: basis.rows[0]?.id ?? null,
    /** The text, as a template and its vars. Rendered by the screen and by the outbox, once each. */
    template_id: DROPOFF_CHANGE_TEMPLATE,
    vars: {
      legDate: row.service_date,
      ...(requestedTime ? { eta: requestedTime } : {}),
      stopLabel: stopToken,
    },
    approval_key: input.approvalKey,
  };
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [approvalId, input.siteId, taskId, JSON.stringify(proposal), by],
  );
  return { approval_request_id: approvalId, exception_task_id: taskId, mutated: false };
}
