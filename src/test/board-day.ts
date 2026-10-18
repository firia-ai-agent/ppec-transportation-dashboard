/**
 * One synthetic board day, for the tests that are about the board rather than about the store.
 *
 * Test-only, like the rest of src/test. It composes the two halves a real page composes — the
 * day-data port (src/modules/demo/day-source.ts) and the counts a van is planned on — without a
 * database, so a test can say "Van 3 has no lift today" in one line and ask the placement
 * function what that means.
 *
 * It reads the **one** roster and the **one** van list, the same two every screen reads (Firia's
 * rule 5), so a test cannot quietly assert about a fleet nobody ships.
 */
import { VANS, defaultSetupOf } from "@/config/vans";
import type { Direction } from "@/domain/day/leg";
import type { BoardDay, BoardPlan, BoardVan, Placement } from "@/domain/plan/board";
import { emptyPlan } from "@/domain/plan/board";
import type { VanSetup } from "@/domain/plan/fit";
import { demoDaySource } from "@/modules/demo/day-source";
import { childTokenOf, RUNS, vehicleIdOf } from "@/modules/demo/fixtures/standard";

/** The date the board tests talk about. Any ISO date does; the roster is the same on all of them. */
export const TEST_DATE = "2026-10-17";

/**
 * The day, with each van on its configured defaults unless a test says otherwise.
 *
 * `setups` is keyed by **slot**, which is how a person refers to a van ("Van 3"), so a test that
 * lowers Van 3's wheelchair spots does not have to know a vehicle id.
 */
export async function testDay(
  direction: Direction = "PM",
  setups: Readonly<Record<number, Partial<VanSetup>>> = {},
): Promise<BoardDay> {
  const source = demoDaySource();
  const vans: BoardVan[] = (await source.vans(TEST_DATE)).map((van) => {
    const override = setups[van.slot];
    const setup = { ...van.defaultSetup, ...(override ?? {}) };
    return {
      ...van,
      setup,
      // A test that names counts has "confirmed" them, the way the ramp does; one that does not
      // is reading the config's defaults, which is what an unconfirmed van is planned on.
      setupState: override ? "CHECKED" : "DEFAULT",
      setupSource: override ? "CHECKED" : "DEFAULT",
      setupBy: override ? "Ana P." : null,
    };
  });
  return {
    date: TEST_DATE,
    direction,
    vans,
    riders: await source.riders(TEST_DATE, direction),
    others: await source.others(TEST_DATE, direction),
  };
}

/** The van with this slot, by id. */
export function vanIdOfSlot(slot: number): string {
  const van = VANS.find((candidate) => candidate.slot === slot);
  if (!van) throw new Error(`no van in slot ${slot}`);
  return vehicleIdOf(van.vehicleKey);
}

/** What a van carries by default, for a test that asserts about the DEFAULT rung. */
export function defaultsOfSlot(slot: number): VanSetup {
  const van = VANS.find((candidate) => candidate.slot === slot);
  if (!van) throw new Error(`no van in slot ${slot}`);
  return defaultSetupOf(van.vehicleKey);
}

/**
 * Each of the day's own runs in its own van — the assignment the fixtures describe.
 *
 * Used where *stable geometry* matters (the map's surveyed roads are exactly these kerb pairs,
 * ADR-007) and not as a claim about capacity: whether a van fits its riders is the placement
 * function's answer and is asserted where that is the question.
 */
export function scenarioPlan(day: BoardDay): BoardPlan {
  const plan: Record<string, Placement> = { ...emptyPlan(day) };
  for (const run of RUNS) {
    const vanId = vehicleIdOf(run.vehicleKey);
    if (!day.vans.some((van) => van.id === vanId)) continue;
    for (const childKey of run.childKeys) {
      const token = childTokenOf(childKey);
      if (!(token in plan)) continue;
      if (!day.riders.some((rider) => rider.token === token)) continue;
      plan[token] = { bucket: "VAN", vanId, pinned: false };
    }
  }
  return plan;
}
