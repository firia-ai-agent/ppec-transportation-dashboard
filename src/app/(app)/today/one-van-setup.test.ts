import { beforeEach, describe, expect, it } from "vitest";
import { VANS, defaultSetupOf, vanConfigOf, vanNameOf } from "@/config/vans";
import { buildBoard, demoDay, type Board } from "@/domain/board/board";
import {
  autoPlan,
  checkPlan,
  moveTo,
  ridersInVan,
  type BoardPlan,
  type BoardVan,
} from "@/domain/plan/board";
import { eligibility } from "@/domain/plan/eligibility";
import { isOver, usedBy } from "@/domain/plan/fit";
import { dropOutcome } from "@/app/plan-routes/board/drop";
import { rejectCardLine } from "@/app/plan-routes/board/lines";
import { demoDaySource } from "@/modules/demo/day-source";
import { DEMO_SITE_ID, childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { applyPendingMoves } from "@/modules/plan/place";
import { loadBoard, savedPlacementsForBoard, savedSetupsForBoard } from "@/modules/plan/store";
import { MOVED_CHILD, MOVED_TO, REFERENCE_MORNING } from "@/test/reference-plan";
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
 * one definition, which is Firia's: 6 seats, 1 chair, 3 car seats, 1 oxygen mount, with a lift
 * (ruling of 2026-10-18 8:49 AM ET).
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

/** One leg of a plan, saved the way the board's Save writes it: every placement, one version. */
async function save(direction: "AM" | "PM", planned: BoardPlan, version: number): Promise<void> {
  const written = await applyPendingMoves(
    {
      siteId: SITE,
      serviceDate: DATE,
      direction,
      moves: Object.entries(planned)
        .filter(([, placement]) => placement.bucket === "VAN" && placement.vanId !== null)
        .map(([childToken, placement]) => ({
          childToken,
          bucket: "VAN" as const,
          vanId: placement.vanId,
        })),
      expectedVersion: version,
      actor: null,
      now: NOW,
    },
    store(),
    source(),
  );
  expect(written.ok, "reason" in written ? written.reason : "saved").toBe(true);
}

/** Every test states its own day: the memory store is one process's, and it is shared. */
beforeEach(() => {
  clearMemoryPlanStore();
});

const legsOf = (today: Board, direction: "AM" | "PM") =>
  today.legs.filter((leg) => leg.ride.direction === direction);
const morningLegs = (today: Board) => legsOf(today, "AM");
const misfitsOf = (today: Board, direction: "AM" | "PM"): string[] =>
  legsOf(today, direction)
    .filter((leg) => leg.needsActionReasons.includes("DOES_NOT_FIT"))
    .map((leg) => leg.child.childKey);
const misfits = (today: Board): string[] => misfitsOf(today, "AM");

/* ─────────────────── the default, against the van it describes ─────────────────── */

/**
 * THE DEFAULT IS FIRIA'S NUMBER, written down where a reader of this file will look for it.
 *
 * The commit that first fixed the S1 had cut the default to `3 / 1 / 2 / 1` so that it named a
 * configuration some seeded van is fitted as (`1WC/3A` in src/modules/demo/fixtures/standard.ts),
 * and this block held that property. Firia overruled it at 8:49 AM ET on 2026-10-18: a fixture's
 * seating plan does not set the fleet's default, and an uncounted van is planned on the full six
 * seats. So the test is the ruling itself — the four counters and the lift, per van — and the
 * S1 it came out of is the *one source* below, which is a different property and still holds.
 */
describe("the default setup is the one Firia ruled", () => {
  /** 6 seats, 1 wheelchair space, 3 car seats, 1 oxygen mount, and a lift. */
  const RULED = { seats: 6, wheelchairSpots: 1, carSeats: 3, oxygenMounts: 1, hasLift: true };

  it("is those counts, for every van of the fleet", () => {
    for (const van of VANS) {
      expect(defaultSetupOf(van.vehicleKey), van.vehicleKey).toEqual(RULED);
    }
  });

  it("is one definition, shared by all three vans", () => {
    const setups = VANS.map((van) => JSON.stringify(defaultSetupOf(van.vehicleKey)));
    expect(new Set(setups).size, "one generic van (§6.1)").toBe(1);
    expect(new Set(setups).size, "and a fleet to share it").toBe(1);
    expect(VANS.length).toBe(3);
  });
});

/* ───────────────────────── (a) the board refuses, Today agrees ───────────────────────── */

describe("an unchecked van is as full as its default says", () => {
  /**
   * Van 1 loaded to the six seats its default gives it, on a day nobody has counted: Auto-plan's
   * own three (Zoe B. in her chair with a nurse beside her, Ava N., Liam D.) and the three a
   * coordinator drags across (Mia R., Owen C., Theo V.).
   *
   * Six riders take six seats — a chair rider takes the chair space and their nurse one seat —
   * and their three car seats are the three the van has, so the van is **exactly at** two of its
   * counters and over none. That is the state the refusal below is about, and at Firia's default
   * (8:49 AM ET: six seats) it takes a drag to reach: Auto-plan alone leaves three seats free.
   */
  const DRAGGED_ON = ["C1", "C7", "C9"];
  const filled = (planned: BoardPlan, vanId: string): BoardPlan => ({
    ...planned,
    ...Object.fromEntries(
      DRAGGED_ON.map((childKey) => [token(childKey), { bucket: "VAN", vanId, pinned: true }]),
    ),
  });

  /**
   * (a) THE REFUSED DROP, at the default counts. Van 1 is filled to its seats; a seventh child
   * let go on it is refused, the card does not move, and the one coral line names the van and
   * the thing that has run out (§1.3, Vera's taste spec).
   *
   * Before the fix Today read the seeded layout `1WC/3A` for this van, so it reported riders the
   * board had accepted as not fitting. Both screens read the counts below now.
   */
  it("refuses the drop that would overfill it, with the coral reason line", async () => {
    const view = await board();
    const vanOne = view.day.vans.find((van) => van.id === vanIdOf("V1")) as BoardVan;
    const planned = filled(autoPlan(view.day, view.plan), vanOne.id);

    // Full on seats, and full means equal to the counts the column is showing — not more.
    const aboard = ridersInVan(view.day, planned, vanOne.id);
    expect(usedBy(aboard).seats, "Van 1 is at its default seats").toBe(vanOne.setup.seats);
    expect(usedBy(aboard).carSeats, "and at its car seats").toBe(vanOne.setup.carSeats);
    expect(isOver(vanOne.setup, aboard), "and over neither").toBe(false);

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
    await save("AM", planned, view.version);

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
    const vanOne = view.day.vans.find((van) => van.id === vanIdOf("V1")) as BoardVan;
    const planned = filled(autoPlan(view.day, view.plan), vanOne.id);
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

/* ───────── a van nobody has counted warns about nobody (Firia, 2026-10-18 8:49 AM ET) ───────── */

/**
 * THE OTHER DIRECTION OF THE RULING. A default is a number a coordinator never asked for, so the
 * day it is wrong is a day every screen is shouting about a plan nobody has touched. At Firia's
 * counts — 6 seats, 1 chair, 3 car seats, 1 oxygen mount — the two plans this product actually
 * loads on an uncounted morning are silent on **both** screens:
 *
 *  - (i) the reference morning of src/test/reference-plan.ts (Auto-plan, Liam D. dragged to
 *    Van 2), which is Firia's own 5:09 AM ET prod re-save;
 *  - (ii) the afternoon, Auto-plan's own, nine of nine placed.
 *
 * "Silent on the board" is `checkPlan` and `isOver` over `van.setup`; "silent on Today" is its
 * fit check, which is the same arithmetic over the same counts since the S1. Nothing is counted
 * at the ramp in either test, so every van is on the default and this is the ruling's own case.
 */
describe("a plan on the default counts raises no warning on either screen", () => {
  const slotOf = (vehicleKey: string) => vanConfigOf(vehicleKey)?.slot ?? null;

  /** No van of this board is over a counter, and the server's own re-check accepts the plan. */
  const boardIsContent = async (direction: "AM" | "PM") => {
    const view = await loadBoard(store(), SITE, DATE, direction, source());
    for (const van of view.day.vans) {
      expect(van.setupState, `${van.name} is uncounted`).toBe("DEFAULT");
      expect(van.setup, `${van.name} is on the ruled default`).toEqual(defaultSetupOf("V1"));
      expect(
        isOver(van.setup, ridersInVan(view.day, view.plan, van.id)),
        `${van.name} holds its riders`,
      ).toBe(false);
    }
    expect(checkPlan(view.day, view.plan), "the save's own re-check").toEqual({ ok: true });
    return view;
  };

  it("(i) the reference morning fits, van by van, on the board and on Today", async () => {
    const view = await board();
    const planned = moveTo(autoPlan(view.day, view.plan), token(MOVED_CHILD), vanIdOf(MOVED_TO));

    // It is Firia's layout and not whatever Auto-plan happens to do today.
    for (const [childKey, vehicleKey] of Object.entries(REFERENCE_MORNING)) {
      expect(planned[token(childKey)], childKey).toEqual({
        bucket: "VAN",
        vanId: vanIdOf(vehicleKey),
        pinned: childKey === MOVED_CHILD,
      });
    }
    expect(checkPlan(view.day, planned), "the board holds it before it is saved").toEqual({
      ok: true,
    });

    await save("AM", planned, view.version);
    await boardIsContent("AM");

    const today = await todayBoard();
    expect(misfits(today), "and Today warns about nobody").toEqual([]);
    for (const [childKey, vehicleKey] of Object.entries(REFERENCE_MORNING)) {
      const leg = morningLegs(today).find((l) => l.child.childKey === childKey);
      expect(leg?.ride.vanNumber, childKey).toBe(slotOf(vehicleKey));
      expect(leg?.ride.solver, childKey).toBe("FEASIBLE");
      expect(leg?.nextStep, childKey).not.toBe("MOVE_TO_FITTING_VAN");
    }
  });

  /**
   * The afternoon's own three discriminators, because its rides sit on a different rung: nobody
   * has reported an afternoon van yet, so most of these rides are `CAPABILITY_PENDING` — an
   * unobserved vehicle-day, which `solveRun` answers **before** it reaches a counter and which is
   * not a fit verdict either way. What a wrong default would still show here is Auto-plan leaving
   * riders unplaced, the board's own `isOver` / `checkPlan`, and a `DOES_NOT_FIT` on any ride
   * whose van *has* been reported (Noah O., the one FEASIBLE row below).
   */
  it("(ii) the afternoon, nine of nine placed, fits on the board and on Today", async () => {
    const view = await loadBoard(store(), SITE, DATE, "PM", source());
    const planned = autoPlan(view.day, view.plan);
    const inVans = Object.values(planned).filter((spot) => spot.bucket === "VAN");
    expect(inVans, "Auto-plan places all nine of the afternoon's riders").toHaveLength(9);

    await save("PM", planned, view.version);
    await boardIsContent("PM");

    const today = await todayBoard();
    expect(misfitsOf(today, "PM"), "and Today warns about nobody").toEqual([]);
    const placed = legsOf(today, "PM").filter((leg) => leg.ride.vanNumber !== null);
    expect(placed, "nine of nine, on the screen the families read").toHaveLength(9);
    for (const leg of placed) {
      expect(leg.ride.solver, leg.child.childKey).not.toBe("INFEASIBLE");
      expect(leg.needsActionReasons, leg.child.childKey).not.toContain("DOES_NOT_FIT");
      expect(leg.nextStep, leg.child.childKey).not.toBe("MOVE_TO_FITTING_VAN");
    }
    // And the one afternoon van somebody has reported is checked against its counts and fits.
    const reported = placed.filter((leg) => leg.ride.solver === "FEASIBLE");
    expect(reported.map((leg) => leg.child.childKey), "Noah O.'s van is reported").toEqual(["C2"]);
  });
});
