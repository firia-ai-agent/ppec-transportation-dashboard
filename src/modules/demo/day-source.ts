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
import { demoDay } from "@/domain/board/day";
import { plannedStops, plannedWindow, stopLabel } from "@/domain/board/scenario";
import type { DayDataSource, DayRider, DayVan, OtherChild } from "@/domain/day/source";
import type { Direction } from "@/domain/day/leg";
import { driverFor } from "@/domain/plan/day";
import type { NeedFlags } from "@/config/equipment";
import { needsFromCategories } from "@/domain/plan/needs";
import { demoNeedsOverride } from "./needs-store";
import {
  CHILDREN,
  RUNS,
  childTokenOf,
  vehicleIdOf,
  type Child as DemoChild,
} from "@/modules/demo/fixtures/standard";

/**
 * One fixture child's flags, from their **approved** need items only — the same rule the SQL
 * source applies to the same rows (DECISION-LEDGER row 1: approved needs only).
 *
 * A Save on the board's child panel is kept in memory on a server with no database
 * (src/modules/demo/needs-store.ts) and wins over the fixture for the three the panel owns, so
 * the browser check can walk the whole story: turn Oxygen on, Save, watch the van's meter move.
 * With a database the panel writes rows and this override is refused outright.
 */
export function needsOfDemoChild(child: DemoChild): NeedFlags {
  const approved = needsFromCategories(
    child.needs.filter((need) => need.state === "APPROVED").map((need) => need.category),
  );
  const saved = demoNeedsOverride(childTokenOf(child.key));
  return saved ? { ...approved, ...saved } : approved;
}

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
    needs: needsOfDemoChild(child),
    stopLabel: label,
    window: plannedWindow(child, leg),
  };
}

export function demoDaySource(): DayDataSource {
  return {
    async vans() {
      return dayVans();
    },

    /**
     * The instant this van's run leaves the centre, from the committed survey's own geometry
     * (src/domain/board/scenario.ts `plannedStops`) — the same place every other screen reads a
     * planned time from, so the ramp's clock and the board's cannot disagree.
     *
     * An afternoon run starts at the centre, so its first stop *is* the departure (PRD §8); a
     * morning run ends there, so the last stop is. A van with no run today leaves when the day
     * starts, which is the honest answer for a vehicle nobody scheduled.
     */
    leavesAtMs(_date, leg, vanId) {
      const serviceDay = demoDay();
      const run = RUNS.find((candidate) => vehicleIdOf(candidate.vehicleKey) === vanId);
      if (!run) return serviceDay.instantMs;
      const stops = plannedStops(run, leg, serviceDay);
      const stop = leg === "PM" ? stops[0] : stops[stops.length - 1];
      return stop?.etaMs ?? serviceDay.instantMs;
    },

    async riders(_date, leg) {
      return ridingChildren(leg).map((child) => toRider(child, leg));
    },

    async others(_date, leg) {
      const riding = new Set(ridingChildren(leg).map((child) => childTokenOf(child.key)));
      return CHILDREN.filter((child) => !riding.has(childTokenOf(child.key))).map(
        (child): OtherChild => ({
          token: childTokenOf(child.key),
          name: child.label,
          // The bucket a child *starts* in. Being away is a placement on the plan, not a fact
          // about the roster (founder 7:17 PM ET), so nothing here is ever ABSENT.
          bucket: "FAMILY_DRIVES",
        }),
      );
    },
  };
}
