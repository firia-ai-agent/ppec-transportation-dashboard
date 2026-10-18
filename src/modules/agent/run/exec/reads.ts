/**
 * The two §11.2 read tools, on real state.
 *
 * | Tool | Precondition → effect | Failure |
 * |---|---|---|
 * | `resolve_sender(message_id)` | known contact point → candidates{child, legs, confidence} | unknown → unknown_sender task |
 * | `get_leg_state(leg_id)` | — → leg + version | — |
 *
 * Both are `read` effect, which in this system means they change no state and send nothing, so
 * they stay available while the agent is paused (policy.ts step 2). `resolve_sender` has one
 * deliberate exception to "change no state": the §11.2 failure column *is* a row — an
 * `unknown_sender` task — and raising it is how an unrecognized number reaches a human instead of
 * a reply (AT-09: an unknown sender is answered by nobody). The task carries no copy of the
 * message, no number and no model prose: a hash of nothing, a category, and the words in
 * `ui/copy.ts`. It is the same kind of write `escalate_exception` is allowed to make while paused.
 *
 * Why these two matter beyond their own rows: they are where a later write gets its authority.
 * §11.1 says T2 state is "fetched via tools before every write", and the two writers in this slice
 * enforce exactly that — `cancel_attendance_or_leg` will not transition anything unless
 * `resolve_sender` resolved this run's sender to **one** authorized child (machines.ts
 * `agentRequiresVerifiedGuardian`), and the version it is guarded on is the one `get_leg_state`
 * returned. Neither fact can come from the model: both are read out of the committed results
 * (`factsOf`).
 */
import type { Exec } from "@/db/exec";
import type { IdentityGateway } from "@/modules/identity/gateway";
import { agentTasks } from "@/ui/copy";
import { serviceDateIso } from "@/ui/service-date";
import type { ExecutorCall, ToolExecution, ToolExecutor } from "../executors";
import { gatewayOf,
  type ExecutorDeps,
  actor,
  attendanceRow,
  effectId,
  isUuid,
  legRow,
  legsOfDay,
  notFound,
} from "./effects";

/** `ops.task.category` for the §11.2 unknown_sender row. */
export const UNKNOWN_SENDER_TASK_CATEGORY = "UNKNOWN_SENDER";

/** One candidate the contact point could mean: a child, that child's legs on the day, no copy. */
export type SenderCandidate = {
  readonly child_token: string;
  readonly legs: readonly { readonly leg_id: string; readonly direction: string; readonly state: string; readonly version: number }[];
};

type MessageRow = {
  id: string;
  thread_id: string;
  from_hmac: string;
  is_own_echo: boolean;
  received_at: Date | string;
};

/**
 * §11.2 resolve_sender. The lookup is the one the inbound webhook does (messaging/inbound), in the
 * same direction and with the same blind index: the message's `from_hmac` against
 * `identity.guardian_contact`, valid at the time the message was received. The agent never sees the
 * number — it is not in the arguments, not in the result and not in the prompt; what comes back is
 * a contact token, the children that contact is **authorized** for (§6.4: a phone match is
 * recognized, not authorized) and those children's legs on the message's service date.
 *
 * `confidence` is `1 / candidates`, because that is honestly all a contact point can say: one
 * authorized child is unambiguous, a shared number with two siblings on it is a coin toss, and the
 * §11.2 answer to a coin toss is `request_clarification` (AT-06) — not a guess. The cancel executor
 * refuses to write on anything below one candidate, so the ambiguity is enforced rather than
 * suggested.
 */
export function resolveSenderExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const messageId = call.args.message_id;
    if (!isUuid(messageId)) return notFound("message");
    const msg = await deps.db.query<MessageRow>(
      `SELECT id, thread_id, from_hmac, is_own_echo, received_at FROM ops.message
       WHERE id = $1 AND site_id = $2 AND direction = 'IN'`,
      [messageId, call.siteId],
    );
    const row = msg.rows[0];
    if (!row) return notFound("message");
    // Our own echo is evidence and nothing else (MSG-03); it has no sender to resolve.
    if (row.is_own_echo) return unknownSender(deps, call, row.thread_id, "OWN_ECHO");

    const receivedAt = new Date(row.received_at);
    const serviceDate = serviceDateIso(receivedAt);
    const contact = await contactForHmac(gatewayOf(deps), { siteId: call.siteId, fromHmac: row.from_hmac, at: receivedAt });
    if (!contact) return unknownSender(deps, call, row.thread_id, "NO_CONTACT_POINT");

    const children = await authorizedChildren(deps.db, {
      siteId: call.siteId,
      contactToken: contact.contact_token,
      at: receivedAt,
    });
    // Recognized, but authorized for nobody: §6.4 says that is not a sender either, and it is the
    // same staff question as an unknown number — who is this, and may they ask?
    if (children.length === 0) return unknownSender(deps, call, row.thread_id, "NOT_AUTHORIZED");

    const candidates: SenderCandidate[] = [];
    for (const childToken of children) {
      const legs = await legsOfDay(deps.db, { siteId: call.siteId, childToken, serviceDate });
      candidates.push({
        child_token: childToken,
        legs: legs.map((l) => ({ leg_id: l.id, direction: l.direction, state: l.state, version: l.version })),
      });
    }
    const confidence = 1 / candidates.length;
    const one = candidates.length === 1 ? candidates[0] : null;

    return {
      status: "executed",
      data: {
        sender_known: true,
        contact_token: contact.contact_token,
        family_token: contact.family_group_id,
        thread_id: row.thread_id,
        service_date: serviceDate,
        candidates,
        confidence,
      },
      // Tokens, counts and a number. The candidate list is flattened into one fact because a
      // clarification needs the tokens to offer, and a single resolved child gets its legs named
      // so the next turn can read one — with two candidates no leg is named at all, which is the
      // shape AT-06 needs: there is nothing to cancel until the family says which child.
      promptFacts: {
        sender_known: true,
        sender_thread_id: row.thread_id,
        sender_child_count: candidates.length,
        sender_confidence: confidence,
        sender_candidates: candidates.map((c) => c.child_token).join(","),
        service_date: serviceDate,
        ...(one
          ? {
              sender_child_token: one.child_token,
              ...Object.fromEntries(one.legs.map((l) => [`${l.direction.toLowerCase()}_leg_id`, l.leg_id])),
            }
          : {}),
      },
    };
  };
}

/**
 * §11.2 get_leg_state: "— → leg + version". The version is the point of the tool — it is what the
 * next write is guarded on — so the attendance day behind the leg is read with it, since a
 * FULL_DAY cancel is guarded on *that* version instead (cancel.ts).
 */
export function getLegStateExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const leg = await legRow(deps.db, { siteId: call.siteId, legId: String(call.args.leg_id ?? "") });
    if (!leg) return notFound("trip_leg");
    const day = await attendanceRow(deps.db, {
      siteId: call.siteId,
      childToken: leg.child_token,
      serviceDate: leg.service_date,
    });
    return {
      status: "executed",
      data: {
        leg_id: leg.id,
        child_token: leg.child_token,
        service_date: leg.service_date,
        direction: leg.direction,
        mode: leg.mode,
        state: leg.state,
        version: leg.version,
        plan_version: leg.plan_version,
        attendance: day ? { state: day.state, version: day.version } : null,
      },
      promptFacts: {
        leg_id: leg.id,
        leg_child_token: leg.child_token,
        leg_date: leg.service_date,
        leg_direction: leg.direction,
        leg_state: leg.state,
        leg_version: leg.version,
        leg_plan_version: leg.plan_version,
        ...(day ? { attendance_state: day.state, attendance_version: day.version } : {}),
      },
    };
  };
}

/* ───────────────────────────── the lookups ───────────────────────────── */

type ContactRow = { contact_token: string; family_group_id: string | null };

/**
 * The guardian contact behind a blind index, then the therapist / dispatcher — through the
 * IdentityGateway (S1-6), which is also the one place the webhook asks it (`inbound.ts`).
 *
 * The two statements that were here ran on `deps.db`: the agent's own connection, which may not
 * read `identity` at all (src/db/schema.ts:104). So `read_message` could not resolve a sender on
 * any deployment with the real role split — and a step that cannot name the sender raises
 * NEEDS_PERSON, which made a permission error look like an ambiguous text.
 */
async function contactForHmac(
  gateway: IdentityGateway,
  a: { siteId: string; fromHmac: string; at: Date },
): Promise<ContactRow | null> {
  const person = await gateway.senderForPhoneHmac({
    siteId: a.siteId,
    phoneHmac: a.fromHmac,
    at: a.at,
  });
  return person ? { contact_token: person.contactToken, family_group_id: person.familyGroupId } : null;
}

/** §6.4: the children this contact may ask about on this channel, at this time. */
async function authorizedChildren(
  db: Exec,
  a: { siteId: string; contactToken: string; at: Date },
): Promise<string[]> {
  const r = await db.query<{ child_token: string }>(
    `SELECT DISTINCT child_token FROM ops.contact_authorization
     WHERE site_id = $1 AND contact_token = $2 AND channel = 'SMS_1TO1'
       AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY child_token`,
    [a.siteId, a.contactToken, a.at.toISOString()],
  );
  return r.rows.map((x) => x.child_token);
}

/**
 * The §11.2 failure column: one `unknown_sender` task, idempotent on the call's key, and a result
 * that says so. The run is **done** — there is nothing an agent may do with a message from a number
 * it cannot place, and the one thing it must not do is answer it (AT-09). A human takes it from the
 * task.
 */
async function unknownSender(
  deps: ExecutorDeps,
  call: ExecutorCall,
  threadId: string,
  reasonCode: string,
): Promise<ToolExecution> {
  const taskId = effectId(call.idempotencyKey, "unknown-sender");
  await deps.db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, 'AMBER', 'OPEN', $4, $5, $6, $7, $7, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      taskId,
      call.siteId,
      UNKNOWN_SENDER_TASK_CATEGORY,
      agentTasks.unknownSender.summary,
      agentTasks.unknownSender.nextStep,
      agentTasks.unknownSender.predicate,
      actor(call.runId),
    ],
  );
  return {
    status: "executed",
    data: { sender_known: false, reason_code: reasonCode, thread_id: threadId, unknown_sender_task_id: taskId },
    promptFacts: { sender_known: false, reason_code: reasonCode },
    done: true,
  };
}
