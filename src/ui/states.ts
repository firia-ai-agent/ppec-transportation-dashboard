/**
 * State vocabulary: icon + label + tone for every domain state in DESIGN-DIRECTION.md §3,
 * plus the source-mode badge vocabulary from §7.1. Labels are verbatim from the doc and are
 * the only place they are written down (COPY-GUIDE §4: "State labels are fixed in §3 and
 * must be used verbatim").
 *
 * Keys are typed from the Drizzle enums in src/db/schema.ts via a *type-only* import, so
 * adding a value to an enum breaks `pnpm typecheck` here, and no database code is pulled
 * into the browser bundle. states.test.ts re-imports the enums at runtime and asserts that
 * every value has an entry.
 *
 * Colour is always the third cue: icon and label carry the meaning (§3, §9 grayscale test).
 *
 * TODO (spec gaps, see the PR summary; do not invent labels for these):
 *  - §3 defines four therapy-session states (SCHEDULED / IMPACTED / THERAPIST_NOTIFIED /
 *    CANCELED) but `ops.therapy_session.status` is a plain `text` column in schema.ts, not a
 *    pgEnum, so the parity test cannot bind to it. Modelled here from §3 and checked against a
 *    local literal list until the column becomes an enum.
 *  - Some §3 labels are written with a sample value rather than a placeholder (GPS bands read
 *    "Live · 12 s", "Stale · 4 min · ETA texts paused"). They are stored here as templates with
 *    an `{age}` placeholder; the surrounding words are verbatim.
 *  - §3 gives no label for `source_mode`; §7.1 does, and that table is used instead.
 */
import type {
  ackState,
  agentRunState,
  attendanceState,
  capabilityState,
  jobState,
  legState,
  needItemState,
  outboundState,
  profileState,
  reservationState,
  severity,
  sourceMode,
  taskState,
  threadState,
} from "@/db/schema";
import {
  Archive,
  BadgeCheck,
  Ban,
  Bot,
  Box,
  CalendarClock,
  CalendarOff,
  CalendarX,
  Car,
  Check,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
  CircleX,
  Clock,
  ClockAlert,
  DoorOpen,
  Eye,
  EyeOff,
  FilePen,
  FlaskConical,
  Hand,
  HandHeart,
  Hourglass,
  ListChecks,
  Loader,
  Locate,
  LocateFixed,
  LocateOff,
  Lock,
  LockOpen,
  LogIn,
  LogOut,
  MapPin,
  MapPinCheck,
  MessageSquareCheck,
  Navigation,
  OctagonAlert,
  OctagonX,
  RadioTower,
  RefreshCw,
  RotateCcwClock,
  Send,
  SendHorizontal,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  ShieldX,
  Truck,
  UserCheck,
  UserRound,
  UserX,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ColorToken, Tone } from "./tokens";

export type StateDescriptor = {
  icon: LucideIcon;
  /** Verbatim from §3. May contain `{placeholder}` segments; render through `fill()` in copy.ts. */
  label: string;
  tone: Tone;
};

type Values<T extends { enumValues: readonly string[] }> = T["enumValues"][number];
type Vocabulary<K extends string> = Readonly<Record<K, StateDescriptor>>;

/* ───────────────────────────── trip leg (§3) ───────────────────────────── */

export const legStates: Vocabulary<Values<typeof legState>> = {
  SCHEDULED: { icon: CalendarClock, label: "Scheduled", tone: "neutral" },
  PROVISIONAL_ASSIGNED: { icon: CircleDashed, label: "Provisional", tone: "neutral" },
  CAPABILITY_PENDING: { icon: CircleQuestionMark, label: "Vehicle check pending", tone: "warn" },
  CAPABILITY_REPORTED: { icon: MessageSquareCheck, label: "Reported by provider", tone: "info" },
  CAPABILITY_VERIFIED: { icon: ShieldCheck, label: "Vehicle verified", tone: "ok" },
  MANIFEST_LOCKED: { icon: Lock, label: "Manifest locked", tone: "info" },
  EN_ROUTE_PICKUP: { icon: Navigation, label: "On the way to pickup", tone: "info" },
  ARRIVED_PICKUP: { icon: MapPin, label: "At pickup (vehicle)", tone: "info" },
  BOARDED_REPORTED: { icon: UserCheck, label: "Boarded (reported)", tone: "info" },
  BOARDED_VERIFIED: { icon: BadgeCheck, label: "Boarded, verified", tone: "ok" },
  IN_TRANSIT: { icon: Truck, label: "In transit", tone: "info" },
  // Never "Handed off" on a geofence (PRD SURF-01, COPY-GUIDE §2).
  ARRIVED_DROPOFF: { icon: MapPinCheck, label: "Arrived (vehicle)", tone: "info" },
  COMPLETED_HANDOFF: { icon: HandHeart, label: "Handed off to {receiver role}", tone: "ok" },
  CANCELED_TRANSPORT: { icon: CircleSlash, label: "Ride canceled", tone: "neutral" },
  CANCELED_ATTENDANCE: { icon: CalendarX, label: "Not attending today", tone: "neutral" },
  NO_SHOW: { icon: UserX, label: "Not at pickup", tone: "crit" },
  HELD_NO_RECEIVER: { icon: Hand, label: "Held: no adult to receive", tone: "crit" },
  LEFT_BEHIND_CAPACITY: { icon: TriangleAlert, label: "Waiting: vehicle full", tone: "crit" },
  EXCEPTION: { icon: OctagonAlert, label: "Needs action", tone: "crit" },
};

/* ───────────────────────────── attendance (§3) ───────────────────────────── */

export const attendanceStates: Vocabulary<Values<typeof attendanceState>> = {
  SCHEDULED: { icon: CalendarClock, label: "Expected today", tone: "neutral" },
  EXPECTED_LATE: { icon: ClockAlert, label: "Running late", tone: "warn" },
  AM_SELF_DROP: { icon: Car, label: "Family drop-off", tone: "neutral" },
  CHECKED_IN: { icon: LogIn, label: "Checked in", tone: "ok" },
  EARLY_DEPARTURE: { icon: LogOut, label: "Left early", tone: "warn" },
  CHECKED_OUT: { icon: DoorOpen, label: "Checked out", tone: "neutral" },
  ABSENT_FULL_DAY: { icon: CalendarX, label: "Absent today", tone: "neutral" },
};

/* ───────────────────────────── vehicle capability (§3) ───────────────────────────── */

export const capabilityStates: Vocabulary<Values<typeof capabilityState>> = {
  // The normal morning state, not an error (§4.2).
  UNKNOWN: { icon: CircleQuestionMark, label: "Unknown until arrival", tone: "warn" },
  REQUESTED: { icon: Send, label: "Asked provider", tone: "info" },
  REPORTED: { icon: MessageSquareCheck, label: "Reported by provider", tone: "info" },
  VERIFIED: { icon: ShieldCheck, label: "Checked at the ramp", tone: "ok" },
  CHANGED: { icon: RefreshCw, label: "Changed", tone: "warn" },
  REJECTED: { icon: CircleX, label: "Rejected", tone: "crit" },
  UNAVAILABLE: { icon: Ban, label: "Vehicle unavailable", tone: "crit" },
  VERIFIED_INFEASIBLE: { icon: ShieldX, label: "Verified: won't fit", tone: "crit" },
};

/* ───────────────────────────── seat reservation (§3) ───────────────────────────── */

export const reservationStates: Vocabulary<Values<typeof reservationState>> = {
  PROVISIONAL: { icon: CircleDashed, label: "Seat held (not checked)", tone: "neutral" },
  FEASIBLE: { icon: Check, label: "Fits", tone: "ok" },
  INFEASIBLE: { icon: OctagonX, label: "Doesn't fit", tone: "crit" },
  COMMITTED: { icon: Lock, label: "Seat confirmed", tone: "ok" },
  RELEASED: { icon: LockOpen, label: "Seat released", tone: "neutral" },
  NEEDS_REVIEW: { icon: Eye, label: "Needs review", tone: "warn" },
};

/* ───────────────────────────── outbound message (§3) ───────────────────────────── */

export const outboundStates: Vocabulary<Values<typeof outboundState>> = {
  DRAFTED: { icon: FilePen, label: "Draft", tone: "neutral" },
  POLICY_CHECKED: { icon: ListChecks, label: "Checked, ready to queue", tone: "neutral" },
  QUEUED: { icon: Clock, label: "Queued", tone: "neutral" },
  BLOCKED_EGRESS: { icon: ShieldBan, label: "Blocked (opted out or policy)", tone: "crit" },
  SENDING: { icon: SendHorizontal, label: "Sending", tone: "info" },
  SENT: { icon: Send, label: "Sent", tone: "info" },
  DELIVERED: { icon: CheckCheck, label: "Delivered", tone: "ok" },
  UNDELIVERED: { icon: CircleAlert, label: "Not delivered", tone: "warn" },
  FAILED: { icon: CircleX, label: "Failed", tone: "crit" },
  UNKNOWN: { icon: CircleQuestionMark, label: "Delivery unknown", tone: "warn" },
  REDACTED: { icon: EyeOff, label: "Text removed (privacy)", tone: "neutral" },
  CANCELED_STALE: { icon: CalendarOff, label: "Not sent (out of date)", tone: "neutral" },
};

/* ───────────────────────────── severity (§3) ───────────────────────────── */

export const severityStates: Vocabulary<Values<typeof severity>> = {
  GREEN: { icon: CircleCheck, label: "Low", tone: "ok" },
  AMBER: { icon: TriangleAlert, label: "Medium", tone: "warn" },
  RED: { icon: OctagonAlert, label: "Urgent", tone: "crit" },
};

/* ───────────────────────────── message thread (§3) ───────────────────────────── */

export const threadStates: Vocabulary<Values<typeof threadState>> = {
  OPEN: { icon: Bot, label: "Agent handling", tone: "info" },
  PAUSED_HUMAN: { icon: UserRound, label: "Staff: {first name}", tone: "neutral" },
  CLOSED: { icon: Archive, label: "Closed (quiet 24 h)", tone: "neutral" },
};

/* ───────────────────────────── acknowledgement (§3) ───────────────────────────── */

export const ackStates: Vocabulary<Values<typeof ackState>> = {
  PENDING: { icon: Hourglass, label: "Waiting for reply", tone: "warn" },
  ACKNOWLEDGED: { icon: CheckCheck, label: "Acknowledged", tone: "ok" },
  DECLINED: { icon: CircleX, label: "Declined", tone: "crit" },
  EXPIRED_ESCALATED: { icon: ShieldAlert, label: "No reply, escalated", tone: "crit" },
  SUPERSEDED: { icon: RotateCcwClock, label: "Replaced by newer request", tone: "neutral" },
};

/* ───────────────────── exception task (§3; `loader` never spins under reduced motion) ───────────────────── */

export const taskStates: Vocabulary<Values<typeof taskState>> = {
  OPEN: { icon: OctagonAlert, label: "Open", tone: "crit" },
  IN_PROGRESS: { icon: Loader, label: "Being handled by {name}", tone: "info" },
  RESOLVED_APPROVED: { icon: CircleCheck, label: "Resolved: approved", tone: "ok" },
  RESOLVED_OVERRIDE: { icon: Hand, label: "Resolved: staff override", tone: "warn" },
  CLOSED_VERIFIED: { icon: BadgeCheck, label: "Closed, checked", tone: "ok" },
  SNOOZED: { icon: CirclePause, label: "Snoozed until {time}", tone: "neutral" },
};

/* ───────────────────────────── transport profile (§3) ───────────────────────────── */

export const profileStates: Vocabulary<Values<typeof profileState>> = {
  DRAFT: { icon: FilePen, label: "Draft, not used for rides", tone: "neutral" },
  APPROVED: { icon: BadgeCheck, label: "Approved v{n}", tone: "ok" },
  SUPERSEDED: { icon: RotateCcwClock, label: "Older version", tone: "neutral" },
};

/* ───────────────────────────── need item (§3) ───────────────────────────── */

export const needItemStates: Vocabulary<Values<typeof needItemState>> = {
  UNKNOWN: { icon: CircleQuestionMark, label: "Not known yet", tone: "warn" },
  REPORTED: { icon: MessageSquareCheck, label: "Reported", tone: "info" },
  VERIFIED: { icon: ShieldCheck, label: "Checked", tone: "ok" },
  APPROVED: { icon: BadgeCheck, label: "Approved (used for seating)", tone: "ok" },
};

/* ───────────────────────────── agent run (§3; Inbox + Health only) ───────────────────────────── */

export const agentRunStates: Vocabulary<Values<typeof agentRunState>> = {
  QUEUED: { icon: Clock, label: "Agent queued", tone: "neutral" },
  RUNNING: { icon: Bot, label: "Agent working", tone: "info" },
  WAITING_TOOL: { icon: Hourglass, label: "Agent waiting", tone: "neutral" },
  SUCCEEDED: { icon: CircleCheck, label: "Agent done", tone: "ok" },
  FAILED: { icon: CircleX, label: "Agent failed", tone: "crit" },
  ABORTED_SUPERSEDED_BY_HUMAN: { icon: UserRound, label: "Staff took over", tone: "neutral" },
};

/* ───────────────────────────── timer job (§3; Health / demo fire log only) ───────────────────────────── */

export const jobStates: Vocabulary<Values<typeof jobState>> = {
  SCHEDULED: { icon: Clock, label: "Scheduled", tone: "neutral" },
  CLAIMED: { icon: Loader, label: "Running", tone: "info" },
  DONE: { icon: Check, label: "Done", tone: "ok" },
  CANCELED: { icon: CircleSlash, label: "Canceled", tone: "neutral" },
  FAILED: { icon: CircleX, label: "Failed, retrying", tone: "warn" },
  DEAD: { icon: OctagonX, label: "Failed, needs a person", tone: "crit" },
};

/* ───────────────────── therapy session (§3; status is `text` in schema.ts, see TODO) ───────────────────── */

export const therapySessionStatusValues = [
  "SCHEDULED",
  "IMPACTED",
  "THERAPIST_NOTIFIED",
  "CANCELED",
] as const;
export type TherapySessionStatus = (typeof therapySessionStatusValues)[number];

export const therapySessionStates: Vocabulary<TherapySessionStatus> = {
  SCHEDULED: { icon: CalendarClock, label: "Therapy scheduled", tone: "neutral" },
  IMPACTED: { icon: TriangleAlert, label: "Therapy affected", tone: "warn" },
  THERAPIST_NOTIFIED: { icon: Send, label: "Therapist told", tone: "info" },
  CANCELED: { icon: CalendarX, label: "Therapy canceled", tone: "neutral" },
};

/* ───────────────────── GPS freshness: four bands (D-2, §3) ───────────────────── */

/** Band boundaries in seconds. D-2 chose four bands to honour both the PRD and the STALE badge. */
export const gpsFreshnessBands = [
  { key: "FRESH", maxAgeSeconds: 60 },
  { key: "AGING", maxAgeSeconds: 180 },
  { key: "STALE", maxAgeSeconds: 600 },
  { key: "LOST", maxAgeSeconds: Number.POSITIVE_INFINITY },
] as const;
export type GpsFreshness = (typeof gpsFreshnessBands)[number]["key"];

/** §3 writes these with a sample age ("Live · 12 s"); `{age}` is that sample, see the TODO above. */
export const gpsFreshnessStates: Vocabulary<GpsFreshness> = {
  FRESH: { icon: LocateFixed, label: "Live · {age}", tone: "ok" },
  AGING: { icon: Locate, label: "Last seen {age}", tone: "neutral" },
  STALE: { icon: ClockAlert, label: "Stale · {age} · ETA texts paused", tone: "warn" },
  LOST: { icon: LocateOff, label: "No signal · {age}", tone: "crit" },
};

/** Maps an age in seconds to its band (§3, D-2). */
export function gpsFreshnessFor(ageSeconds: number): GpsFreshness {
  return (gpsFreshnessBands.find((b) => ageSeconds < b.maxAgeSeconds) ?? gpsFreshnessBands[3]).key;
}

/* ───────────────────── source-mode badge (§7.1, D-10) ───────────────────── */

export type SourceDescriptor = {
  icon: LucideIcon;
  label: string;
  /** Outlined chip: the token colours the text and icon only. LIVE is never violet (§7.1). */
  textToken: ColorToken;
};

export const sourceModes: Readonly<Record<Values<typeof sourceMode>, SourceDescriptor>> = {
  SIMULATED: { icon: FlaskConical, label: "Simulated", textToken: "src-sim" },
  REPLAY: { icon: RotateCcwClock, label: "Replay", textToken: "ink-muted" },
  MANUAL: { icon: Hand, label: "Manual entry", textToken: "ink-muted" },
  SANDBOX: { icon: Box, label: "Sandbox", textToken: "ink-muted" },
  LIVE: { icon: RadioTower, label: "Live", textToken: "ink" },
};

export type SourceModeKey = keyof typeof sourceModes;

/** Every vocabulary in this file, for the parity test and future dev surfaces. */
export const vocabularies = {
  leg_state: legStates,
  attendance_state: attendanceStates,
  capability_state: capabilityStates,
  reservation_state: reservationStates,
  outbound_state: outboundStates,
  severity: severityStates,
  thread_state: threadStates,
  ack_state: ackStates,
  task_state: taskStates,
  profile_state: profileStates,
  need_item_state: needItemStates,
  agent_run_state: agentRunStates,
  job_state: jobStates,
  therapy_session_status: therapySessionStates,
  gps_freshness: gpsFreshnessStates,
} as const;
