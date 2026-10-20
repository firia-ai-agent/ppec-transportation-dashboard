/**
 * State machines (PRD §6.3, DATA-MODEL.md §4). Single source of allowed edges.
 * Actor codes: S staff (DIRECTOR/COORDINATOR/FRONT_DESK), T therapist (acks via the Teams adapter; not a login user),
 * P provider, G guardian, A agent tool, Y system.
 * Terminal states never reopen: wildcard ("*") edges expand only over non-terminal states.
 * Role checks (e.g. only DIRECTOR/COORDINATOR may approve a profile) live in the RBAC layer, not here.
 */
import {
  ackState, attendanceState, capabilityState, legState, needItemState, outboundState,
  profileState, reservationState, taskState, threadState,
} from "@/db/schema";

export type Actor = "S" | "T" | "P" | "G" | "A" | "Y";
export const ACTORS: Actor[] = ["S", "T", "P", "G", "A", "Y"];
export type Edge<T extends string> = { from: T | "*"; to: T; by: Actor[]; note?: string; agentRequiresVerifiedGuardian?: boolean };
export type Machine<T extends string> = {
  name: string; states: readonly T[]; edges: Edge<T>[];
  /** No outgoing edges, ever (wildcards included). */
  terminal: readonly T[];
  /** Not terminal, but wildcard edges must not leave them (exit only by the edges listed explicitly). */
  noWildcardFrom?: readonly T[];
};
export type TransitionCtx<T extends string = string> = {
  priorState?: T | null;
  /** Policy engine (B-08) result: guardian is verified, authorized for the child, and the request is unambiguous. */
  verifiedUnambiguousGuardian?: boolean;
};

type LegS = (typeof legState.enumValues)[number];
const PRE_BOARD: LegS[] = ["SCHEDULED", "PROVISIONAL_ASSIGNED", "CAPABILITY_PENDING", "CAPABILITY_REPORTED",
  "CAPABILITY_VERIFIED", "MANIFEST_LOCKED", "EN_ROUTE_PICKUP", "ARRIVED_PICKUP"];
/**
 * A child is ABOARD from the moment they are reported on the van until they are handed over: the
 * van has them, so a plan can reorder its stops or make it wait, but cannot put them in another
 * van (ledger #79, #80). Read off the leg's own state — what happened — never off a clock.
 */
export const ABOARD: readonly LegS[] = ["BOARDED_REPORTED", "BOARDED_VERIFIED", "IN_TRANSIT", "ARRIVED_DROPOFF", "HELD_NO_RECEIVER"];

export const LEG: Machine<LegS> = {
  name: "trip_leg", states: legState.enumValues,
  terminal: ["COMPLETED_HANDOFF", "CANCELED_TRANSPORT", "CANCELED_ATTENDANCE", "NO_SHOW"],
  noWildcardFrom: ["HELD_NO_RECEIVER", "LEFT_BEHIND_CAPACITY", "EXCEPTION"], // exit S only (PRD §6.3 l.750)
  edges: [
    { from: "SCHEDULED", to: "PROVISIONAL_ASSIGNED", by: ["Y"] },
    { from: "PROVISIONAL_ASSIGNED", to: "CAPABILITY_PENDING", by: ["Y"] },
    { from: "CAPABILITY_PENDING", to: "CAPABILITY_REPORTED", by: ["P"] },
    { from: "CAPABILITY_REPORTED", to: "CAPABILITY_VERIFIED", by: ["S"], note: "agent may never verify (§11.2)" },
    { from: "CAPABILITY_VERIFIED", to: "MANIFEST_LOCKED", by: ["Y"], note: "solver FEASIBLE required" },
    { from: "MANIFEST_LOCKED", to: "EN_ROUTE_PICKUP", by: ["P"] },
    { from: "EN_ROUTE_PICKUP", to: "ARRIVED_PICKUP", by: ["Y"] },
    { from: "ARRIVED_PICKUP", to: "BOARDED_REPORTED", by: ["G", "P"] },
    { from: "BOARDED_REPORTED", to: "BOARDED_VERIFIED", by: ["S"] },
    { from: "BOARDED_VERIFIED", to: "IN_TRANSIT", by: ["Y"] },
    { from: "IN_TRANSIT", to: "ARRIVED_DROPOFF", by: ["Y"] },
    { from: "ARRIVED_DROPOFF", to: "COMPLETED_HANDOFF", by: ["S", "G"], note: "custody event naming a receiving adult" },
    ...PRE_BOARD.map((f): Edge<LegS> => ({ from: f, to: "CANCELED_TRANSPORT", by: ["A", "S"], agentRequiresVerifiedGuardian: true,
      note: "A only for a verified, unambiguous guardian request pre-boarding (PRD l.750); the B-08 policy engine supplies ctx.verifiedUnambiguousGuardian" })),
    ...PRE_BOARD.map((f): Edge<LegS> => ({ from: f, to: "CANCELED_ATTENDANCE", by: ["Y"] })),
    { from: "ARRIVED_PICKUP", to: "NO_SHOW", by: ["P", "S"] },
    { from: "ARRIVED_DROPOFF", to: "HELD_NO_RECEIVER", by: ["Y"], note: "exit by S only; no automatic return (§6.6)" },
    { from: "HELD_NO_RECEIVER", to: "COMPLETED_HANDOFF", by: ["S"] },
    ...PRE_BOARD.map((f): Edge<LegS> => ({ from: f, to: "LEFT_BEHIND_CAPACITY", by: ["Y"] })),
    // LEFT_BEHIND_CAPACITY (Y→S, PRD l.750): staff re-plan the leg or cancel transport.
    { from: "LEFT_BEHIND_CAPACITY", to: "PROVISIONAL_ASSIGNED", by: ["S"], note: "staff reassign to another vehicle/run" },
    { from: "LEFT_BEHIND_CAPACITY", to: "CANCELED_TRANSPORT", by: ["S"], note: "staff arrange family/other transport" },
    { from: "*", to: "EXCEPTION", by: ["Y", "A"] },
    // EXCEPTION → prior_state by S is handled in canTransition (needs ctx.priorState).
  ],
};

type AttS = (typeof attendanceState.enumValues)[number];
export const ATTENDANCE: Machine<AttS> = {
  name: "attendance_day", states: attendanceState.enumValues,
  terminal: ["EARLY_DEPARTURE", "CHECKED_OUT", "ABSENT_FULL_DAY"],
  edges: [
    { from: "SCHEDULED", to: "EXPECTED_LATE", by: ["A", "S"] },
    { from: "SCHEDULED", to: "AM_SELF_DROP", by: ["A", "S"] },
    { from: "SCHEDULED", to: "CHECKED_IN", by: ["S"] },
    { from: "EXPECTED_LATE", to: "CHECKED_IN", by: ["S"] },
    { from: "AM_SELF_DROP", to: "CHECKED_IN", by: ["S"] },
    { from: "CHECKED_IN", to: "EARLY_DEPARTURE", by: ["S"] },
    { from: "CHECKED_IN", to: "CHECKED_OUT", by: ["S"] },
    { from: "SCHEDULED", to: "ABSENT_FULL_DAY", by: ["A", "S"], note: "cascade: both legs CANCELED_ATTENDANCE" },
    { from: "EXPECTED_LATE", to: "ABSENT_FULL_DAY", by: ["A", "S"] },
  ],
};

type CapS = (typeof capabilityState.enumValues)[number];
export const CAPABILITY: Machine<CapS> = {
  name: "vehicle_capability_day", states: capabilityState.enumValues,
  // Terminal for this vehicle-day; a substitute vehicle gets its own capability row starting at UNKNOWN.
  terminal: ["REJECTED", "UNAVAILABLE", "VERIFIED_INFEASIBLE"],
  edges: [
    { from: "UNKNOWN", to: "REQUESTED", by: ["Y", "A"] },
    { from: "REQUESTED", to: "REPORTED", by: ["P"] },
    { from: "REPORTED", to: "VERIFIED", by: ["S"] },
    { from: "*", to: "CHANGED", by: ["P", "S"], note: "substitution; then Y resets to UNKNOWN" },
    { from: "CHANGED", to: "UNKNOWN", by: ["Y"] },
    { from: "REPORTED", to: "REJECTED", by: ["S"] },
    { from: "VERIFIED", to: "UNAVAILABLE", by: ["S", "P"] },
    { from: "VERIFIED", to: "VERIFIED_INFEASIBLE", by: ["Y"] },
  ],
};

type ResS = (typeof reservationState.enumValues)[number];
export const RESERVATION: Machine<ResS> = {
  name: "manifest_reservation", states: reservationState.enumValues,
  terminal: ["INFEASIBLE", "RELEASED"],
  edges: [
    { from: "PROVISIONAL", to: "FEASIBLE", by: ["Y"] },
    { from: "PROVISIONAL", to: "INFEASIBLE", by: ["Y"] },
    { from: "FEASIBLE", to: "COMMITTED", by: ["S"] },
    { from: "COMMITTED", to: "RELEASED", by: ["A", "S"] },
    { from: "*", to: "NEEDS_REVIEW", by: ["Y"] },
  ],
};

type OutS = (typeof outboundState.enumValues)[number];
export const OUTBOUND: Machine<OutS> = {
  name: "outbound_message", states: outboundState.enumValues,
  terminal: ["BLOCKED_EGRESS", "UNDELIVERED", "FAILED", "REDACTED", "CANCELED_STALE"],
  edges: [
    { from: "DRAFTED", to: "POLICY_CHECKED", by: ["Y"] },
    { from: "POLICY_CHECKED", to: "QUEUED", by: ["Y"] },
    { from: "QUEUED", to: "BLOCKED_EGRESS", by: ["Y"] },
    { from: "QUEUED", to: "SENDING", by: ["Y"] },
    { from: "SENDING", to: "SENT", by: ["Y"] },
    { from: "SENDING", to: "FAILED", by: ["Y"], note: "definite provider rejection (DECISION-LEDGER, Firia 2026-10-14)" },
    { from: "SENDING", to: "UNKNOWN", by: ["Y"], note: "timeout or ambiguous provider error; never blind resend" },
    { from: "SENT", to: "UNKNOWN", by: ["Y"], note: "no status callback in time (PRD l.754)" },
    // UNKNOWN resolves only via provider lookup by idempotency attribute (never a resend).
    { from: "UNKNOWN", to: "SENT", by: ["Y"] },
    { from: "UNKNOWN", to: "DELIVERED", by: ["Y"] },
    { from: "UNKNOWN", to: "UNDELIVERED", by: ["Y"] },
    { from: "UNKNOWN", to: "FAILED", by: ["Y"] },
    // Staff exit (DECISION-LEDGER, Firia 2026-10-14): after checking with the family/provider, staff close an UNKNOWN.
    { from: "UNKNOWN", to: "DELIVERED", by: ["S"], note: "staff confirmed receipt" },
    { from: "UNKNOWN", to: "FAILED", by: ["S"], note: "staff confirmed not received" },
    { from: "SENT", to: "DELIVERED", by: ["Y"] },
    { from: "SENT", to: "UNDELIVERED", by: ["Y"] },
    { from: "SENT", to: "FAILED", by: ["Y"] },
    { from: "DELIVERED", to: "REDACTED", by: ["Y"] },
    ...(["DRAFTED", "POLICY_CHECKED", "QUEUED"] as OutS[]).map((f): Edge<OutS> => ({ from: f, to: "CANCELED_STALE", by: ["Y"] })),
  ],
};

type AckS = (typeof ackState.enumValues)[number];
export const ACK: Machine<AckS> = {
  name: "acknowledgment", states: ackState.enumValues,
  terminal: ["ACKNOWLEDGED", "DECLINED", "EXPIRED_ESCALATED", "SUPERSEDED"],
  edges: [
    { from: "PENDING", to: "ACKNOWLEDGED", by: ["T", "S"], note: "therapist (AT-14) or staff recipient, via Teams" },
    { from: "PENDING", to: "DECLINED", by: ["T", "S"], note: "⇒ AMBER exception" },
    { from: "PENDING", to: "EXPIRED_ESCALATED", by: ["Y"] },
    { from: "PENDING", to: "SUPERSEDED", by: ["Y"] },
  ],
};

type TaskS = (typeof taskState.enumValues)[number];
export const TASK: Machine<TaskS> = {
  name: "task", states: taskState.enumValues,
  terminal: [], // CLOSED_VERIFIED reopens on failed verification (PRD §6.3)
  edges: [
    { from: "OPEN", to: "IN_PROGRESS", by: ["S"] },
    { from: "IN_PROGRESS", to: "RESOLVED_APPROVED", by: ["S"] },
    { from: "IN_PROGRESS", to: "RESOLVED_OVERRIDE", by: ["S"] },
    { from: "RESOLVED_APPROVED", to: "CLOSED_VERIFIED", by: ["Y"], note: "requires completion_evidence (DB check)" },
    { from: "RESOLVED_OVERRIDE", to: "CLOSED_VERIFIED", by: ["Y"] },
    { from: "CLOSED_VERIFIED", to: "OPEN", by: ["Y"], note: "failed verification" },
    { from: "OPEN", to: "SNOOZED", by: ["S"] },
    { from: "IN_PROGRESS", to: "SNOOZED", by: ["S"] },
    { from: "SNOOZED", to: "OPEN", by: ["Y", "S"] },
  ],
};

type ThreadS = (typeof threadState.enumValues)[number];
export const THREAD: Machine<ThreadS> = {
  name: "conversation_thread", states: threadState.enumValues,
  terminal: ["CLOSED"],
  edges: [
    { from: "OPEN", to: "PAUSED_HUMAN", by: ["S"] },
    { from: "PAUSED_HUMAN", to: "OPEN", by: ["S"], note: "release requires next owner" },
    { from: "OPEN", to: "CLOSED", by: ["Y"] },
    { from: "PAUSED_HUMAN", to: "CLOSED", by: ["Y"] },
  ],
};

type ProfS = (typeof profileState.enumValues)[number];
export const PROFILE: Machine<ProfS> = {
  name: "transport_profile", states: profileState.enumValues,
  terminal: ["SUPERSEDED"],
  edges: [
    { from: "DRAFT", to: "APPROVED", by: ["S"] },
    { from: "APPROVED", to: "SUPERSEDED", by: ["Y"] },
  ],
};

type NeedS = (typeof needItemState.enumValues)[number];
export const NEED_ITEM: Machine<NeedS> = {
  name: "transport_need_item", states: needItemState.enumValues,
  terminal: ["APPROVED"],
  edges: [
    { from: "UNKNOWN", to: "REPORTED", by: ["P", "G", "S"], note: "PRD silent on actor; recorded in DATA-MODEL §4" },
    { from: "REPORTED", to: "VERIFIED", by: ["S"] },
    { from: "VERIFIED", to: "APPROVED", by: ["S"] },
  ],
};

export const MACHINES = { LEG, ATTENDANCE, CAPABILITY, RESERVATION, OUTBOUND, ACK, TASK, THREAD, PROFILE, NEED_ITEM };

export function wildcardApplies<T extends string>(m: Machine<T>, from: T, to: T) {
  return from !== to && !m.terminal.includes(from) && !(m.noWildcardFrom ?? []).includes(from);
}

export function canTransition<T extends string>(m: Machine<T>, from: T, to: T, actor: Actor, ctx: TransitionCtx<T> = {}): boolean {
  if (from === to || m.terminal.includes(from)) return false;
  if (m === (LEG as unknown as Machine<T>) && from === ("EXCEPTION" as T)) {
    return actor === "S" && ctx.priorState != null && ctx.priorState === to && !m.terminal.includes(to) && to !== ("EXCEPTION" as T);
  }
  return m.edges.some((e) =>
    (e.from === from || (e.from === "*" && wildcardApplies(m, from, e.to))) && e.to === to && e.by.includes(actor) &&
    !(actor === "A" && e.agentRequiresVerifiedGuardian && ctx.verifiedUnambiguousGuardian !== true));
}
