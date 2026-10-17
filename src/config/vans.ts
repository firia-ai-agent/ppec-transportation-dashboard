/**
 * The fleet the plan board plans with: which vans are on the road, what each is called, which
 * route colour it wears, and the setup to fall back on when nobody has ever counted it.
 *
 * SOURCE: redesign spec §1.6 ("Default rule" and the `default_*` columns), §6.1 ("one generic
 * van"), §6.6 (route colours), §8 ("seed 3 generic vans with setups"), and the founder's
 * 2026-10-17 2:38 PM ET direction that vans are generic and the equipment is a number.
 *
 * Why these numbers are here and not in a database column: §1.6 sketched five `default_*`
 * columns on `ops.vehicle`, and the approval that came back was **new tables only** — so
 * migration 0009 adds no column to `ops.vehicle`, and the last rung of the default ladder is
 * configuration instead. The ladder itself (today's row → the most recent `CHECKED` row → this)
 * is written once, in src/domain/plan/setup.ts.
 *
 * The three vans are the day's own runs (src/modules/demo/fixtures/standard.ts `RUNS`, through
 * src/domain/plan/day.ts), so the board, the Today board and the ramp iPad name the same vans.
 * The numbers are synthetic, chosen so the demo day has a story to tell: Van 1 and Van 2 can
 * each take a chair, Van 3 cannot and has no lift, which is the drag that has to be refused
 * (§1.7 #1), and raising its Wheelchair to 1 with the lift on is the drag that then succeeds
 * (§1.7 #2). Everyone on the day fits across the three.
 *
 * Pure data: no clock, no database, no imports but the setup's own type.
 */
import type { VanSetup } from "@/domain/plan/fit";

/** One van on the road: the fixture fleet it comes from, and the fallback setup for it. */
export type VanConfig = {
  /** The vehicle in the demo fixtures this van is. Never shown: the screen says "Van 1". */
  vehicleKey: string;
  /**
   * 1-based, and it is both the number in the van's name ("Van 2") and its route colour slot.
   * Three vans, three colours — the existing route palette in src/ui/tokens.ts (`brand`,
   * `map-route-2`, `map-route-3`), which is the colour-vision-safe trio the map already draws
   * with, so no new colour is added for the board.
   */
  slot: 1 | 2 | 3;
  /** What this van has on board when nothing has ever been counted for it (§1.6's last rung). */
  defaultSetup: VanSetup;
};

export const VANS: readonly VanConfig[] = [
  {
    vehicleKey: "V1",
    slot: 1,
    defaultSetup: { seats: 6, wheelchairSpots: 1, carSeats: 2, oxygenMounts: 1, hasLift: true },
  },
  {
    vehicleKey: "V2",
    slot: 2,
    defaultSetup: { seats: 5, wheelchairSpots: 1, carSeats: 2, oxygenMounts: 1, hasLift: true },
  },
  {
    // The small van: no wheelchair spot and no lift, which is what makes §1.7's refused drag a
    // real refusal rather than a van that happens to be full.
    vehicleKey: "V4",
    slot: 3,
    defaultSetup: { seats: 3, wheelchairSpots: 0, carSeats: 1, oxygenMounts: 0, hasLift: false },
  },
];

/** How far a stepper can be pushed. A van with 12 seats is a typo, not a van. */
export const COUNTER_MAX = 12;

/** The van config for a fixture vehicle key, or `null` for a van that is not on the board. */
export function vanConfigOf(vehicleKey: string): VanConfig | null {
  return VANS.find((van) => van.vehicleKey === vehicleKey) ?? null;
}
