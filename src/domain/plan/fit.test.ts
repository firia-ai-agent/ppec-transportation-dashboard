import { describe, expect, it } from "vitest";
import { EQUIPMENT_COUNTERS, NO_NEEDS, type NeedFlags, type RejectReason } from "@/config/equipment";
import {
  REJECT_ORDER,
  fits,
  firstShortfall,
  isOver,
  needsLift,
  noneUsed,
  rejectReason,
  shortfalls,
  usedBy,
  type FitRider,
  type VanSetup,
} from "./fit";

/**
 * The fit rule (redesign spec §1.4), which is the one piece of arithmetic the whole board rests
 * on: a drag asks it, a save re-asks it on the server, and the ramp iPad asks it again as the
 * front desk changes the counts. So it is tested as a *rule* — every counter, every boundary,
 * the order a refusal is decided in — and then tested again against deliberately broken copies
 * of itself at the bottom of this file, because Veri's finding on #58 was that deleting the check
 * altogether passed every test there was.
 */

const setup = (over: Partial<VanSetup> = {}): VanSetup => ({
  seats: 4,
  wheelchairSpots: 1,
  carSeats: 1,
  oxygenMounts: 1,
  hasLift: true,
  ...over,
});

let n = 0;
const rider = (needs: Partial<NeedFlags> = {}, name = "Mia R."): FitRider => ({
  token: `child-${(n += 1)}`,
  name,
  needs: { ...NO_NEEDS, ...needs },
});

const walker = () => rider();
const chair = () => rider({ wheelchair: true });
const carSeat = () => rider({ carSeat: true });
const withOxygen = () => rider({ oxygen: true });
const withNurse = () => rider({ nurse: true });

describe("§1.4: what a van's riders take", () => {
  it("counts nobody as nothing", () => {
    expect(usedBy([])).toEqual(noneUsed());
    expect(Object.values(noneUsed())).toEqual([0, 0, 0, 0]);
  });

  it("gives every walking child a seat and every chair a spot", () => {
    const used = usedBy([walker(), walker(), chair()]);
    expect(used.seats).toBe(2);
    expect(used.wheelchairSpots).toBe(1);
  });

  it("a nurse riding along is one more seat, and a chair with a nurse takes a spot and a seat", () => {
    expect(usedBy([withNurse()]).seats).toBe(2);
    const chairWithNurse = rider({ wheelchair: true, nurse: true });
    expect(usedBy([chairWithNurse]).seats).toBe(1);
    expect(usedBy([chairWithNurse]).wheelchairSpots).toBe(1);
  });

  it("a car seat is a seat as well as a car seat: a child does not sit in two places", () => {
    const used = usedBy([carSeat()]);
    expect(used.seats).toBe(1);
    expect(used.carSeats).toBe(1);
  });

  it("counts oxygen, which only the children who travel with it ask for", () => {
    expect(usedBy([withOxygen(), walker()]).oxygenMounts).toBe(1);
    expect(usedBy([walker(), walker()]).oxygenMounts).toBe(0);
  });

  it("needs the lift only for a child in their own chair", () => {
    expect(needsLift([walker(), carSeat(), withOxygen()])).toBe(false);
    expect(needsLift([walker(), chair()])).toBe(true);
  });
});

describe("§1.4: fits(setup, riders)", () => {
  it("fits a van exactly full, and not one more", () => {
    const four = [walker(), walker(), walker(), walker()];
    expect(fits(setup(), four)).toBe(true);
    expect(fits(setup(), [...four, walker()])).toBe(false);
  });

  it("refuses a chair when there is no spot for it, however many seats are free", () => {
    expect(fits(setup({ wheelchairSpots: 0, seats: 8 }), [chair()])).toBe(false);
  });

  it("refuses a chair when the lift does not work, and takes it when it does", () => {
    expect(fits(setup({ hasLift: false }), [chair()])).toBe(false);
    expect(fits(setup({ hasLift: true }), [chair()])).toBe(true);
    // No chair aboard, so a van with no lift is a perfectly good van.
    expect(fits(setup({ hasLift: false }), [walker(), carSeat()])).toBe(true);
  });

  it("refuses a car seat the van does not carry, and oxygen it has no mount for", () => {
    expect(fits(setup({ carSeats: 1 }), [carSeat(), carSeat()])).toBe(false);
    expect(fits(setup({ oxygenMounts: 0 }), [withOxygen()])).toBe(false);
    expect(fits(setup({ oxygenMounts: 1 }), [withOxygen()])).toBe(true);
  });

  it("is over when a setup is lowered under the riders already aboard (§1.3)", () => {
    const aboard = [walker(), walker(), walker()];
    expect(isOver(setup({ seats: 3 }), aboard)).toBe(false);
    expect(isOver(setup({ seats: 2 }), aboard)).toBe(true);
  });
});

describe("§1.4 / §1.7: the reason a drop is refused", () => {
  it("names nothing when the child fits", () => {
    expect(rejectReason(setup(), [walker()], walker())).toBeNull();
  });

  it("§1.7 #1: a chair onto a van with no spot and no lift reads Wheelchair, not Lift", () => {
    const vanThree = setup({ wheelchairSpots: 0, hasLift: false, seats: 3, carSeats: 1 });
    expect(rejectReason(vanThree, [], chair())).toBe("WHEELCHAIR");
  });

  it("names the lift when the spot is there and the lift is not", () => {
    expect(rejectReason(setup({ wheelchairSpots: 1, hasLift: false }), [], chair())).toBe("LIFT");
  });

  it("§1.7 #2: raising the spot to 1 and the lift to yes takes the same child", () => {
    const before = setup({ wheelchairSpots: 0, hasLift: false });
    const after = { ...before, wheelchairSpots: 1, hasLift: true };
    const noah = chair();
    expect(rejectReason(before, [], noah)).not.toBeNull();
    expect(rejectReason(after, [], noah)).toBeNull();
  });

  it("names the counter that runs out, in §1.4's order", () => {
    expect(rejectReason(setup({ oxygenMounts: 0 }), [], withOxygen())).toBe("OXYGEN");
    expect(rejectReason(setup({ carSeats: 0 }), [], carSeat())).toBe("CAR_SEAT");
    expect(rejectReason(setup({ seats: 0 }), [], walker())).toBe("SEAT");
    // Short of two things at once: the earlier one in the order is the one named.
    const short = setup({ carSeats: 0, oxygenMounts: 0 });
    expect(rejectReason(short, [], rider({ carSeat: true, oxygen: true }))).toBe("OXYGEN");
  });

  it("asks about the load and not about the child alone", () => {
    const full = [walker(), walker(), walker(), walker()];
    expect(rejectReason(setup(), [], walker())).toBeNull();
    expect(rejectReason(setup(), full, walker())).toBe("SEAT");
  });

  it("does not count a child twice when they are already in this van", () => {
    const here = walker();
    const aboard = [here, walker(), walker(), walker()];
    expect(rejectReason(setup(), aboard, here)).toBeNull();
  });

  it("every reason has a place in the order, and the order has no stranger in it", () => {
    const fromCounters = EQUIPMENT_COUNTERS.map((counter) => counter.reject);
    const all: RejectReason[] = [...fromCounters, "LIFT"];
    expect([...REJECT_ORDER].sort()).toEqual([...all].sort());
  });
});

describe("§2: how short a van is, for the ramp's own line", () => {
  it("says how many of a thing are missing", () => {
    const aboard = [carSeat(), carSeat(), carSeat()];
    expect(shortfalls(setup({ carSeats: 2 }), aboard)).toEqual([{ reason: "CAR_SEAT", short: 1 }]);
    expect(firstShortfall(setup({ carSeats: 1 }), aboard)).toEqual({ reason: "CAR_SEAT", short: 2 });
  });

  it("reports every shortfall at once, worst-named first", () => {
    const aboard = [chair(), carSeat(), carSeat()];
    const found = shortfalls(setup({ wheelchairSpots: 0, carSeats: 1, hasLift: false }), aboard);
    expect(found.map((s) => s.reason)).toEqual(["WHEELCHAIR", "LIFT", "CAR_SEAT"]);
  });

  it("says nothing about a van that is fine", () => {
    expect(shortfalls(setup(), [walker(), chair()])).toEqual([]);
    expect(firstShortfall(setup(), [walker()])).toBeNull();
  });
});

/**
 * The mutation check Vera and Veri asked for.
 *
 * Each entry below is the fit rule with one thing deliberately broken — the kind of break a
 * refactor or a careless edit actually makes: an off-by-one in a comparison, a dropped clause, a
 * counter that stops counting, a reject order quietly reversed. The assertion is that **the cases
 * above can tell**: for every mutant there is at least one (setup, riders, child) in this table
 * where it disagrees with the real rule. A mutant that nothing here distinguishes would mean the
 * suite is decoration, which is exactly the hole #58's drag check fell through.
 */
describe("mutation check: a broken fit rule disagrees with at least one case", () => {
  type Case = { setup: VanSetup; aboard: FitRider[]; child: FitRider };
  const cases: Case[] = [
    { setup: setup(), aboard: [], child: walker() },
    { setup: setup({ seats: 1 }), aboard: [walker()], child: walker() },
    { setup: setup({ seats: 2 }), aboard: [walker()], child: withNurse() },
    { setup: setup({ wheelchairSpots: 0, hasLift: false }), aboard: [], child: chair() },
    { setup: setup({ wheelchairSpots: 1, hasLift: false }), aboard: [], child: chair() },
    { setup: setup({ wheelchairSpots: 1, hasLift: true }), aboard: [chair()], child: chair() },
    { setup: setup({ carSeats: 1 }), aboard: [carSeat()], child: carSeat() },
    { setup: setup({ oxygenMounts: 0 }), aboard: [], child: withOxygen() },
    { setup: setup({ oxygenMounts: 1 }), aboard: [withOxygen()], child: withOxygen() },
  ];

  /** The real answer for one case, as the board and the server both read it. */
  const truth = (c: Case): RejectReason | null => rejectReason(c.setup, c.aboard, c.child);

  const mutants: { broken: string; answer: (c: Case) => RejectReason | null }[] = [
    {
      broken: "always allows the drop",
      answer: () => null,
    },
    {
      broken: "counts seats with < instead of <=",
      answer: (c) => {
        const riders = [...c.aboard.filter((r) => r.token !== c.child.token), c.child];
        const used = usedBy(riders);
        if (used.seats < c.setup.seats) return null;
        return "SEAT";
      },
    },
    {
      broken: "forgets the lift clause",
      answer: (c) => {
        const riders = [...c.aboard.filter((r) => r.token !== c.child.token), c.child];
        const used = usedBy(riders);
        for (const counter of EQUIPMENT_COUNTERS) {
          if (used[counter.key] > c.setup[counter.key]) return counter.reject;
        }
        return null;
      },
    },
    {
      broken: "forgets that a nurse takes a seat",
      answer: (c) => {
        const riders = [...c.aboard.filter((r) => r.token !== c.child.token), c.child];
        const seats = riders.filter((r) => !r.needs.wheelchair).length;
        if (seats > c.setup.seats) return "SEAT";
        const rest = shortfalls(c.setup, riders).filter((s) => s.reason !== "SEAT");
        return rest[0]?.reason ?? null;
      },
    },
    {
      broken: "stops counting oxygen",
      answer: (c) => {
        const riders = [...c.aboard.filter((r) => r.token !== c.child.token), c.child];
        return shortfalls(c.setup, riders).filter((s) => s.reason !== "OXYGEN")[0]?.reason ?? null;
      },
    },
    {
      broken: "names the lift before the missing spot",
      answer: (c) => {
        const riders = [...c.aboard.filter((r) => r.token !== c.child.token), c.child];
        const found = shortfalls(c.setup, riders);
        const lift = found.find((s) => s.reason === "LIFT");
        return (lift ?? found[0])?.reason ?? null;
      },
    },
    {
      broken: "asks about the child alone, ignoring who is already aboard",
      answer: (c) => rejectReason(c.setup, [], c.child),
    },
  ];

  for (const mutant of mutants) {
    it(`catches a rule that ${mutant.broken}`, () => {
      const disagreements = cases.filter((c) => mutant.answer(c) !== truth(c));
      expect(disagreements.length, `nothing in the table distinguishes it`).toBeGreaterThan(0);
    });
  }
});
