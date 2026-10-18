/**
 * THE THIRD PANE — what a coordinator needs beside the thread to decide (mockups/approvals.html
 * `aside.ctx`).
 *
 * Firia, 2026-10-17 10:51 PM ET: "For you at 1440 has THREE panes: the list; the thread with the
 * proposal card INLINE under the parent's message; the van / pick-up panel on the right (no ETA
 * pill; state chips instead)."
 *
 * Three facts, and every one of them is read rather than written here:
 *  - **which van, who is driving it, and what the ride is doing.** The van comes from the day's
 *    own source (`demoDaySource`) — the same one the board reads, so the van named here is the
 *    van on the board. What the ride is doing is a *state chip* and never an ETA: the mockup
 *    draws "On time", which is an estimate wearing a chip's clothes, and the ruling replaces it
 *    with the leg's own state from the one state vocabulary (`src/ui/states.ts` `legStates`) —
 *    a fact about the ride rather than a promise about a minute.
 *  - **the van after the change**, as counts against that van's own setup: seats, wheelchair,
 *    car seats, oxygen (§0's order). The "after" is the point — a coordinator is approving a
 *    ride that stays in this van, and the counts are what says it still fits.
 *  - **who may collect the child**, from the family's own file, which is the question the whole
 *    approval turns on.
 *
 * Pure and synchronous: it reads the demo day and the fixtures, holds no component, opens no
 * database and invents nothing. A thread with no proposal gets no pane — there is nothing to be
 * deciding about.
 */
import { Accessibility, Armchair, Baby, Wind } from "lucide-react";
import { EQUIPMENT_COUNTERS } from "@/config/equipment";
import type { ServiceDay } from "@/domain/board/day";
import type { DayRider, DayVan } from "@/domain/day/source";
import { demoDaySource } from "@/modules/demo/day-source";
import { FAMILIES, childByKey, childKeyOfToken, runOfChild, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { equipment, familyTexts } from "@/ui/copy";
import { legStates, type StateDescriptor } from "@/ui/states";
import { initialsOf } from "./conversations";

/** One of the van's four counts, after the change this card is asking about. */
export type CapacityCount = {
  readonly key: "seats" | "wheelchair" | "carSeats" | "oxygen";
  readonly label: string;
  readonly icon: StateDescriptor["icon"];
  readonly used: number;
  readonly total: number;
};

/** An adult on the family's file who may collect this child. */
export type PickupPerson = {
  readonly initials: string;
  readonly name: string;
  readonly relationship: string;
};

export type ThreadContext = {
  /** "Jonah W." — the pane's heading. A staff screen, so the child is named (COPY-GUIDE §1). */
  readonly childLabel: string;
  /** "Van 1 · Marcus L.", or null for a child the centre drives no van for this leg. */
  readonly vanLine: string | null;
  /** The van's colour token (§0 rule 6: a token, never a hex). */
  readonly vanColourToken: string | null;
  /** What the ride is doing, as a state chip. Never an ETA (Firia, 10:51 PM ET). */
  readonly rideState: StateDescriptor;
  /** "Van 1 after change" — the heading over the counts, or null with no van. */
  readonly afterHeading: string | null;
  readonly after: readonly CapacityCount[];
  readonly pickup: readonly PickupPerson[];
};

/** §0's four counters, in §0's order: the icon and the word each one is read as. */
const COUNTERS = [
  { key: "seats", counter: "seats", label: equipment.seats, icon: Armchair },
  { key: "wheelchair", counter: "wheelchairSpots", label: equipment.wheelchair, icon: Accessibility },
  { key: "carSeats", counter: "carSeats", label: equipment.carSeats, icon: Baby },
  { key: "oxygen", counter: "oxygenMounts", label: equipment.oxygen, icon: Wind },
] as const;

/**
 * The context for one thread's child, or null for a child this day does not have.
 *
 * The van is the run the fixtures give the child this afternoon. A child on no run gets the pane
 * without a van rather than an invented one: the heading and the pick-up list are still the facts
 * a coordinator needs, and a van nobody is driving them in is not.
 */
export async function contextFor(childKey: string, day: ServiceDay): Promise<ThreadContext | null> {
  const child = childByKey(childKey);
  if (!child) return null;

  // The day's own source, which is what the board reads: the van named here is the van there.
  const source = demoDaySource();
  const run = runOfChild(childKey);
  const vans = await source.vans(day.iso);
  const van = run ? vans.find((v) => v.id === vehicleIdOf(run.vehicleKey)) ?? null : null;
  const riders = await source.riders(day.iso, "PM");
  const aboard = run
    ? riders.filter((rider) => run.childKeys.includes(childKeyOfToken(rider.token) ?? ""))
    : [];

  return {
    childLabel: child.label,
    vanLine: van ? `${van.name} · ${van.driverName}` : null,
    vanColourToken: van ? van.colourToken : null,
    /*
     * The afternoon run is out: the leg's own state, from the one vocabulary every other screen
     * reads. Not "On time" — this pane says what the ride *is*, and the ETA is nowhere on this
     * screen at all (10:51 PM ET).
     */
    rideState: legStates.IN_TRANSIT,
    afterHeading: van ? `${van.name} ${familyTexts.afterChange}` : null,
    after: van ? counts(van, aboard) : [],
    pickup: pickupFor(child.familyKey),
  };
}

/**
 * The four counters, in §0's order, as used-against-total on this van's own setup.
 *
 * "Used" is the board's own arithmetic (`EQUIPMENT_COUNTERS[].demandOf`), not a count made up
 * here: a nurse riding along takes a seat, a child in their own chair does not, and this pane
 * must agree with the board about both or it is a second answer to "does it fit".
 */
function counts(van: DayVan, aboard: readonly DayRider[]): readonly CapacityCount[] {
  const setup = van.defaultSetup;
  return COUNTERS.map(({ key, counter, label, icon }) => {
    const rule = EQUIPMENT_COUNTERS.find((c) => c.key === counter)!;
    return {
      key,
      label,
      icon,
      used: aboard.reduce((n, rider) => n + rule.demandOf(rider.needs), 0),
      total: setup[counter],
    };
  });
}

/** The adults on this family's file, as the pane lists them. */
function pickupFor(familyKey: string): readonly PickupPerson[] {
  const family = FAMILIES.find((f) => f.key === familyKey);
  if (!family) return [];
  const name = `${family.guardian.firstName} ${family.guardian.lastInitial}.`;
  return [{ initials: initialsOf(name), name, relationship: family.guardian.relationship }];
}
