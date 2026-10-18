import { beforeEach, describe, expect, it } from "vitest";
import { VANS, defaultSetupOf, vanNameOf } from "@/config/vans";
import { buildBoard, demoDay, type Board } from "@/domain/board/board";
import { autoPlan, ridersInVan, type BoardVan } from "@/domain/plan/board";
import { eligibility } from "@/domain/plan/eligibility";
import { isOver, usedBy } from "@/domain/plan/fit";
import { dropOutcome } from "@/app/plan-routes/board/drop";
import { rejectCardLine } from "@/app/plan-routes/board/lines";
import { demoDaySource } from "@/modules/demo/day-source";
import {
  DEMO_SITE_ID,
  VEHICLES,
  childTokenOf,
  vehicleIdOf,
} from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { applyPendingMoves } from "@/modules/plan/place";
import { loadBoard, savedPlacementsForBoard, savedSetupsForBoard } from "@/modules/plan/store";
import { planBoard } from "@/ui/copy";

/**
 * ONE VAN SETUP, TWO SCREENS — Firia's S1 of 2026-10-18.
 *
 * THE REPORT. The board let a coordinator put **six children and a wheelchair** in a van, while
 * Today — asked about the same van on the same day — was checking it against the seeded seating
 * layout `1WC/3A`: one chair space and three seats. Two capacity sources:
 *
 *  - the board's: `van.setup`, which is today's `CHECKED` row for that van or the shared config's
 *    default (src/domain/plan/setup.ts `resolveSetup`, src/config/vans.ts `defaultSetupOf`);
 *  - Today's: the fixtures' own `layouts`, pinned to the run's `layoutCode`
 *    (src/modules/demo/fixtures/standard.ts, read through src/domain/board/scenario.ts
 *    `solverLeg` into the seat-level solver).
 *
 * THE FIX, which is what this file holds: one shared resolution
 * (src/domain/plan/setup.ts `resolveSetups` / `setupFor`), read by the board through `loadBoard`
 * and by Today through `savedSetupsForBoard` into `buildBoard`, and one arithmetic over it
 * (src/domain/plan/fit.ts). **Neither screen reads a layout for capacity**, and the default is
 * one definition: the configuration every seeded van is actually fitted as.
 *
 * It runs on the memory store and the synthetic day — the store a server with no `DATABASE_URL`
 * gets — so no van has been counted and both screens are on the defaults, which is the case the
 * report is about. The rows half of the same story is on PGlite with the real migrations
 * (./saved-plan.db.test.ts, "one stored setup, two screens").
 */

const SITE = DEMO_SITE_ID;
const DATE = "2026-10-18";
const NOW = new Date("2026-10-18T11:30:00.000Z");

const store = () => memoryPlanStore({});
const source = () => demoDaySource();
const token = (childKey: string) => childTokenOf(childKey);
const vanIdOf = (vehicleKey: string) => vehicleIdOf(vehicleKey);

/** The board as the Plan routes page loads it: nobody has counted a van, so every van is default. */
const board = () => loadBoard(store(), SITE, DATE, "AM", source());

/** Today, built the way its page builds it: the saved plan **and** the stored setups. */
async function todayBoard(): Promise<Board> {
  const [saved, setups] = await Promise.all([
    savedPlacementsForBoard(SITE, DATE, store(), source()),
    savedSetupsForBoard(SITE, DATE, store(), source()),
  ]);
  return buildBoard(demoDay(), saved, setups);
}

/** Every test states its own day: the memory store is one process's, and it is shared. */
beforeEach(() => {
  clearMemoryPlanStore();
});

const morningLegs = (today: Board) => today.legs.filter((leg) => leg.ride.direction === "AM");
const misfits = (today: Board): string[] =>
  morningLegs(today)
    .filter((leg) => leg.needsActionReasons.includes("DOES_NOT_FIT"))
    .map((leg) => leg.child.childKey);

/* ─────────────────── the default, against the van it describes ─────────────────── */

/**
 * THE FOUNDER'S COMPLAINT, AS ARITHMETIC: "6 seats plus a wheelchair is more than the seeded van
 * holds". The counters are independent — a chair space is not one of the seats — so the default
 * has to name one configuration of a real van, and this is the test that it does. It reads the
 * fixtures deliberately, which is the one place a layout may still be read: to check the number
 * a screen plans on against the van somebody built.
 */
describe("the default setup is a configuration the seeded van has", () => {
  it("fits inside one of that vehicle's own layouts, counter by counter", () => {
    for (const van of VANS) {
      const vehicle = VEHICLES.find((v) => v.key === van.vehicleKey);
      if (!vehicle) throw new Error(`no seeded vehicle ${van.vehicleKey}`);
      const setup = defaultSetupOf(van.vehicleKey);
      const holds = vehicle.layouts.some((layout) => {
        const chairs = layout.positions.filter((p) => p.kind === "WC").length;
        const seats = layout.positions.filter((p) => p.kind === "AMB").length;
        const tethered = layout.positions.filter((p) => p.kind === "AMB" && p.tetherCapable).length;
        return (
          chairs >= setup.wheelchairSpots &&
          seats >= setup.seats &&
          tethered >= setup.carSeats &&
          (!setup.hasLift || vehicle.liftEquipped)
        );
      });
      expect(holds, `${van.vehicleKey}: ${JSON.stringify(setup)} is a layout this van has`).toBe(
        true,
      );
    }
  });

  it("is one definition, shared by all three vans", () => {
    const setups = VANS.map((van) => JSON.stringify(defaultSetupOf(van.vehicleKey)));
    expect(new Set(setups).size, "one generic van (§6.1)").toBe(1);
  });
});

/* ───────────────────────── (a) the board refuses, Today agrees ───────────────────────── */

describe("an unchecked van is as full as its default says", () => {
  /**
   * (a) THE REFUSED DROP, at the default counts. Auto-plan fills Van 1 to its seats on a day
   * nobody has counted; a fourth child let go on it is refused, the card does not move, and the
   * one coral line names the van and the thing that has run out (§1.3, Vera's taste spec).
   *
   * Before the fix the default was six seats, so this drop landed — and Today, reading `1WC/3A`,
   * reported the four riders it had just been handed as not fitting.
   */
  it("refuses the drop that would overfill it, with the coral reason line", async () => {
    const view = await board();
    const planned = autoPlan(view.day, view.plan);
    const vanOne = view.day.vans.find((van) => van.id === vanIdOf("V1")) as BoardVan;

    // Full on seats, and full means equal to the counts the column is showing — not more.
    const aboard = ridersInVan(view.day, planned, vanOne.id);
    expect(usedBy(aboard).seats, "Van 1 is at its default seats").toBe(vanOne.setup.seats);
    expect(isOver(vanOne.setup, aboard), "and not over them").toBe(false);

    // Ivy H. needs a seat and nothing else, and there is no seat left.
    const outcome = dropOutcome(view.day, planned, token("C8"), "VAN", vanOne.id);
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.reason).toBe("SEAT");
    expect(outcome.line).toBe(rejectCardLine(vanNameOf(vanOne.slot), "SEAT"));
    expect(outcome.line).toBe(planBoard.rejectCard.SEAT.replace("{van}", vanNameOf(vanOne.slot)));
    // And the same answer from the one function the drag, Auto-plan and the save all ask.
    expect(eligibility(view.day, planned, token("C8"), vanOne.id)).toEqual({
      ok: false,
      reason: "SEAT",
    });
  });

  /**
   * (a) AND THE OTHER HALF: a plan the board allowed is a plan Today has nothing to warn about.
   * Auto-plan's own morning for the seeded day is saved through the real writer, read back
   * through the one read path, and every one of the nine rides comes back fitting.
   */
  it("Today warns about no ride in the plan the board saved", async () => {
    const view = await board();
    const planned = autoPlan(view.day, view.plan);
    const written = await applyPendingMoves(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "AM",
        moves: Object.entries(planned)
          .filter(([, placement]) => placement.bucket === "VAN" && placement.vanId !== null)
          .map(([childToken, placement]) => ({
            childToken,
            bucket: "VAN" as const,
            vanId: placement.vanId,
          })),
        expectedVersion: view.version,
        actor: null,
        now: NOW,
      },
      store(),
      source(),
    );
    expect(written.ok, "reason" in written ? written.reason : "saved").toBe(true);

    // The demo plan is still feasible: nine riders in vans, and Zoe B. on Van 1.
    const saved = await savedPlacementsForBoard(SITE, DATE, store(), source());
    const inVans = Object.values(saved.AM ?? {}).filter((spot) => spot.bucket === "VAN");
    expect(inVans, "all nine riders are in a van").toHaveLength(9);
    expect(saved.AM?.C6, "Zoe B. is on Van 1").toEqual({ bucket: "VAN", vehicleKey: "V1" });

    const today = await todayBoard();
    expect(misfits(today), "nobody is asked to move to a van that fits").toEqual([]);
    const placed = morningLegs(today).filter((leg) => leg.ride.vanNumber !== null);
    expect(placed).toHaveLength(9);
    for (const leg of placed) {
      expect(leg.ride.solver, `${leg.child.childKey} fits the van the board put them on`).toBe(
        "FEASIBLE",
      );
      expect(leg.nextStep, leg.child.childKey).not.toBe("MOVE_TO_FITTING_VAN");
    }

    // Said the other way round, which is the property the two screens are one source for: no van
    // of the board's own day is over the counts it is planned on.
    const after = await board();
    for (const van of after.day.vans) {
      expect(
        isOver(van.setup, ridersInVan(after.day, after.plan, van.id)),
        `${van.name} holds its saved riders`,
      ).toBe(false);
    }
  });

  /**
   * (d) A FAMILY DRIVES CHILD IS ASKED THE SAME QUESTION. Ana S. has no kerb of ours this leg and
   * a coordinator may still put her in a van (Firia, 2026-10-18) — so she is refused by the same
   * counter, with the same reason and the same line as a rider.
   */
  it("refuses a Family drives card onto a full van with the same reason", async () => {
    const view = await board();
    const planned = autoPlan(view.day, view.plan);
    const vanOne = view.day.vans.find((van) => van.id === vanIdOf("V1")) as BoardVan;
    const ana = view.day.others.find((other) => other.token === token("C10"));
    expect(ana?.bucket, "Ana S. is in the Family drives lane").toBe("FAMILY_DRIVES");

    const outcome = dropOutcome(view.day, planned, token("C10"), "VAN", vanOne.id);
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.reason).toBe("SEAT");
    expect(outcome.line).toBe(rejectCardLine(vanNameOf(vanOne.slot), "SEAT"));
    expect(eligibility(view.day, planned, token("C10"), vanOne.id)).toEqual({
      ok: false,
      reason: "SEAT",
    });

    // The refusal is about the load and not about the lane: the same card on a van with a seat
    // left lands, so nothing here is refusing her for being a Family drives child.
    const roomy = view.day.vans.find(
      (van) => usedBy(ridersInVan(view.day, view.plan, van.id)).seats < van.setup.seats,
    ) as BoardVan;
    expect(dropOutcome(view.day, view.plan, token("C10"), "VAN", roomy.id).kind).toBe("MOVE");
  });
});
