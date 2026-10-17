/** Capacity solver (PRD §7). Deterministic, pure; no LLM, no DB, no clock. */
export * from "./types";
export { feasible, onboardByStop, chairFitsPosition, DEFICIT_REPORT_ORDER, OPTION_RANK } from "./feasible";
export type { AlternateCandidate, FeasibleOptions, StopOccupancy } from "./feasible";
export { maxMatching } from "./matching";
export type { MatchResult } from "./matching";
/** Planning a fleet over the same constraints (VEH-01…05, B-09). */
export {
  buildLeg,
  buildManifest,
  canTake,
  causeOfDeficit,
  dropOffsCovered,
  laneSeats,
  layoutPlaces,
  peakNeed,
  placedTokens,
  planAssignment,
  plannedLayout,
  planRoutes,
  riderOf,
  ridersInOrder,
  routePlan,
  solveLane,
  tryMove,
  withMove,
} from "./plan";
export type {
  Assignment,
  Direction,
  LanePlan,
  LaneSeats,
  ManualPlacements,
  MoveCheck,
  MoveResult,
  PlanInput,
  PlanLane,
  PlanRider,
  Places,
  RoutePlan,
  Unplaced,
  UnplacedCause,
} from "./plan";
