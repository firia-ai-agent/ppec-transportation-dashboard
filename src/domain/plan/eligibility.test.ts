import { describe, expect, it } from "vitest";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { defaultsOfSlot, testDay, vanIdOfSlot } from "@/test/board-day";
import {
  autoPlan,
  emptyPlan,
  moveTo,
  placedCount,
  ridersInVan,
  type BoardDay,
  type BoardPlan,
} from "./board";
import { firstShortfall, placeRiders, type FitRider } from "./fit";
import { eligibility, vanVerdicts, type Eligibility } from "./eligibility";

/**
 * ONE ELIGIBILITY CHECK — the drag, the drop and Auto-plan, asked and answered the same way.
 *
 * The S1 bug (2026-10-18) was hit detection and not the fit rule, and this file is the half of
 * the investigation that proves it: Van 1 on a fresh day really can take Zoe B., so the only
 * honest outcome of that drop was for her to land. What is held here afterwards is the property
 * that makes "the drag and Auto-plan disagreed" impossible to be the answer next time — every
 * seeded child against every van, on three plan states, with the two paths giving the same
 * verdict and the same reason.
 *
 * Auto-plan's own per-van test is `placeRiders` pinning the load into the van and asking whether
 * it holds (src/domain/plan/fit.ts), so that is what the parity property asks: not the same
 * expression written twice, but the board's question put through the placement function.
 */

const ZOE = childTokenOf("C6");

/** Auto-plan's verdict on this exact load: pin the van's riders plus this child, and ask. */
function autoPlanSays(day: BoardDay, plan: BoardPlan, childToken: string, vanId: string): Eligibility {
  const van = day.vans.find((candidate) => candidate.id === vanId);
  const rider = day.riders.find((candidate) => candidate.token === childToken);
  if (!van || !rider) throw new Error("not a van and a rider of this day");
  const aboard: FitRider[] = [
    ...ridersInVan(day, plan, vanId).filter((other) => other.token !== childToken),
    rider,
  ];
  const result = placeRiders(
    [{ id: van.id, slot: van.slot, setup: van.setup }],
    aboard,
    Object.fromEntries(aboard.map((one) => [one.token, van.id])),
  );
  if (result.unplaced.length === 0) return { ok: true };
  /*
   * The van cannot hold this load. Which counter it is short of is the van's fact and not the
   * child's — a van one car seat short is one car seat short whoever is in it — so the reason
   * is read off the load, in the same refusal order every surface names (fit.ts `REJECT_ORDER`).
   */
  const shortfall = firstShortfall(van.setup, aboard);
  if (!shortfall) throw new Error("refused a load it is not short for");
  return { ok: false, reason: shortfall.reason };
}

/* ───────────────────────── 1. the bug, as the rules see it ───────────────────────── */

describe("1. Zoe B. onto Van 1 on a fresh day (the S1 drop)", () => {
  it("is allowed — so the bounce was never a capacity refusal", async () => {
    const day = await testDay("AM");
    const fresh = emptyPlan(day);
    const vanOne = vanIdOfSlot(1);

    // She rides in her own chair, with oxygen and a nurse along (fixtures C6).
    const zoe = day.riders.find((rider) => rider.token === ZOE);
    expect(zoe?.name).toBe("Zoe B.");
    expect(zoe?.needs).toMatchObject({ wheelchair: true, oxygen: true, nurse: true });

    // Van 1 opens on the shared config's defaults, with its spot and its mount free, which is
    // what the column's chips read: Wheelchair 0/1 and Oxygen 0/1.
    expect(defaultsOfSlot(1)).toMatchObject({ wheelchairSpots: 1, oxygenMounts: 1, hasLift: true });
    expect(ridersInVan(day, fresh, vanOne)).toEqual([]);
    expect(placedCount(day, fresh)).toBe(0);

    expect(eligibility(day, fresh, ZOE, vanOne)).toEqual({ ok: true });
  });

  /** And Auto-plan agrees, by putting her there itself — the comparison Firia asked for. */
  it("is the van Auto-plan picks for her on the same day", async () => {
    for (const leg of ["AM", "PM"] as const) {
      const day = await testDay(leg);
      const planned = autoPlan(day, emptyPlan(day));
      expect(planned[ZOE], leg).toMatchObject({ bucket: "VAN", vanId: vanIdOfSlot(1) });
      expect(autoPlanSays(day, emptyPlan(day), ZOE, vanIdOfSlot(1)), leg).toEqual({ ok: true });
    }
  });

  /** Out of every van is the one move nothing can refuse: a child in no van takes nothing. */
  it("never refuses a move out of every van", async () => {
    const day = await testDay("AM");
    const planned = autoPlan(day, emptyPlan(day));
    for (const rider of day.riders) {
      expect(eligibility(day, planned, rider.token, null), rider.name).toEqual({ ok: true });
    }
  });
});

/* ───────────────────────── 3. the drag and Auto-plan, every pair ───────────────────────── */

describe("3. the drag check is Auto-plan's check", () => {
  /**
   * Three plan states, because capacity is a fact about the load: an empty board (what a drag
   * meets right after Start), a board Auto-plan has filled, and a part-planned board — which is
   * what the ramp hands back and what an Undo leaves behind.
   */
  async function states(leg: "AM" | "PM"): Promise<{ day: BoardDay; plans: [string, BoardPlan][] }> {
    const day = await testDay(leg);
    const fresh = emptyPlan(day);
    const full = autoPlan(day, fresh);
    // Two children pulled back out of their vans, so three vans carry an uneven part-load.
    const partial = day.riders
      .slice(0, 2)
      .reduce((plan, rider) => moveTo(plan, rider.token, null), full);
    return {
      day,
      plans: [
        ["a fresh day", fresh],
        ["an auto-planned day", full],
        ["a part-planned day", partial],
      ],
    };
  }

  for (const leg of ["AM", "PM"] as const) {
    it(`agrees for every seeded child in every van (${leg})`, async () => {
      const { day, plans } = await states(leg);
      expect(day.riders.length).toBeGreaterThan(5);
      expect(day.vans).toHaveLength(3);

      let pairs = 0;
      for (const [what, plan] of plans) {
        for (const rider of day.riders) {
          for (const van of day.vans) {
            const drag = eligibility(day, plan, rider.token, van.id);
            const auto = autoPlanSays(day, plan, rider.token, van.id);
            expect(drag, `${rider.name} → ${van.name} on ${what}`).toEqual(auto);
            pairs += 1;
          }
        }
      }
      expect(pairs).toBe(day.riders.length * day.vans.length * plans.length);
    });
  }

  /**
   * The same cross product on a day the front desk has counted *down* — the one way a generic
   * van refuses anybody at all (Firia's 8:02 PM ET seed ruling: three identical vans, so a
   * refusal is made of counts and never of what a van *is*).
   */
  it("agrees when a van has been counted down to nothing", async () => {
    const day = await testDay("AM", {
      1: { seats: 1, wheelchairSpots: 0, carSeats: 0, oxygenMounts: 0, hasLift: false },
      2: { seats: 2, wheelchairSpots: 1, carSeats: 1, oxygenMounts: 0 },
    });
    const full = autoPlan(day, emptyPlan(day));
    let refusals = 0;
    for (const plan of [emptyPlan(day), full]) {
      for (const rider of day.riders) {
        for (const van of day.vans) {
          const drag = eligibility(day, plan, rider.token, van.id);
          expect(drag, `${rider.name} → ${van.name}`).toEqual(
            autoPlanSays(day, plan, rider.token, van.id),
          );
          if (!drag.ok) refusals += 1;
        }
      }
    }
    // The point of the case: it really does contain refusals, of more than one kind.
    expect(refusals).toBeGreaterThan(0);
    expect(eligibility(day, emptyPlan(day), ZOE, vanIdOfSlot(1))).toEqual({
      ok: false,
      reason: "WHEELCHAIR",
    });
  });

  /** A target that is not on this board moves nobody, and names nothing it cannot name. */
  it("says nothing about a van this day does not have", async () => {
    const day = await testDay("AM");
    expect(eligibility(day, emptyPlan(day), ZOE, "not-a-van")).toEqual({ ok: true });
    expect(eligibility(day, emptyPlan(day), "not-a-child", vanIdOfSlot(1))).toEqual({ ok: true });
  });
});

/**
 * THE RAMP'S LIVE REPLAY — the same question, asked of the counts on the screen.
 *
 * `vanVerdicts` is what the ramp iPad runs as a stepper moves (§2's live fit check). It used to
 * be written out inline in the component, so these are the two things that must hold now that it
 * is the shared function: it agrees with `eligibility()` on the board's own van setup, and it
 * moves the moment a counter does.
 */
describe("vanVerdicts: the ramp's replay is the board's answer", () => {
  for (const leg of ["AM", "PM"] as const) {
    it(`agrees with eligibility() for every van of a planned day (${leg})`, async () => {
      const day = await testDay(leg);
      const plan = autoPlan(day, emptyPlan(day));
      let checked = 0;

      for (const van of day.vans) {
        const aboard = ridersInVan(day, plan, van.id);
        const verdicts = vanVerdicts(van.setup, aboard);
        expect(verdicts.map((verdict) => verdict.token)).toEqual(aboard.map((rider) => rider.token));

        for (const verdict of verdicts) {
          /*
           * The board asks about a child **on top of the van as the plan has it**, so the honest
           * comparison is the plan with that child taken out of the van and dropped back in.
           */
          const without = moveTo(plan, verdict.token, null);
          const drag = eligibility(day, without, verdict.token, van.id);
          expect(drag.ok, `${verdict.token} → ${van.name}`).toBe(verdict.reason === null);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(5);
    });
  }

  it("one car seat fewer: exactly one child is refused, named, and one car seat short", async () => {
    const day = await testDay("AM");
    const vanOne = vanIdOfSlot(1);
    /* Two children who each need a car seat, on one van: the mockup's load (Jonah W., Mia R.). */
    const needCarSeat = day.riders.filter((rider) => rider.needs.carSeat).slice(0, 2);
    expect(needCarSeat).toHaveLength(2);
    let plan = emptyPlan(day);
    for (const rider of needCarSeat) plan = moveTo(plan, rider.token, vanOne);
    const aboard = ridersInVan(day, plan, vanOne);

    const roomy = { ...defaultsOfSlot(1), carSeats: 3 };
    expect(vanVerdicts(roomy, aboard).every((verdict) => verdict.reason === null)).toBe(true);

    // The front desk finds one car seat fewer than the plan needs.
    const counted = { ...roomy, carSeats: 1 };
    const refused = vanVerdicts(counted, aboard).filter((verdict) => verdict.reason !== null);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBe("CAR_SEAT");
    expect(day.riders.some((rider) => rider.token === refused[0].token)).toBe(true);
    // And the van is short by exactly one of them, which is what the banner says.
    expect(firstShortfall(counted, aboard)).toEqual({ reason: "CAR_SEAT", short: 1 });

    // Putting the car seat back clears it, live, with nothing else changed.
    expect(vanVerdicts({ ...counted, carSeats: 2 }, aboard).every((v) => v.reason === null)).toBe(true);
    expect(firstShortfall({ ...counted, carSeats: 2 }, aboard)).toBeNull();
  });
});
