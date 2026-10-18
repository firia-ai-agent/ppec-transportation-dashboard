/**
 * The fleet, once: which vans exist, what each is called, which colour it wears on a map or a
 * board, and the counts to plan it on when nobody has counted it today.
 *
 * SOURCE: redesign spec §6.1 ("one generic van"), §1.6 (the `default_*` numbers), §6.6 (route
 * colours), the founder's 2026-10-17 2:38 PM ET direction that vans are generic and the
 * equipment is a number, and Firia/Veri's 6:00 PM ET ruling that an unconfirmed van is planned on
 * **these** defaults — there is no carry-over from any earlier day.
 *
 * Why one file. Vera's differences list found "Van 3" meaning two different vehicles: the board called the
 * sedan Van 3 while the live map drew a V3 of its own, because the fleet was written down in
 * three fixtures (src/fixtures/fleet.ts, src/fixtures/map.ts, src/modules/demo/fixtures/standard.ts)
 * and once more in a config. This is the single list: a slot, a name, a colour and a default
 * setup per vehicle, for every screen that names a van. The slot is stable — the sedan is Van 3
 * and the reserve is Van 4 — so two screens naming the same vehicle say the same word.
 *
 * Which of them are on the road on a given day is **not** here: that is the day's own runs, read
 * through the day data source (src/domain/day/source.ts). A config does not know who is driving.
 *
 * Pure data and one name helper: no clock, no database, no React.
 */
import { fill, planBoard } from "@/ui/copy";
import type { VanSetup } from "@/domain/plan/fit";

/** One van: the vehicle it is, the number it wears, and what it carries by default. */
export type VanConfig = {
  /** The vehicle in the demo fixtures. Never shown: the screen says "Van 1" (§1.5). */
  vehicleKey: string;
  /** 1-based, and both the number in the van's name and its colour slot. */
  slot: number;
  /**
   * Is this van on the road on an ordinary day?
   *
   * The reserve is not: it is in the fleet because the live map draws it parked and the
   * substitution path names it, and it is not a column on anybody's board. Both day sources
   * read this, so "which vans are out" is one answer and not one per implementation.
   */
  onRoadToday: boolean;
  /** What this van has on board until the front desk counts it (§1.6's last rung). */
  defaultSetup: VanSetup;
};

/**
 * The four vans of the synthetic centre, in slot order.
 *
 * Slots 1–3 are the three that run the day (src/modules/demo/fixtures/standard.ts `RUNS`:
 * V1, V2 and the sedan V4); slot 4 is the reserve, which is on no run and which the live map
 * draws parked. The numbers are synthetic and chosen so the demo day has a story: Van 1 and Van 2
 * can each take a chair, **Van 3 cannot and has no lift** — that is the drag the board has to
 * refuse (§1.7 #1) and the van the ramp's "won't fit" line is about.
 */
export const VANS: readonly VanConfig[] = [
  {
    vehicleKey: "V1",
    slot: 1,
    onRoadToday: true,
    defaultSetup: { seats: 6, wheelchairSpots: 1, carSeats: 3, oxygenMounts: 1, hasLift: true },
  },
  {
    vehicleKey: "V2",
    slot: 2,
    onRoadToday: true,
    defaultSetup: { seats: 5, wheelchairSpots: 2, carSeats: 2, oxygenMounts: 1, hasLift: true },
  },
  {
    vehicleKey: "V4",
    slot: 3,
    onRoadToday: true,
    defaultSetup: { seats: 4, wheelchairSpots: 0, carSeats: 2, oxygenMounts: 1, hasLift: false },
  },
  {
    // The reserve. On no run in the synthetic day, so it is not a board column; it is in the list
    // because the live map draws it and must call it by the same name this file gives it.
    vehicleKey: "V3",
    slot: 4,
    onRoadToday: false,
    defaultSetup: { seats: 2, wheelchairSpots: 1, carSeats: 1, oxygenMounts: 0, hasLift: true },
  },
];

/** How far a counter can be pushed. A van with 13 seats is a typo, not a van. */
export const COUNTER_MAX = 12;

/**
 * "Van 2" — the one name a van has anywhere in this app.
 *
 * The **only** van-name helper: `copy.ts`'s old `vanName(description)` ("the convertible van")
 * named a vehicle by its fixture description and is gone with the screens that printed it, so a
 * van is named by its slot and nothing else (Firia's rule 6).
 */
export function vanNameOf(slot: number): string {
  return fill(planBoard.vanName, { n: slot });
}

/**
 * The design token this van's colour comes from, as a CSS custom-property name.
 *
 * The three the map already draws with (src/ui/tokens.ts, the frame's palette since #71): the
 * brand teal, the amber `map-route-2` and the vermillion `map-route-3`. There is no blue left in
 * the app, so Van 1 is the brand colour rather than the mockup's blue. The reserve has no
 * route colour of its own — a fourth would need a fourth contrast row, which is a design
 * decision and not this file's — so it borrows the muted ink.
 *
 * No hex is written here: every colour in src/ is a token (the no-hex test holds that).
 */
export function vanColourToken(slot: number): string {
  return slot === 1 ? "brand" : slot === 2 ? "map-route-2" : slot === 3 ? "map-route-3" : "ink-muted";
}

/** The vans on the road on an ordinary day, in slot order: the board's three columns. */
export const DAY_VANS: readonly VanConfig[] = VANS.filter((van) => van.onRoadToday);

/** The config for a vehicle key, or `null` for a vehicle this centre does not have. */
export function vanConfigOf(vehicleKey: string): VanConfig | null {
  return VANS.find((van) => van.vehicleKey === vehicleKey) ?? null;
}

/** The default counts for a vehicle key — the one answer to "what does it carry when nobody looked". */
export function defaultSetupOf(vehicleKey: string): VanSetup {
  const config = vanConfigOf(vehicleKey);
  if (!config) throw new Error(`no van config for ${vehicleKey}`);
  return config.defaultSetup;
}
