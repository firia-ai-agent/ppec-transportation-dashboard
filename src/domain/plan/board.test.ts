import { describe, expect, it } from "vitest";
import { VANS, defaultSetupOf, vanNameOf } from "@/config/vans";
import {
  autoPlan,
  childrenInBucket,
  boardMap,
  checkPlan,
  emptyPlan,
  moveTo,
  namesOnlyThisDay,
  placeableVans,
  placedCount,
  ridersInVan,
  shortfallsOfDay,
  stopCount,
  stopNumbers,
  unassignedRiders,
  usedInVan,
  type BoardPlan,
} from "./board";
import { fits, placeRiders, rejectReason } from "./fit";
import { needsFromCategories } from "./needs";
import { NEED_CATEGORY } from "@/config/equipment";
import { needsOfDemoChild } from "@/modules/demo/day-source";
import { childByKey, type Child as DemoChild } from "@/modules/demo/fixtures/standard";
import { resolveSetup, type SetupRow } from "./setup";
import { CHILDREN, childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";

/** One fixture child's flags, the way the demo adapter builds them for the board. */
const needsOfKey = (key: string) => needsOfDemoChild(childByKey(key));

/** Only the placements a person pinned, which is what survives a re-plan. */
function pinnedOnly(plan: BoardPlan, tokens: readonly string[]): BoardPlan {
  return Object.fromEntries(
    tokens.filter((token) => plan[token]?.pinned).map((token) => [token, plan[token]]),
  );
}
import { TEST_DATE, scenarioPlan, testDay, vanIdOfSlot } from "@/test/board-day";

/**
 * The board's own day: the three vans, the children of one leg, and the three things a person
 * asks of it — Auto-plan, "can this child go here", and "is this plan allowed".
 *
 * The day is the one roster every screen reads (src/modules/demo/day-source.ts behind the day
 * port), so these assertions are about the scenario the founder is shown.
 */
const DATE = TEST_DATE;

describe("§6.4: a child's needs, from their approved profile only", () => {
  it("reads a chair, a car seat, a vest and a nurse off the approved items", async () => {
    expect(needsOfKey("C2")).toMatchObject({ wheelchair: true, carSeat: false, nurse: false });
    expect(needsOfKey("C1")).toMatchObject({ wheelchair: false, carSeat: true });
    expect(needsOfKey("C7")).toMatchObject({ carSeat: true });
    expect(needsOfKey("C6")).toMatchObject({ wheelchair: true, nurse: true });
  });

  /**
   * The rule, built here rather than borrowed from the day.
   *
   * The fresh seed (2026-10-17 8:02 PM ET) carries only approved needs, so there is no longer a
   * reported item in the fixtures to point at — and the rule it used to demonstrate is exactly
   * the one that must not weaken. So the test makes its own child with one approved need and one
   * reported one, and asserts the planner reads the first and not the second.
   */
  it("ignores a need nobody has approved (DECISION-LEDGER row 1)", async () => {
    const child: DemoChild = {
      ...childByKey("C8"),
      needs: [
        { category: NEED_CATEGORY.carSeat, value: {}, state: "APPROVED" },
        { category: NEED_CATEGORY.oxygen, value: {}, state: "REPORTED" },
      ],
    };
    // What the adapter hands the planner: the approved car seat, and no oxygen at all.
    expect(needsOfDemoChild(child)).toEqual({
      wheelchair: false,
      carSeat: true,
      oxygen: false,
      nurse: false,
    });
    // And the raw rule under it: a category only counts when the item carrying it is approved.
    const approved = child.needs.filter((need) => need.state === "APPROVED").map((n) => n.category);
    expect(needsFromCategories(approved).oxygen).toBe(false);
    expect(needsFromCategories([NEED_CATEGORY.oxygen]).oxygen).toBe(true);
    // The day itself has nothing unapproved left, which is the seed's own shape.
    expect(CHILDREN.flatMap((c) => c.needs).filter((n) => n.state !== "APPROVED")).toEqual([]);
  });

  it("plans against oxygen, now that the day has an approved oxygen rider (7:17 PM ET)", async () => {
    // Zoe B.'s device used to be `MEDICAL_DEVICE_POWER` and `REPORTED`, so no van's oxygen
    // mount was ever asked for. It is `OXYGEN` and `APPROVED` now.
    expect(needsOfKey("C6").oxygen).toBe(true);
    expect(CHILDREN.filter((child) => needsOfDemoChild(child).oxygen).length).toBeGreaterThan(0);
  });

  it("gives a child with nothing on file nothing", async () => {
    expect(needsOfKey("C8")).toEqual({ wheelchair: false, carSeat: false, oxygen: false, nurse: false });
  });
});

/**
 * Firia/Veri, 2026-10-17 6:00 PM ET: two rungs and no carry-over. Today's `CHECKED` row, or the
 * shared config's defaults — never yesterday's counts, and never a state a person did not set.
 */
describe("§1.6 as re-cut: which counts a van is planned on", () => {
  const key = VANS[0].vehicleKey;
  const row = (over: Partial<SetupRow> = {}): SetupRow => ({
    vehicleId: vehicleIdOf(key),
    serviceDate: DATE,
    setup: { seats: 2, wheelchairSpots: 2, carSeats: 2, oxygenMounts: 2, hasLift: false },
    state: "CHECKED",
    setBy: "Ana P.",
    setAt: `${DATE}T19:30:00.000Z`,
    ...over,
  });

  it("uses today's confirmed row when there is one", async () => {
    const resolved = resolveSetup(key, DATE, [row()]);
    expect(resolved).toMatchObject({ source: "CHECKED", state: "CHECKED", setBy: "Ana P." });
    expect(resolved.setup.seats).toBe(2);
  });

  it("never carries an earlier day forward: yesterday's confirmed van is not today's", async () => {
    const resolved = resolveSetup(key, DATE, [
      row({ serviceDate: "2026-10-16" }),
      row({ serviceDate: "2026-10-15" }),
    ]);
    expect(resolved).toMatchObject({ source: "DEFAULT", state: "DEFAULT" });
    expect(resolved.setup).toEqual(defaultSetupOf(key));
    expect(resolved).not.toHaveProperty("fromDate");
  });

  it("never reads tomorrow as today", async () => {
    expect(resolveSetup(key, DATE, [row({ serviceDate: "2026-10-18" })]).source).toBe("DEFAULT");
  });

  it("has only the two states a screen can see", async () => {
    for (const state of [resolveSetup(key, DATE, [row()]).state, resolveSetup(key, DATE, []).state]) {
      expect(["CHECKED", "DEFAULT"]).toContain(state);
    }
  });
});

describe("the day the board opens on", () => {
  it("names each van by number and nothing else", async () => {
    const day = await testDay();
    expect(day.vans.map((van) => van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(vanNameOf(2)).toBe("Van 2");
    for (const van of day.vans) {
      expect(van.name).not.toMatch(/\bV\d\b/);
      expect(van.id).not.toMatch(/^V\d$/);
    }
  });

  it("gives every van a colour from the one shared config, and no two the same", async () => {
    const tokens = (await testDay()).vans.map((van) => van.colourToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) expect(token).not.toMatch(/^#/);
  });

  it("drives the children with a stop of their own, and nobody else", async () => {
    const day = await testDay();
    expect(day.riders.length).toBeGreaterThan(0);
    for (const rider of day.riders) {
      expect(rider.stopLabel.length).toBeGreaterThan(0);
      expect(rider.name).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
    }
    // Everybody else is in one of the two groups, and nobody is in both halves of the day.
    const riding = new Set(day.riders.map((rider) => rider.token));
    for (const other of day.others) expect(riding.has(other.token)).toBe(false);
  });

  /**
   * Away is a **placement**, not a fact about the roster (founder 2026-10-17 7:17 PM ET): the
   * child is still one of the day's riders and the board shows them in its Absent group, which
   * is also what lets a coordinator drag them back out of it.
   */
  it("keeps a child marked away on the roster, in the Absent bucket of this leg's plan", async () => {
    const day = await testDay();
    const away = day.riders[0];
    const plan = { ...emptyPlan(day), [away.token]: { bucket: "ABSENT" as const, vanId: null, pinned: true } };
    expect(day.riders.some((rider) => rider.token === away.token)).toBe(true);
    expect(childrenInBucket(day, plan, "ABSENT").map((child) => child.token)).toEqual([away.token]);
    // And Auto-plan does not put them in a van behind the coordinator's back.
    expect(autoPlan(day, plan)[away.token].bucket).toBe("ABSENT");
  });

  it("opens with everybody waiting (§1.3 Empty)", async () => {
    const day = await testDay();
    const plan = emptyPlan(day);
    expect(placedCount(day, plan)).toBe(0);
    expect(unassignedRiders(day, plan)).toHaveLength(day.riders.length);
    for (const other of day.others) expect(plan[other.token].bucket).toBe(other.bucket);
  });
});

describe("§1.4: Auto-plan is the one placement function", () => {
  it("places every rider of the day across the three vans", async () => {
    const day = await testDay();
    const plan = autoPlan(day, emptyPlan(day));
    expect(placedCount(day, plan)).toBe(day.riders.length);
    expect(unassignedRiders(day, plan)).toEqual([]);
  });

  it("gives no van more than it can carry", async () => {
    const day = await testDay();
    const plan = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      expect(fits(van.setup, ridersInVan(day, plan, van.id)), van.name).toBe(true);
    }
  });

  it("keeps a child a person placed by hand, and plans the rest around them", async () => {
    const day = await testDay();
    const rider = day.riders[0];
    const van = day.vans[1];
    const pinned = moveTo(emptyPlan(day), rider.token, van.id);
    const plan = autoPlan(day, pinned);
    expect(plan[rider.token]).toMatchObject({ bucket: "VAN", vanId: van.id, pinned: true });
    expect(placedCount(day, plan)).toBe(day.riders.length);
  });

  it("leaves a child a person took out of a van out of it", async () => {
    const day = await testDay();
    const rider = day.riders[0];
    const plan = autoPlan(day, moveTo(emptyPlan(day), rider.token, null));
    expect(plan[rider.token]).toMatchObject({ bucket: "UNASSIGNED", pinned: true });
  });

  it("leaves a rider no van can take unplaced, and says exactly what the day is short of", async () => {
    // Every van loses its car seats, so the children who need one cannot ride at all.
    const day = await testDay("PM", {
      1: { carSeats: 0 },
      2: { carSeats: 0 },
      3: { carSeats: 0 },
    });
    const plan = autoPlan(day, emptyPlan(day));
    const needsCarSeat = day.riders.filter((rider) => rider.needs.carSeat);
    expect(needsCarSeat.length).toBeGreaterThan(0);
    for (const rider of needsCarSeat) {
      expect(plan[rider.token].bucket, rider.name).toBe("UNASSIGNED");
    }
    const short = shortfallsOfDay(day, plan);
    expect(short.map((one) => one.token).sort()).toEqual(needsCarSeat.map((r) => r.token).sort());
    for (const one of short) expect(one.shortfall).toEqual({ reason: "CAR_SEAT", short: 1 });
  });

  it("never puts a chair on a van whose lift does not work", async () => {
    const day = await testDay("PM", { 1: { hasLift: false }, 2: { hasLift: false } });
    const plan = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      if (van.setup.hasLift) continue;
      expect(ridersInVan(day, plan, van.id).some((rider) => rider.needs.wheelchair)).toBe(false);
    }
  });

  /**
   * Veri F2, 2026-10-17: the test that matters is not "two identical calls agree", it is that a
   * re-plan **of a day that already has a plan** lands where a fresh plan of the same day lands.
   * A needs Save re-plans on top of whatever was there, so if the two drifted, a coordinator
   * would get a different board for having saved twice.
   */
  it("re-planning a planned day equals planning it fresh, with the same pins", async () => {
    const day = await testDay();
    const prior = autoPlan(day, emptyPlan(day));
    // A person pins two of them by hand, which is what a drag does.
    const pinned = moveTo(moveTo(prior, day.riders[0].token, day.vans[1].id), day.riders[1].token, null);

    const again = autoPlan(day, pinned);
    const fresh = autoPlan(day, { ...emptyPlan(day), ...pinnedOnly(pinned, day.riders.map((r) => r.token)) });
    for (const rider of day.riders) {
      expect({ who: rider.name, van: again[rider.token].vanId }).toEqual({
        who: rider.name,
        van: fresh[rider.token].vanId,
      });
    }
  });

  it("re-plans on changed needs the same way a fresh plan would", async () => {
    const day = await testDay();
    const prior = autoPlan(day, emptyPlan(day));
    // Theo V. now needs a car seat, which is what the child panel's Save writes.
    const changed: typeof day = {
      ...day,
      riders: day.riders.map((rider) =>
        rider.name.startsWith("Theo") ? { ...rider, needs: { ...rider.needs, carSeat: true } } : rider,
      ),
    };
    const again = autoPlan(changed, prior);
    const fresh = autoPlan(changed, emptyPlan(changed));
    for (const rider of changed.riders) {
      expect({ who: rider.name, van: again[rider.token].vanId }).toEqual({
        who: rider.name,
        van: fresh[rider.token].vanId,
      });
    }
    // And the van they ended up on really does carry a car seat for them.
    const theo = changed.riders.find((rider) => rider.name.startsWith("Theo"));
    const vanId = again[theo!.token].vanId;
    expect(vanId).not.toBeNull();
    expect(usedInVan(changed, again, vanId!).carSeats).toBeGreaterThan(0);
  });

  it("is the same answer the board's own vans give the placement function directly", async () => {
    const day = await testDay();
    const direct = placeRiders(placeableVans(day), day.riders);
    const plan = autoPlan(day, emptyPlan(day));
    for (const rider of day.riders) {
      expect(plan[rider.token].vanId).toBe(direct.vanOf[rider.token] ?? null);
    }
  });
});

describe("§1.7 #1: a refused drop changes nothing", () => {
  /**
   * The refusal is made of **counters**, not of a weaker van (Vera/Athena/Veri with Firia's
   * sign-off, 2026-10-18 12:13 AM ET): all three vans are the same generic type, so the van that
   * cannot take this chair is the van whose one wheelchair spot is already taken.
   */
  it("refuses a chair onto a van whose only wheelchair spot is used, and names it", async () => {
    const day = await testDay();
    const vanThree = day.vans.find((van) => van.slot === 3);
    if (!vanThree) throw new Error("no Van 3");
    // One spot, and a lift — the same van as the other two.
    expect(vanThree.setup.wheelchairSpots).toBe(1);
    expect(vanThree.setup.hasLift).toBe(true);
    const chairs = day.riders.filter((rider) => rider.needs.wheelchair);
    expect(chairs.length, "the day has two children who ride in their own chair").toBeGreaterThan(1);
    // Empty, it takes the first of them; with that one aboard, the second is refused by name.
    expect(rejectReason(vanThree.setup, [], chairs[1])).toBe(null);
    expect(rejectReason(vanThree.setup, [chairs[0]], chairs[1])).toBe("WHEELCHAIR");
  });

  it("refuses the whole save when a posted plan puts them there anyway", async () => {
    const day = await testDay();
    const vanThree = vanIdOfSlot(3);
    const chairs = day.riders.filter((rider) => rider.needs.wheelchair);
    expect(chairs.length).toBeGreaterThan(1);
    const posted = moveTo(
      moveTo(emptyPlan(day), chairs[0].token, vanThree),
      chairs[1].token,
      vanThree,
    );
    const refused = checkPlan(day, posted);
    // One spot and two chairs: the van is refused by name, with the reason, and the child it
    // names is one of the two who would have ridden in it (the checker reports the first).
    expect(refused).toMatchObject({ ok: false, vanId: vanThree, reason: "WHEELCHAIR" });
    expect(chairs.map((rider) => rider.token)).toContain(
      (refused as { childToken: string }).childToken,
    );
    // And one of them alone is a plan the rule agrees with, so it is the count that refused it.
    expect(checkPlan(day, moveTo(emptyPlan(day), chairs[0].token, vanThree))).toEqual({ ok: true });
  });

  it("passes a plan the fit rule agrees with", async () => {
    const day = await testDay();
    expect(checkPlan(day, autoPlan(day, emptyPlan(day)))).toEqual({ ok: true });
  });

  it("refuses a plan naming a child or a van the day does not have", async () => {
    const day = await testDay();
    const good = autoPlan(day, emptyPlan(day));
    expect(namesOnlyThisDay(day, good)).toBe(true);
    const strangeChild: BoardPlan = { ...good, "not-a-child": { bucket: "UNASSIGNED", vanId: null, pinned: false } };
    expect(namesOnlyThisDay(day, strangeChild)).toBe(false);
    const strangeVan: BoardPlan = { ...good, [day.riders[0].token]: { bucket: "VAN", vanId: "not-a-van", pinned: false } };
    expect(namesOnlyThisDay(day, strangeVan)).toBe(false);
    const bucketWithVan: BoardPlan = { ...good, [day.riders[0].token]: { bucket: "UNASSIGNED", vanId: "x", pinned: false } };
    expect(namesOnlyThisDay(day, bucketWithVan)).toBe(false);
  });
});

describe("stops, in the order a van drives them", () => {
  it("numbers the stops from one, and gives two children at one kerb the same number", async () => {
    const day = await testDay();
    const plan = scenarioPlan(day);
    for (const van of day.vans) {
      const riders = ridersInVan(day, plan, van.id);
      if (riders.length === 0) continue;
      const numbers = [...stopNumbers(riders).values()];
      expect(numbers[0]).toBe(1);
      expect(Math.max(...numbers)).toBe(stopCount(riders));
      // In window order, and never going backwards.
      for (let i = 1; i < numbers.length; i += 1) expect(numbers[i]).toBeGreaterThanOrEqual(numbers[i - 1]);
    }
  });

  it("counts a van's meters off the riders in it", async () => {
    const day = await testDay();
    const plan = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      const riders = ridersInVan(day, plan, van.id);
      const used = usedInVan(day, plan, van.id);
      expect(used.wheelchairSpots).toBe(riders.filter((rider) => rider.needs.wheelchair).length);
      expect(used.carSeats).toBe(riders.filter((rider) => rider.needs.carSeat).length);
      expect(used.seats).toBe(
        riders.filter((rider) => !rider.needs.wheelchair).length + riders.filter((r) => r.needs.nurse).length,
      );
    }
  });

  it("hands the map the same plan the columns show", async () => {
    const day = await testDay();
    const plan = autoPlan(day, emptyPlan(day));
    const data = boardMap(day, plan);
    for (const van of day.vans) {
      const route = data.routes.find((r) => r.laneId === van.id);
      expect(route?.vanName).toBe(van.name);
      expect(route?.riderCount).toBe(stopCount(ridersInVan(day, plan, van.id)));
    }
  });
});
