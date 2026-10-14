/** Capacity solver (PRD §7). Deterministic, pure; no LLM, no DB, no clock. */
export * from "./types";
export { feasible, onboardByStop, chairFitsPosition, DEFICIT_REPORT_ORDER } from "./feasible";
export type { AlternateCandidate, FeasibleOptions, StopOccupancy } from "./feasible";
export { maxMatching } from "./matching";
export type { MatchResult } from "./matching";
