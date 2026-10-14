/**
 * Capacity solver types (PRD §7 l.784-800, §9 l.870-880).
 *
 * Deterministic and pure: no LLM, no DB, no clock. Everything the solver needs is in its inputs,
 * so the same inputs always give the same answer (a solver verdict is evidence in an exception).
 *
 * Vocabulary follows the PRD: vehicle v has mutually exclusive layouts L(v); each layout l has
 * wheelchair positions W_l (securement type + max footprint), ambulatory seats A_l, tether/LATCH
 * capable seats T_l subset of A_l, and lift_required(l). Daily inputs are lift_ok(v) and unavail(v).
 * On_k is the set of children onboard after manifest stop k.
 */

/** Matches the ops.securement enum (src/db/schema.ts) so the seed slice can map 1:1. */
export type Securement = "L_TRACK" | "SLIDE_N_CLICK" | "FOUR_POINT_STRAP" | "OTHER";
/** Matches the ops.mobility enum. */
export type Mobility = "AMB" | "WC";
/** Matches the ops.capability_state enum (vehicle_capability_day.state). */
export type CapabilityState =
  | "UNKNOWN" | "REQUESTED" | "REPORTED" | "VERIFIED" | "CHANGED"
  | "REJECTED" | "UNAVAILABLE" | "VERIFIED_INFEASIBLE";

/** A wheelchair position in W_l. */
export type WcPosition = {
  id: string;
  kind: "WC";
  /** sec(w): a chair's securement must equal the position's, never "compatible". */
  securement: Securement;
  /** Max footprint the position accepts, centimetres. */
  maxLengthCm: number;
  maxWidthCm: number;
};

/** An ambulatory seat in A_l; tetherCapable marks membership of T_l. */
export type AmbSeat = {
  id: string;
  kind: "AMB";
  /** Seat has a tether / LATCH anchor (T_l subset of A_l). */
  tetherCapable: boolean;
};

export type LayoutPosition = WcPosition | AmbSeat;

/** One mutually exclusive seating configuration of a vehicle, e.g. {1WC/3A}. */
export type Layout = {
  id: string;
  /** Human label used in copy, e.g. "1WC/3A". */
  code: string;
  /** lift_required(l): this configuration can only board a wheelchair via the lift. */
  liftRequired: boolean;
  positions: LayoutPosition[];
};

export type Vehicle = {
  id: string;
  /** Short label used on tiles and in copy, e.g. "V1". */
  label: string;
  /** Plain words for the vehicle, e.g. "Convertible van". */
  description: string;
  providerId: string;
  providerName: string;
  /** Vehicle has a lift at all; false means lift_ok(v) can never be true. */
  liftEquipped: boolean;
  /** L(v): at most ~4 layouts in practice (PRD §7). */
  layouts: Layout[];
};

export type Child = {
  token: string;
  /** First name + last initial, synthetic only (COPY-GUIDE §3). */
  displayName: string;
  mobility: Mobility;
  /** Measured chair footprint incl. child-owned equipment, centimetres. Required when mobility is WC. */
  wcLengthCm?: number;
  wcWidthCm?: number;
  /** sec(c). Required when mobility is WC. */
  securement?: Securement;
  /** tether(c): needs a tether / LATCH-anchored seat (car seat, booster, harness, vest). */
  tether: boolean;
  /** escort(c): an attendant rides along and occupies one ambulatory seat. */
  escort: boolean;
  /**
   * Observed on the vehicle already (leg state BOARDED_REPORTED or later).
   * The solver may never propose removing a boarded child (PRD §7 l.800, §9 l.880).
   */
  boarded?: boolean;
};

/** One stop in the manifest sequence. k is 1-based and matches the stop_seq the board shows. */
export type ManifestStop = {
  k: number;
  /** Landmark label, e.g. "Okeeheelee Park". */
  label: string;
  /** Child tokens boarding here. */
  boarding?: string[];
  /** Child tokens getting off here. */
  alighting?: string[];
  /**
   * staff_escort_k: staff riders occupying ambulatory seats after this stop (absolute, not a delta).
   * Omitted means "same as the previous stop"; omitted on stop 1 means 0.
   */
  staffEscorts?: number;
};

export type Leg = {
  id: string;
  direction: "AM" | "PM";
  manifestId?: string | null;
  /**
   * Layout fixed per leg (ASM-17). When set, only this layout is considered.
   * Null or omitted means the solver searches every layout in L(v).
   */
  layoutId?: string | null;
  /** Roster for this leg; a child named by a stop must appear here. */
  children: Child[];
  stops: ManifestStop[];
};

/**
 * Daily capability observation for one vehicle-day (ops.vehicle_capability_day).
 * Unknown is never read as available: see CAPABILITY_PENDING (PRD §7 l.797).
 */
export type DailyCapability = {
  vehicleId: string;
  /** ISO date, "2026-10-14". */
  serviceDate: string;
  state: CapabilityState;
  /**
   * The configuration the vehicle actually arrived in, when the ramp or dispatcher reports it.
   * Pins the layout search to this layout; takes precedence over leg.layoutId.
   */
  observedLayoutId?: string | null;
  /** lift_ok(v). Null means not reported yet. */
  liftOk: boolean | null;
  /**
   * Tether / LATCH anchors usable today. False empties T_l; null means not reported yet
   * (pending only when some child needs a tether).
   */
  latchOk?: boolean | null;
  /** unavail(v): positions and seats reported out of service. */
  unavailablePositionIds: string[];
  /** Positions the reporter answered "Not sure" about. Never counted as available. */
  unknownPositionIds?: string[];
  observedAt?: string | null;
  /** "J.T." — who reported, for the evidence chip. */
  observedBy?: string | null;
};

export type DeficitType =
  /** Fewer usable wheelchair positions than wheelchair riders. */
  | "WC_POSITION"
  /** Enough positions, but no position with the required securement type. */
  | "WC_SECUREMENT"
  /** Enough positions of the right type, but the chair does not fit the footprint. */
  | "WC_FOOTPRINT"
  /** Constraint 2: ambulatory seats for riders + escorts + staff. */
  | "AMBULATORY_SEAT"
  /** Constraint 3: tether / LATCH capable seats. */
  | "TETHER_SEAT"
  /** Constraint 4: a wheelchair rider needs the lift and the lift is not working. */
  | "LIFT";

/** {k, type, count} exactly as PRD §7 l.799. */
export type Deficit = { k: number; type: DeficitType; count: number };

export type WcAssignment = { childToken: string; positionId: string };

/** Per-stop occupancy for a feasible layout; drives the ramp slot allocation matrix. */
export type StopPlan = {
  k: number;
  label: string;
  /** On_k, child tokens, in boarding order. */
  onboard: string[];
  wcAssignments: WcAssignment[];
  ambulatorySeatsUsed: number;
  ambulatorySeatsAvailable: number;
  tetherSeatsUsed: number;
  tetherSeatsAvailable: number;
};

export type LayoutVerdict = "FEASIBLE" | "INFEASIBLE" | "CAPABILITY_PENDING";

export type LayoutAttempt = {
  layoutId: string;
  layoutCode: string;
  /** Wheelchair positions this configuration is built with, before today's availability. */
  wcPositionsBuilt: number;
  verdict: LayoutVerdict;
  /** Earliest failing stop and its deficits, ranked by PRD constraint order. */
  firstFailureK: number | null;
  deficits: Deficit[];
  /** Why the answer is unknown rather than infeasible, in plain words. */
  pendingReason: string | null;
  /** Filled only when the verdict is FEASIBLE. */
  plan: StopPlan[];
};

export type SolveStatus = "FEASIBLE" | "INFEASIBLE" | "CAPABILITY_PENDING" | "VEHICLE_UNAVAILABLE";

/** PRD §7 l.799 and §9 l.880 option set. Every one of them needs a human decision. */
export type OptionKind =
  | "SPLIT_RUN" | "ALTERNATE_VEHICLE" | "ALTERNATE_PROVIDER" | "FAMILY_TRANSPORT" | "DELAY" | "CANCEL";

export type ResolutionOption = {
  id: string;
  kind: OptionKind;
  /** 1 = offer first. Ranked in PRD order; several candidates can share a rank. */
  rank: number;
  /** Button-length label, no ticket codes (COPY-GUIDE §2). */
  label: string;
  /** One sentence a coordinator can act on. */
  detail: string;
  /** Always true: the solver proposes, a named human approves (PRD §6.1, §9). */
  requiresApproval: true;
  approverRole: "COORDINATOR" | "DIRECTOR";
  /** Children this option would move or affect. Never contains a boarded child. */
  affectedChildTokens: string[];
  candidateVehicleId?: string;
  candidateLayoutCode?: string;
};

export type SolveResult = {
  status: SolveStatus;
  vehicleId: string;
  /** The feasible layout, or null. */
  layout: { id: string; code: string } | null;
  /** Per-stop plan for the feasible layout; empty otherwise. */
  plan: StopPlan[];
  /** Primary deficit {k, type, count}; null unless INFEASIBLE. */
  deficit: Deficit | null;
  /** Every deficit at the reported stop, ranked by PRD constraint order. */
  deficits: Deficit[];
  /** Per-layout working, so a human can see why each configuration failed. */
  attempts: LayoutAttempt[];
  /** Ranked options; empty when FEASIBLE. */
  options: ResolutionOption[];
  /** Why the answer is unknown; null unless CAPABILITY_PENDING. */
  pendingReason: string | null;
  /** Exception severity to raise: RED blocks the manifest lock (PRD §9). */
  severity: "RED" | "AMBER" | null;
  /** The solver never assigns, reassigns or locks anything by itself (AT-12). */
  autoAssigned: false;
  /** Children observed onboard; the solver may never propose removing them. */
  boardedChildTokens: string[];
};
