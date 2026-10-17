/**
 * What "Re-plan" does on the ramp, behind one interface.
 *
 * SOURCE: redesign spec §2 — "If someone doesn't fit, a crit banner at the top reads `Mia R.
 * won't fit · 1 car seat short`, with a **Re-plan** button. Re-plan runs Auto-plan for that leg
 * with the observed setup and pushes a proposal to the coordinator (the #60 flow), rather than
 * moving anyone silently."
 *
 * **PR #60 owns that flow and is not on main yet.** Its `replanForArrival`
 * (src/domain/plan/arrival.ts on team/ppe-demo6-roi) re-plans a leg around one van's observed
 * capability and produces moves, holds and the §9 options for a coordinator to approve. Rather
 * than write a second one of those here — two re-plans is two answers to one question — the ramp
 * screen calls **through this port**, and the implementation in this PR is the honest subset of
 * what it can do without those rows: hand the leg to the coordinator's own board, where the same
 * Auto-plan runs against the setup the front desk just counted.
 *
 * When #60 lands, its re-plan is wired in here: the request is the same, and the outcome gains
 * the proposal it pushed. Nothing above this file changes.
 *
 * Pure: no clock, no database, no network. The port returns *what to do*, and the screen does it.
 */
import type { Direction } from "@/domain/solver";
import type { VanSetup } from "./fit";
import { boardHref } from "@/modules/plan/when";

export type RampReplanRequest = {
  /** The service date and leg being re-planned, in centre time. */
  date: string;
  leg: Direction;
  /** The van that was counted, by id. */
  vanId: string;
  /** What the front desk actually found on it. */
  observed: VanSetup;
  /** Whether this caller may open the planning board at all (the access table's answer). */
  canPlan: boolean;
};

export type RampReplanOutcome =
  /** Open the board for this leg, with the counted van selected. */
  | { kind: "OPEN_BOARD"; href: string }
  /**
   * This caller cannot open the board, so the ramp offers no link to it — §9.3's own rule for
   * this screen ("link `Plan routes` … hidden for front desk"). What they can act on is the
   * shortfall, which the banner names, and the Confirm beside it.
   */
  | { kind: "NOT_THEIRS" };

export type RampReplan = (request: RampReplanRequest) => RampReplanOutcome;

/**
 * The implementation this PR ships: the leg, handed to the coordinator's board with the counted
 * van selected, so the next Auto-plan there is made against what actually arrived.
 *
 * Deliberately not a silent move. §2's whole point is that a van arriving short does not quietly
 * reshuffle children — a person decides, and this is how the question reaches them.
 */
export const openPlanBoard: RampReplan = (request) =>
  request.canPlan
    ? {
        kind: "OPEN_BOARD",
        href: boardHref("/plan-routes", {
          date: request.date,
          leg: request.leg,
          van: request.vanId,
        }),
      }
    : { kind: "NOT_THEIRS" };
