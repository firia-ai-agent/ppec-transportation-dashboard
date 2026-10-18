/**
 * The fleet, once: which vans exist, what each is called, which colour it wears on a map or a
 * board, and the counts to plan it on when nobody has counted it today.
 *
 * SOURCE: redesign spec §6.1 ("one generic van"), §1.6 (the `default_*` numbers), §6.6 (route
 * colours), the founder's 2026-10-17 2:38 PM ET direction that vans are generic and the
 * equipment is a number, and Firia/Veri's 6:00 PM ET ruling that an unconfirmed van is planned on
 * **these** defaults — there is no carry-over from any earlier day.
 *
 * Why one file. Vera's differences list found "Van 3" meaning two different vehicles: the board
 * called the sedan Van 3 while the live map drew a V3 of its own, because the fleet was written
 * down in three fixtures (src/fixtures/fleet.ts, src/fixtures/map.ts,
 * src/modules/demo/fixtures/standard.ts) and once more in a config. This is the single list: a
 * slot, a name, a colour and a default setup per vehicle, for every screen that names a van.
 * Slot N is vehicle V<N>, so two screens naming the same vehicle say the same word.
 *
 * Which of them are on the road on a given day is **not** here: that is the day's own runs, read
 * through the day data source (src/domain/day/source.ts). A config does not know who is driving.
 *
 * Pure data and one name helper: no clock, no database, no React.
 */
import { fill, planBoard } from "@/ui/copy";
import { VAN_COLORS } from "@/ui/tokens";
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
   * All three are, and there is no fourth (Firia's 8:02 PM ET seed ruling): the centre runs
   * three vans and the board has three columns. The flag stays because both day sources read
   * it, so "which vans are out" is one answer and not one per implementation.
   */
  onRoadToday: boolean;
  /** What this van has on board until the front desk counts it (§1.6's last rung). */
  defaultSetup: VanSetup;
};

/**
 * What a van carries when nobody has counted it today — **the same answer for every van**.
 *
 * Vera/Athena/Veri with Firia's sign-off, 2026-10-18 12:13 AM ET: the three vans are one
 * generic type (§6.1, "one generic van"), so there is no van that is weaker by construction and
 * no sedan, convertible, centre van or substitute anywhere. A van that cannot take a chair today
 * is a van whose one wheelchair spot is already **used** — a counted fact that the ramp can
 * change and the board explains — and that is what the "won't fit" refusal is made of.
 *
 * **These are the numbers, and they are Firia's** (ruling of 2026-10-18 8:49 AM ET): six seats,
 * one wheelchair space, three car seats, one oxygen mount, and a lift. They are what §1.6 writes
 * down and what the board has always planned an uncounted van on.
 *
 * The commit before this one had cut them to `3 / 1 / 2 / 1` to match the seeded seating layout
 * `1WC/3A` in src/modules/demo/fixtures/standard.ts, on the reading that a default should name a
 * configuration some seeded van is fitted as. Firia overruled it: a *fixture's* seating plan does
 * not set the fleet's default, and the counters are independent — a chair space is not one of the
 * seats — so an uncounted van is planned on the full six. A van that really has fewer places
 * today is a van somebody counted at the ramp, which is exactly what the iPad is for.
 *
 * The S1 this all came out of was never about the size of the default: it was two screens reading
 * two different capacities for one van. Both read this one now (src/domain/plan/setup.ts
 * `resolveSetups`), and neither reads a seating layout for capacity.
 */
const GENERIC_VAN: VanSetup = {
  seats: 6,
  wheelchairSpots: 1,
  carSeats: 3,
  oxygenMounts: 1,
  hasLift: true,
};

/**
 * The three vans of the synthetic centre, in slot order: slot N is vehicle V<N>, and each one
 * runs the day (src/modules/demo/fixtures/standard.ts `RUNS`). There is no fourth vehicle in
 * the fleet, the seed, the config or the map (Firia's 8:02 PM ET seed ruling).
 */
export const VANS: readonly VanConfig[] = [
  { vehicleKey: "V1", slot: 1, onRoadToday: true, defaultSetup: GENERIC_VAN },
  { vehicleKey: "V2", slot: 2, onRoadToday: true, defaultSetup: GENERIC_VAN },
  { vehicleKey: "V3", slot: 3, onRoadToday: true, defaultSetup: GENERIC_VAN },
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
 * `VAN_COLORS` in src/ui/tokens.ts is the one place the three are written (Firia's ruling,
 * 2026-10-17 11:25 PM ET): blue, amber, magenta, one per van, emitted as `--van-1/2/3` (read through `vanColourVar`).
 * The board's columns, the ramp's van chip and the live map's lines all read this, so a van is
 * the same colour wherever it is drawn.
 *
 * No hex is written here: every colour in src/ is a token (the no-hex test holds that).
 */
export function vanColourToken(slot: number): string {
  const key = `van${slot}`;
  return key in VAN_COLORS ? key : "ink-muted";
}

/**
 * The CSS colour for a van's token. tokens.ts emits the van palette as `--van-1/2/3` (not
 * `--color-van1`), so a `vanN` token maps to `var(--van-N)`; any other token is a chrome colour.
 */
export function vanColourVar(token: string): string {
  const match = /^van(\d+)$/.exec(token);
  return match ? `var(--van-${match[1]})` : `var(--color-${token})`;
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
