/**
 * Which setup a van is planned against today, and how that setup becomes a question the capacity
 * solver can answer.
 *
 * SOURCE: redesign spec §1.6 ("Default rule"), §1.4 ("Auto-plan … keep #58's solver by wrapping
 * it"), §9.1 (van setup is a **soft** prerequisite for planning) and conflict C5: planning on
 * yesterday's confirmed setup is allowed, boarding still needs today's ramp Confirm.
 *
 * **The default ladder, written once.** Today's `vehicle_setup_day` row if there is one;
 * otherwise the most recent `CHECKED` row for that van, which is what "tomorrow starts from this"
 * means on the ramp iPad; otherwise the configured default (src/config/vans.ts). The screen says
 * which rung it is standing on — "Using yesterday's van setup", "Using van defaults" — because a
 * plan made against a van nobody has counted today is a plan with an assumption in it, and §9's
 * rule is that the assumption is named in place rather than hidden.
 *
 * Pure: no clock, no database, no network. The rows come from src/modules/plan (the store), the
 * words from src/ui/copy.ts.
 */
import { VANS, vanConfigOf } from "@/config/vans";
import type { Layout, Securement, Vehicle } from "@/domain/solver";
import type { VanSetup } from "./fit";

/** The three states a day's setup can be in (§1.6). */
export const SETUP_STATES = ["DEFAULT", "PLANNED", "CHECKED"] as const;
export type SetupState = (typeof SETUP_STATES)[number];

/** One `ops.vehicle_setup_day` row, as the store hands it over. */
export type SetupRow = {
  vehicleId: string;
  /** "2026-10-17", the service date in centre time. */
  serviceDate: string;
  setup: VanSetup;
  state: SetupState;
  /**
   * Who set it, **in words** ("Ana P."), or null when nobody is recorded — which is the case for
   * a row the demo seed wrote and for the browser check's session, which has no user behind it.
   * The row itself holds a user id; the store turns it into a name on the way out
   * (src/auth/demo-accounts.ts `staffLabel`), because a screen may not print `display_name`: it
   * carries the synthetic marker.
   */
  setBy: string | null;
  setAt: string | null;
};

/** Which rung of the ladder today's setup came from (§9.4's `source`). */
export const SETUP_SOURCES = ["TODAY", "YESTERDAY", "DEFAULT"] as const;
export type SetupSource = (typeof SETUP_SOURCES)[number];

export type ResolvedSetup = {
  setup: VanSetup;
  /** The state to show on the van: only a `CHECKED` row for *today* reads as checked. */
  state: SetupState;
  source: SetupSource;
  /** The service date the setup came from, when it is not today's. */
  fromDate?: string;
  setBy?: string | null;
};

/**
 * Today's setup for one van, from the rows the store found for it.
 *
 * `rows` is every setup row that van has on or before `date`, newest first — the store reads them
 * in that order, so this function does no sorting and no date arithmetic of its own. A row for a
 * *later* date is ignored rather than trusted: planning tomorrow is not planning today.
 */
export function resolveSetup(
  vehicleKey: string,
  date: string,
  rows: readonly SetupRow[],
): ResolvedSetup {
  const today = rows.find((row) => row.serviceDate === date);
  if (today) {
    return { setup: today.setup, state: today.state, source: "TODAY", setBy: today.setBy };
  }
  const lastChecked = rows.find((row) => row.serviceDate < date && row.state === "CHECKED");
  if (lastChecked) {
    return {
      setup: lastChecked.setup,
      // Carried forward, so it is a default for today however it was set yesterday: the van is
      // "Not checked" until the front desk confirms it again (§1.3's last row, conflict C5).
      state: "DEFAULT",
      source: "YESTERDAY",
      fromDate: lastChecked.serviceDate,
      setBy: lastChecked.setBy,
    };
  }
  const configured = vanConfigOf(vehicleKey);
  return {
    setup: configured?.defaultSetup ?? VANS[0].defaultSetup,
    state: "DEFAULT",
    source: "DEFAULT",
  };
}

/* ───────────────────────── the solver adapter (Auto-plan) ───────────────────────── */

/**
 * The chair footprint and securement the board plans with — the same on every chair and in every
 * wheelchair spot, which is how the deferred conflict C3 is expressed in the solver's vocabulary.
 *
 * The capacity solver matches a chair's securement to a spot's exactly and refuses a chair larger
 * than the spot (`chairFitsPosition`). Fit in v1 counts spots and nothing else, so Auto-plan hands
 * it one securement value for both sides and a footprint no chair exceeds: the two constraints are
 * then always satisfied and never decide a placement. §1.4 writes this as securement `ANY`; the
 * type has no such member, so it is one real value used on both sides, which is the same thing.
 */
const ANY_SECUREMENT: Securement = "OTHER";
const ANY_FOOTPRINT_CM = 999;

/**
 * §1.4's `setupToLayout(setup)`: one van's counts as the single synthetic seating plan the solver
 * searches — W wheelchair spots that take any chair, then the seats, the first `carSeats` of them
 * anchored, and a lift required exactly when there is a spot to board a chair into.
 *
 * Oxygen is not in here, because a layout has no notion of it. Auto-plan checks it separately
 * (src/domain/plan/board.ts), which is what §1.4 asks for.
 */
export function setupToLayout(vanId: string, setup: VanSetup): Layout {
  return {
    id: `${vanId}/setup`,
    // Never shown: the board names a van "Van 2" and never a layout code (§1.5).
    code: "setup",
    liftRequired: setup.wheelchairSpots > 0,
    positions: [
      ...Array.from({ length: setup.wheelchairSpots }, (_, i) => ({
        id: `${vanId}/wc${i + 1}`,
        kind: "WC" as const,
        securement: ANY_SECUREMENT,
        maxLengthCm: ANY_FOOTPRINT_CM,
        maxWidthCm: ANY_FOOTPRINT_CM,
      })),
      ...Array.from({ length: setup.seats }, (_, i) => ({
        id: `${vanId}/seat${i + 1}`,
        kind: "AMB" as const,
        tetherCapable: i < setup.carSeats,
      })),
    ],
  };
}

/** The van as the solver reads a vehicle: one generic van, one synthetic plan, no provider shown. */
export function setupToVehicle(vanId: string, setup: VanSetup): Vehicle {
  return {
    id: vanId,
    // `label` and `description` are the solver's own words for a vehicle and reach no screen on
    // this board: every van on it is named by copy (`planBoard.vanName`).
    label: vanId,
    description: vanId,
    providerId: vanId,
    providerName: vanId,
    liftEquipped: setup.hasLift,
    layouts: [setupToLayout(vanId, setup)],
  };
}
