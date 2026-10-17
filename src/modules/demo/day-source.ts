/**
 * The synthetic day behind the one day-data port: the demo adapter, and the only module the
 * rebuilt screens' data passes through that reads a fixture at all.
 *
 * SOURCE: Firia's rule 5 (2026-10-17 5:48 PM ET) — fixtures sit **only** here — and Vera's
 * differences list, which found a board, a ramp and a live map each naming vans and children off
 * a fixture of their own. One roster (`src/modules/demo/fixtures/standard.ts`, the same one the
 * Today board reads), one fleet (`src/config/vans.ts`), one set of drivers
 * (`src/domain/plan/day.ts`), and every screen downstream of this file sees the same day.
 *
 * What it is not allowed to decide: capacity. The counts a van is planned on come from
 * `ops.vehicle_setup_day` or, for a van the front desk has not confirmed today, from the shared
 * config's defaults (Firia/Veri 6:00 PM ET, no carry-over) — resolved in src/domain/plan/setup.ts
 * and composed in src/modules/plan/store.ts.
 *
 * Pure: fixtures in, the day out. No clock, no database, no network.
 */
import { VANS, defaultSetupOf, vanColourToken, vanNameOf } from "@/config/vans";
import { plannedWindow, stopLabel } from "@/domain/board/scenario";
import type { DayDataSource, DayRider, DayVan, OtherChild } from "@/domain/day/source";
import type { Direction } from "@/domain/day/leg";
import { driverFor } from "@/domain/plan/day";
import { needsOf } from "@/domain/plan/needs";
import {
  CHILDREN,
  RUNS,
  childTokenOf,
  vehicleIdOf,
  type Child as DemoChild,
} from "@/modules/demo/fixtures/standard";

/**
 * The vans on the road today: the day's own runs, named and coloured from the shared config.
 *
 * The reserve van is in the config and is on no run (src/config/vans.ts), so it is not a column
 * on anybody's board — which is the difference between "the fleet" and "today".
 */
function dayVans(): DayVan[] {
  return VANS.filter((van) => RUNS.some((run) => run.vehicleKey === van.vehicleKey))
    .map((van) => ({
      id: vehicleIdOf(van.vehicleKey),
      slot: van.slot,
      name: vanNameOf(van.slot),
      colourToken: vanColourToken(van.slot),
      driverName: driverFor(van.vehicleKey),
      defaultSetup: defaultSetupOf(van.vehicleKey),
    }))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * The children this leg drives: a stop of their own, and a ride that is not the family's.
 *
 * A child whose leg is the family's own is not ours to plan — the census children arrive with
 * their family and have no stop — so they are not a rider. Putting them in a van would invent a
 * pickup the day does not have.
 */
function ridingChildren(leg: Direction): DemoChild[] {
  return CHILDREN.filter((child) => {
    const mode = leg === "AM" ? child.amMode : child.pmMode;
    return mode !== "FAMILY" && child.stopKey !== null;
  });
}

function toRider(child: DemoChild, leg: Direction): DayRider {
  const label = stopLabel(child);
  if (label === null) throw new Error(`child ${child.key} has no stop to plan`);
  return {
    token: childTokenOf(child.key),
    name: child.label,
    needs: needsOf(child),
    stopLabel: label,
    window: plannedWindow(child, leg),
  };
}

export function demoDaySource(): DayDataSource {
  return {
    vans() {
      return dayVans();
    },

    riders(_date, leg, absentTokens) {
      const absent = new Set(absentTokens);
      return ridingChildren(leg)
        .map((child) => toRider(child, leg))
        .filter((rider) => !absent.has(rider.token));
    },

    others(_date, leg, absentTokens) {
      const absent = new Set(absentTokens);
      const riding = new Set(
        ridingChildren(leg)
          .map((child) => childTokenOf(child.key))
          .filter((token) => !absent.has(token)),
      );
      return CHILDREN.map((child) => ({
        token: childTokenOf(child.key),
        name: child.label,
      }))
        .filter((child) => !riding.has(child.token))
        .map(
          (child): OtherChild => ({
            ...child,
            bucket: absent.has(child.token) ? "ABSENT" : "FAMILY_DRIVES",
          }),
        );
    },
  };
}
