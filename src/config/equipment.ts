/**
 * The equipment a van is counted in, and what one rider needs of it. One array, read by every
 * screen that shows a counter and by the one function that decides whether a child fits.
 *
 * SOURCE: redesign spec §0 "Equipment vocabulary" and §1.4 (the fit rule); founder's 2026-10-17
 * 2:38 PM ET direction ("vans are generic … adjust the number of equipment as a variable …
 * options set per van when they arrive") and the 2:59 PM ET approval of Oxygen as a counter on
 * every van.
 *
 * It is a configuration array and not four fields written out four times because the same list
 * drives five surfaces: the meters on a van column, the steppers in its setup popover, the
 * steppers on the ramp iPad, the columns of `ops.vehicle_setup_day`, and the fit rule itself
 * (src/domain/plan/fit.ts, which loops over this). Adding a fifth counter — a founder decision,
 * not an engineering one — is a row here, a column in a migration, and a word in copy.ts.
 *
 * Deliberately not in here: icons and labels. A lucide component and an English word belong to
 * the UI (src/ui/equipment.tsx reads this array and maps `key` to both), and the fit rule must
 * stay importable by a pure domain module with no React in its import graph.
 *
 * What a *chair* is secured with and how large it is are **not** counted (conflict C3, deferred
 * after the demo by the founder on 2026-10-17 2:59 PM ET), and neither is seating separation or
 * maximum ride time (C7, same ruling).
 */

/** The four things a child can need, as the board and the ramp read them off an approved profile. */
export type NeedFlags = {
  /** Rides in their own wheelchair. */
  wheelchair: boolean;
  /** Needs a car seat, a booster or a vest — one of the van's car seats either way. */
  carSeat: boolean;
  /** Travels with oxygen, so the van needs a mount for it. */
  oxygen: boolean;
  /** A nurse rides along, which is one more seat taken. */
  nurse: boolean;
};

/** Nobody needs anything. The starting point for a rider with no approved need items. */
export const NO_NEEDS: NeedFlags = { wheelchair: false, carSeat: false, oxygen: false, nurse: false };

/** The reason a van cannot take a child, in the words §1.5 gives each one. */
export const REJECT_REASONS = ["LIFT", "WHEELCHAIR", "OXYGEN", "CAR_SEAT", "SEAT"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** One counter: what it is called, where it is stored, and what one rider asks of it. */
export type EquipmentCounter = {
  /** The field on a van's setup, which is also the key copy and the UI icons are looked up by. */
  key: "seats" | "wheelchairSpots" | "carSeats" | "oxygenMounts";
  /** The `ops.vehicle_setup_day` column, so the store does not spell these out a second time. */
  column: "seats" | "wheelchair_spots" | "car_seats" | "oxygen_mounts";
  /** The refusal this counter running out produces. */
  reject: RejectReason;
  /** How much of this counter one rider with these needs takes. */
  demandOf: (needs: NeedFlags) => number;
};

/**
 * The four counters, in the order they are shown everywhere: Seats, Wheelchair, Car seats,
 * Oxygen (§0's table order, and the order of the steppers in the mockups).
 *
 * The refusal *order* is a different thing and lives in src/domain/plan/fit.ts, because the first
 * failing counter is the one the chip names and that is not the order a person reads them in.
 */
export const EQUIPMENT_COUNTERS: readonly EquipmentCounter[] = [
  {
    key: "seats",
    column: "seats",
    reject: "SEAT",
    // Every child who is not in their own chair sits in a seat; a nurse riding along takes one
    // more (§1.4: `seatsUsed = count(riders where !wheelchair) + count(riders where nurse)`).
    demandOf: (needs) => (needs.wheelchair ? 0 : 1) + (needs.nurse ? 1 : 0),
  },
  { key: "wheelchairSpots", column: "wheelchair_spots", reject: "WHEELCHAIR", demandOf: (n) => (n.wheelchair ? 1 : 0) },
  { key: "carSeats", column: "car_seats", reject: "CAR_SEAT", demandOf: (n) => (n.carSeat ? 1 : 0) },
  { key: "oxygenMounts", column: "oxygen_mounts", reject: "OXYGEN", demandOf: (n) => (n.oxygen ? 1 : 0) },
];

export type CounterKey = EquipmentCounter["key"];

/** The counter a key names. Throws rather than returning undefined: a bad key is a bug, not input. */
export function counterOf(key: CounterKey): EquipmentCounter {
  const counter = EQUIPMENT_COUNTERS.find((c) => c.key === key);
  if (!counter) throw new Error(`no equipment counter ${key}`);
  return counter;
}
