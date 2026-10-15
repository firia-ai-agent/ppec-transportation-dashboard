/**
 * §11.2 `cancel_attendance_or_leg(child, date, scope FULL_DAY|AM|PM, reason, expected_self_arrival,
 * expected_version)` — the one tool in this slice that changes what happens to a child, and so the
 * one with the most guards in front of it.
 *
 * Four of them, in order, and none is the model's to satisfy by asserting it:
 *
 *  1. **A verified, unambiguous guardian.** `machines.ts` marks every agent cancel edge
 *     `agentRequiresVerifiedGuardian` (PRD l.750: "A only for a verified, unambiguous guardian
 *     request pre-boarding"). That fact is read out of this run's committed `resolve_sender` result
 *     — sender known, authorized for **exactly one** child, and that child is the one being
 *     canceled. Two siblings on one number resolve to two candidates, so this refuses, which is
 *     what makes AT-06's "no mutation" a property of the executor and not of the model's good
 *     manners. A run that never resolved its sender is refused for the same reason.
 *  2. **The version.** The write is `transition()`: `UPDATE … WHERE id = $1 AND version = $2 AND
 *     state = $3`. A stale `expected_version` matches no row and the whole call fails with 412 and
 *     `canceled_stale` — §11.2's failure column and AT-08.
 *  3. **The edge.** FULL_DAY and a leg are different machines with different actors: the
 *     attendance day moves `→ ABSENT_FULL_DAY` as `A` and cascades both legs to
 *     `CANCELED_ATTENDANCE` as `Y` (the system following the day's decision), while an AM/PM cancel
 *     moves that one leg to `CANCELED_TRANSPORT` as `A` — transport is canceled, attendance is
 *     not. A leg already past boarding is not a pre-board state, so the machine refuses it.
 *  4. **One transaction.** The attendance move, the leg cascade, the plan-version bump and the
 *     `ops.attendance_exception` row commit together or not at all, so there is no state in which
 *     a child's day is canceled and their ride is not.
 *
 * `expected_version` is deliberately read against **different rows** for the two scopes: the
 * attendance day's version for FULL_DAY, the leg's own version for AM/PM. `get_leg_state` returns
 * both, which is why it returns both.
 *
 * The plan-version bump is what makes §11.2's `canceled_stale` real downstream: a message already
 * queued about this ride was written against the old plan, so the outbox's send-time check finds
 * `plan_version != plan_version_basis` and the message becomes CANCELED_STALE instead of going out
 * (PRD §10.3 "version check at send").
 */
import type { Exec } from "@/db/exec";
import { ATTENDANCE, LEG, canTransition } from "@/domain/machines";
import { IllegalTransition, StaleOrConflict, transition } from "@/domain/transition";
import type { ToolExecution, ToolExecutor } from "../executors";
import type { CommittedCall } from "../store";
import {
  type ExecutorDeps,
  type LegRow,
  actor,
  attendanceRow,
  effectId,
  factsOf,
  failed,
  legsOfDay,
  notFound,
  versionConflict,
} from "./effects";

/** `ops.attendance_exception.scope`, which is the §11.2 `scope` argument verbatim. */
export type DayPart = "FULL_DAY" | "AM" | "PM";

/** The two machines' state unions, taken from the machines so this module lists no states of its own. */
type LegState = (typeof LEG)["states"][number];
type AttendanceState = (typeof ATTENDANCE)["states"][number];

/**
 * Guard 1: did *this run* establish a verified, unambiguous guardian request for this child?
 * Returns null when it did, or the refusal when it did not. Nothing here reads an argument other
 * than the child the model named — the rest comes from the committed `resolve_sender` facts.
 */
export function guardianRefusal(
  committed: readonly CommittedCall[],
  childToken: string,
): ToolExecution | null {
  const facts = factsOf(committed, "resolve_sender");
  if (!facts) return failed("UNVERIFIED_GUARDIAN", { reason_code: "SENDER_NOT_RESOLVED" });
  if (facts.sender_known !== true) return failed("UNVERIFIED_GUARDIAN", { reason_code: "SENDER_UNKNOWN" });
  if (facts.sender_child_count !== 1) {
    return failed("AMBIGUOUS_SENDER", {
      reason_code: "MORE_THAN_ONE_CANDIDATE",
      candidate_count: facts.sender_child_count,
    });
  }
  if (facts.sender_child_token !== childToken) {
    return failed("UNVERIFIED_GUARDIAN", { reason_code: "CHILD_NOT_THE_RESOLVED_ONE" });
  }
  return null;
}

export function cancelAttendanceOrLegExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const childToken = String(call.args.child_token ?? "");
    const serviceDate = String(call.args.date ?? "");
    const dayPart = call.args.day_part as DayPart;
    const reasonCode = String(call.args.reason_code ?? "");
    const selfArrival = typeof call.args.expected_self_arrival === "string" ? call.args.expected_self_arrival : null;
    const expectedVersion = Number(call.args.expected_version);
    const by = actor(call.runId);

    const refusal = guardianRefusal(call.committed, childToken);
    if (refusal) return refusal;

    // A full-day absence with a drop-off time is two different stories about the same morning. The
    // agent does not pick one: it refuses, and the next turn can ask (§11.2 request_clarification).
    if (dayPart === "FULL_DAY" && selfArrival !== null) {
      return failed("CONTRADICTORY_ARGUMENTS", { reason_code: "SELF_ARRIVAL_ON_FULL_DAY" });
    }

    const legs = await legsOfDay(deps.db, { siteId: call.siteId, childToken, serviceDate });
    const day = await attendanceRow(deps.db, { siteId: call.siteId, childToken, serviceDate });
    if (legs.length === 0 && !day) return notFound("attendance_day");

    // The resume case, and the reason the exception row's id is derived from the call's key: that
    // row is this call's **receipt**. If it is already there, this exact call already ran — the
    // loop is re-driving a step that was interrupted between its effect and its commit — and the
    // answer has to be the state it left, not a second attempt. (A second attempt would be refused
    // anyway, by the version guard or the machine, but "already done" is not a failure.)
    if (await hasReceipt(deps, call)) {
      return alreadyApplied({ dayPart, childToken, serviceDate, legs, day });
    }

    try {
      return await deps.db.tx(async (tx) =>
        dayPart === "FULL_DAY"
          ? await cancelFullDay(tx, { call, childToken, serviceDate, reasonCode, expectedVersion, by, legs, day })
          : await cancelOneLeg(tx, { call, childToken, serviceDate, dayPart, reasonCode, selfArrival, expectedVersion, by, legs, day }),
      );
    } catch (e) {
      // A guarded UPDATE that matched no row is the §11.2 failure column, not a crash: the state
      // moved under us, so nothing was written and the run is told in the one word that matters.
      if (e instanceof StaleOrConflict) return versionConflict({ expected_version: expectedVersion });
      if (e instanceof IllegalTransition) return failed("ILLEGAL_TRANSITION", { reason: e.message.slice(0, 200) });
      throw e;
    }
  };
}

type FullDayArgs = {
  call: Parameters<ToolExecutor>[0];
  childToken: string;
  serviceDate: string;
  reasonCode: string;
  expectedVersion: number;
  by: string;
  legs: readonly LegRow[];
  day: { id: string; state: string; version: number } | null;
};

/** FULL_DAY: the day is the subject, and both legs follow it (`ATTENDANCE` note: "cascade"). */
async function cancelFullDay(tx: Exec, a: FullDayArgs): Promise<ToolExecution> {
  if (!a.day) return notFound("attendance_day");
  const moved = await transition(tx, ATTENDANCE, "ops.attendance_day", {
    id: a.day.id,
    version: a.expectedVersion,
    from: a.day.state as AttendanceState,
    to: "ABSENT_FULL_DAY",
    actor: "A",
    by: a.by,
  });

  const canceled: string[] = [];
  for (const leg of a.legs) {
    // Which legs may follow the day is the machine's answer, not a list repeated here: a leg
    // already boarded or already canceled has no edge to CANCELED_ATTENDANCE and is left alone.
    if (!canTransition(LEG, leg.state as LegState, "CANCELED_ATTENDANCE", "Y")) continue;
    await cancelLeg(tx, { leg, to: "CANCELED_ATTENDANCE", legActor: "Y", by: a.by });
    canceled.push(leg.id);
  }

  await recordException(tx, { ...a, scope: "FULL_DAY", selfArrival: null });
  return {
    status: "executed",
    data: {
      day_part: "FULL_DAY",
      attendance_state: "ABSENT_FULL_DAY",
      attendance_version: moved.version,
      canceled_leg_ids: canceled,
      skipped_leg_ids: a.legs.filter((l) => !canceled.includes(l.id)).map((l) => l.id),
    },
    promptFacts: {
      day_part: "FULL_DAY",
      attendance_state: "ABSENT_FULL_DAY",
      attendance_version: moved.version,
      canceled_legs: canceled.length,
      child_token: a.childToken,
      service_date: a.serviceDate,
    },
  };
}

type OneLegArgs = FullDayArgs & { dayPart: "AM" | "PM"; selfArrival: string | null };

/**
 * AM/PM: transport is canceled, attendance is not. When the family named a drop-off time for the
 * morning, the day moves to `AM_SELF_DROP` as well — the child is still expected, by car (PRD
 * §18.2 demo step 2). There is no PM equivalent in `machines.ATTENDANCE`, so a PM self-pickup is
 * recorded on the exception row and the day is left as it is for staff to close.
 */
async function cancelOneLeg(tx: Exec, a: OneLegArgs): Promise<ToolExecution> {
  const leg = a.legs.find((l) => l.direction === a.dayPart);
  if (!leg) return notFound("trip_leg");
  // The leg's own version is the one §11.2 means for an AM/PM cancel, and it is the model's
  // `expected_version` that is guarded on — not the version this executor just read, which would
  // make the argument decorative and the staff edit in between invisible (AT-08).
  const moved = await cancelLeg(tx, {
    leg: { ...leg, version: a.expectedVersion },
    to: "CANCELED_TRANSPORT",
    legActor: "A",
    by: a.by,
  });

  let attendance = a.day ? { state: a.day.state, version: a.day.version } : null;
  if (a.dayPart === "AM" && a.selfArrival !== null && a.day) {
    const day = await transition(tx, ATTENDANCE, "ops.attendance_day", {
      id: a.day.id,
      version: a.day.version,
      from: a.day.state as AttendanceState,
      to: "AM_SELF_DROP",
      actor: "A",
      by: a.by,
    });
    attendance = { state: "AM_SELF_DROP", version: day.version };
  }

  await recordException(tx, { ...a, scope: a.dayPart });
  return {
    status: "executed",
    data: {
      day_part: a.dayPart,
      leg_id: leg.id,
      leg_state: "CANCELED_TRANSPORT",
      leg_version: moved.version,
      plan_version: moved.planVersion,
      expected_self_arrival: a.selfArrival,
      attendance,
    },
    promptFacts: {
      day_part: a.dayPart,
      leg_id: leg.id,
      leg_state: "CANCELED_TRANSPORT",
      leg_version: moved.version,
      leg_plan_version: moved.planVersion,
      child_token: a.childToken,
      service_date: a.serviceDate,
      ...(attendance ? { attendance_state: attendance.state, attendance_version: attendance.version } : {}),
      ...(a.selfArrival !== null ? { expected_self_arrival: a.selfArrival } : {}),
    },
  };
}

/**
 * One leg, canceled and its plan generation bumped. The bump rides in its own UPDATE *after* the
 * guarded transition — so it is inside the same transaction and after the version check passed —
 * and bumps `version` with it, because every change to a row bumps its version or the next
 * optimistic write is guarded on a lie.
 */
async function cancelLeg(
  tx: Exec,
  a: { leg: LegRow; to: "CANCELED_TRANSPORT" | "CANCELED_ATTENDANCE"; legActor: "A" | "Y"; by: string },
): Promise<{ version: number; planVersion: number }> {
  const moved = await transition(tx, LEG, "ops.trip_leg", {
    id: a.leg.id,
    version: a.leg.version,
    from: a.leg.state as LegState,
    to: a.to,
    actor: a.legActor,
    by: a.by,
    // Guard 1 above is the whole of this claim: the agent only reaches here for a sender it
    // resolved to one authorized child. For actor Y (the FULL_DAY cascade) the flag is ignored.
    verifiedUnambiguousGuardian: true,
  });
  const bumped = await tx.query<{ version: number; plan_version: number }>(
    `UPDATE ops.trip_leg SET plan_version = plan_version + 1, version = version + 1,
       updated_at = now(), updated_by = $2
     WHERE id = $1 AND version = $3 RETURNING version, plan_version`,
    [a.leg.id, a.by, moved.version],
  );
  if (bumped.rows.length !== 1) throw new StaleOrConflict(`trip_leg ${a.leg.id}: stale while bumping the plan version`);
  return { version: bumped.rows[0].version, planVersion: bumped.rows[0].plan_version };
}

/** Has this exact call already written its receipt? (`ops.attendance_exception`, id from the key.) */
async function hasReceipt(deps: ExecutorDeps, call: Parameters<ToolExecutor>[0]): Promise<boolean> {
  const r = await deps.db.query<{ id: string }>(
    "SELECT id FROM ops.attendance_exception WHERE id = $1 AND site_id = $2",
    [effectId(call.idempotencyKey, "attendance-exception"), call.siteId],
  );
  return r.rows.length > 0;
}

/**
 * What a re-driven call answers: the state its first attempt left, marked `idempotent`. The facts
 * are read fresh rather than remembered, because the row is the authority on what happened — and
 * because the next model turn must see the state as it *is*, not as this call intended it.
 */
function alreadyApplied(a: {
  dayPart: DayPart;
  childToken: string;
  serviceDate: string;
  legs: readonly LegRow[];
  day: { state: string; version: number } | null;
}): ToolExecution {
  const leg = a.dayPart === "FULL_DAY" ? null : a.legs.find((l) => l.direction === a.dayPart) ?? null;
  return {
    status: "executed",
    data: {
      idempotent: true,
      day_part: a.dayPart,
      ...(leg ? { leg_id: leg.id, leg_state: leg.state, leg_version: leg.version } : {}),
      attendance: a.day,
      canceled_leg_ids: a.legs.filter((l) => l.state.startsWith("CANCELED_")).map((l) => l.id),
    },
    promptFacts: {
      day_part: a.dayPart,
      child_token: a.childToken,
      service_date: a.serviceDate,
      ...(leg ? { leg_id: leg.id, leg_state: leg.state, leg_version: leg.version, leg_plan_version: leg.plan_version } : {}),
      ...(a.day ? { attendance_state: a.day.state, attendance_version: a.day.version } : {}),
      canceled_legs: a.legs.filter((l) => l.state.startsWith("CANCELED_")).length,
    },
  };
}

/**
 * `ops.attendance_exception`: the record of what the family asked for, which is the row the
 * attendance plan is read against (§6.1). Idempotent on the call's key, so a re-driven call does
 * not write a second one.
 */
async function recordException(
  tx: Exec,
  a: {
    call: Parameters<ToolExecutor>[0];
    childToken: string;
    serviceDate: string;
    scope: DayPart;
    reasonCode: string;
    selfArrival: string | null;
    by: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO ops.attendance_exception (id, site_id, child_token, service_date, scope, reason, expected_self_arrival, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      effectId(a.call.idempotencyKey, "attendance-exception"),
      a.call.siteId,
      a.childToken,
      a.serviceDate,
      a.scope,
      // A code, never a sentence: a free-text reason is how a child's name reaches a table.
      a.reasonCode,
      a.selfArrival,
      a.by,
    ],
  );
}
