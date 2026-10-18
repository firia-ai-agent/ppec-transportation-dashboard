import { describe, expect, it } from "vitest";
import { EQUIPMENT_COUNTERS, type NeedFlags } from "@/config/equipment";
import {
  fits,
  placeRiders,
  rejectReason,
  shortfalls,
  usedBy,
  type FitRider,
  type PlaceableVan,
  type VanSetup,
} from "./fit";

/**
 * The five properties Veri gated placement on (2026-10-17), over random days rather than over
 * the one day the demo ships.
 *
 * Why property-style. `placeRiders` is the single answer behind Auto-plan, the drag pre-check,
 * the server's re-check at save, the ramp's live verdicts and Re-plan (Firia's rule 2), so a bug
 * in it is a bug in all five at once — and the days that break a placement rule are the awkward
 * ones nobody writes by hand: every van full but one seat, a chair and no lift, two children at
 * the last car seat. So the day is generated.
 *
 * The generator is seeded and written here rather than pulled in: `fast-check` is not a
 * dependency of this repo, and adding one for this is a bigger decision than the test. The seed
 * is printed with every failure through the case index, and the same index always produces the
 * same day, so a red run is reproducible by re-running it.
 */

/** xorshift32: tiny, deterministic, and good enough to shuffle a van full of children. */
function rng(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

const CASES = 200;

type Day = { vans: PlaceableVan[]; riders: FitRider[] };

function makeDay(seed: number): Day {
  const next = rng(seed * 2654435761);
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));

  const vanCount = int(1, 4);
  const vans: PlaceableVan[] = Array.from({ length: vanCount }, (_, i) => ({
    id: `van-${i + 1}`,
    slot: i + 1,
    setup: {
      seats: int(0, 6),
      wheelchairSpots: int(0, 2),
      carSeats: int(0, 3),
      oxygenMounts: int(0, 2),
      hasLift: next() < 0.6,
    } satisfies VanSetup,
  }));

  const riderCount = int(0, 14);
  const riders: FitRider[] = Array.from({ length: riderCount }, (_, i) => {
    const needs: NeedFlags = {
      wheelchair: next() < 0.25,
      carSeat: next() < 0.3,
      oxygen: next() < 0.2,
      nurse: next() < 0.15,
    };
    // A child in their own chair does not also sit in a car seat.
    if (needs.wheelchair) needs.carSeat = false;
    return { token: `c-${String(i + 1).padStart(2, "0")}`, name: `Child ${i + 1}`, needs };
  });

  return { vans, riders };
}

/** Deterministic shuffle, so "the same day in another order" is itself reproducible. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const next = rng(seed * 69069 + 1);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function ridersOf(day: Day, tokens: readonly string[]): FitRider[] {
  return tokens.map((token) => {
    const rider = day.riders.find((candidate) => candidate.token === token);
    if (!rider) throw new Error(`placed a child the day does not have: ${token}`);
    return rider;
  });
}

const cases = Array.from({ length: CASES }, (_, i) => i + 1);

describe("(a) a placement never exceeds a confirmed count, on any counter, on any van", () => {
  it.each(cases)("case %i", (seed) => {
    const day = makeDay(seed);
    const result = placeRiders(day.vans, day.riders);
    for (const van of day.vans) {
      const aboard = ridersOf(day, result.byVan[van.id]);
      const used = usedBy(aboard);
      for (const counter of EQUIPMENT_COUNTERS) {
        expect(used[counter.key], `${van.id} ${counter.key}`).toBeLessThanOrEqual(van.setup[counter.key]);
      }
      expect(fits(van.setup, aboard), van.id).toBe(true);
    }
  });
});

describe("(b) every child is in exactly one van, or unplaced with an exact shortfall", () => {
  it.each(cases)("case %i", (seed) => {
    const day = makeDay(seed);
    const result = placeRiders(day.vans, day.riders);

    const placedIn = new Map<string, string[]>();
    for (const van of day.vans) {
      for (const token of result.byVan[van.id]) {
        placedIn.set(token, [...(placedIn.get(token) ?? []), van.id]);
      }
    }
    for (const rider of day.riders) {
      const vans = placedIn.get(rider.token) ?? [];
      // Exactly one van, or none — never two.
      expect(vans.length, rider.token).toBeLessThanOrEqual(1);
      expect(result.vanOf[rider.token] ?? null).toBe(vans[0] ?? null);
      const unplaced = result.unplaced.find((one) => one.token === rider.token);
      expect(Boolean(unplaced), rider.token).toBe(vans.length === 0);
      if (!unplaced) continue;
      // The shortfall is a real one: some van really is short of that thing by that much when
      // this child is added to what it is already carrying.
      const matching = day.vans.filter((van) => {
        const found = shortfalls(van.setup, [...ridersOf(day, result.byVan[van.id]), rider])[0];
        return found?.reason === unplaced.shortfall.reason && found.short === unplaced.shortfall.short;
      });
      expect(matching.length, `${rider.token} ${unplaced.shortfall.reason}`).toBeGreaterThan(0);
      // And it is the gentlest true answer: no van is short of less than this.
      const smallest = Math.min(
        ...day.vans.map(
          (van) => shortfalls(van.setup, [...ridersOf(day, result.byVan[van.id]), rider])[0]?.short ?? Infinity,
        ),
      );
      expect(unplaced.shortfall.short).toBe(smallest);
    }
    // Nobody appears who is not in the day.
    for (const token of Object.keys(result.vanOf)) {
      expect(day.riders.some((rider) => rider.token === token)).toBe(true);
    }
  });
});

describe("(c) a van whose lift does not work carries no wheelchair rider", () => {
  it.each(cases)("case %i", (seed) => {
    const day = makeDay(seed);
    const result = placeRiders(day.vans, day.riders);
    for (const van of day.vans) {
      if (van.setup.hasLift) continue;
      const aboard = ridersOf(day, result.byVan[van.id]);
      expect(aboard.some((rider) => rider.needs.wheelchair), van.id).toBe(false);
    }
  });
});

describe("(d) the same day gives the same answer, in whatever order it arrives", () => {
  it.each(cases)("case %i", (seed) => {
    const day = makeDay(seed);
    const once = placeRiders(day.vans, day.riders);
    const twice = placeRiders(day.vans, day.riders);
    expect(twice).toEqual(once);

    const shuffledInput = placeRiders(shuffled(day.vans, seed), shuffled(day.riders, seed + 7));
    // Which van each child is in, and who is unplaced with what, are identical. (The order of
    // the tokens *inside* a van is the order they were placed in, which is itself derived from
    // the sort, so it matches too.)
    expect(shuffledInput.vanOf).toEqual(once.vanOf);
    expect(shuffledInput.unplaced).toEqual(once.unplaced);
    for (const van of day.vans) {
      expect(shuffledInput.byVan[van.id]).toEqual(once.byVan[van.id]);
    }
  });
});

describe("(e) changing a count and re-planning is a fresh run on the new counts", () => {
  it.each(cases)("case %i", (seed) => {
    const day = makeDay(seed);
    const next = rng(seed * 40503 + 3);

    // Somebody is pinned, the way a coordinator's own drag pins them.
    const first = placeRiders(day.vans, day.riders);
    const pins: Record<string, string | null> = {};
    for (const rider of day.riders) {
      if (next() < 0.25) pins[rider.token] = first.vanOf[rider.token] ?? null;
    }

    // The front desk counts a van and finds a different number on it.
    const changed = day.vans.map((van, i) =>
      i === seed % day.vans.length
        ? {
            ...van,
            setup: {
              ...van.setup,
              carSeats: Math.max(0, van.setup.carSeats - 1),
              seats: van.setup.seats + 1,
              hasLift: !van.setup.hasLift,
            },
          }
        : van,
    );

    const replanned = placeRiders(changed, day.riders, pins);
    const fresh = placeRiders(changed, day.riders, pins);
    expect(replanned).toEqual(fresh);
    // And it is a run on the *new* counts, not a patch of the old answer.
    for (const van of changed) {
      expect(fits(van.setup, ridersOf(day, replanned.byVan[van.id])), van.id).toBe(true);
    }
  });
});

describe("the pins a person set", () => {
  it.each(cases.slice(0, 50))("case %i keeps a pin that still fits, and explains one that does not", (seed) => {
    const day = makeDay(seed);
    if (day.riders.length === 0 || day.vans.length === 0) return;
    const rider = day.riders[0];
    for (const van of day.vans) {
      const result = placeRiders(day.vans, day.riders, { [rider.token]: van.id });
      const refused = rejectReason(van.setup, [], rider) !== null;
      if (refused) {
        // The van cannot take them at all, so they are unplaced — and the shortfall named is
        // that van's, against the riders it ends up with, not another van's.
        expect(result.vanOf[rider.token]).toBeNull();
        const unplaced = result.unplaced.find((one) => one.token === rider.token);
        const aboard = ridersOf(day, result.byVan[van.id]);
        expect(unplaced?.shortfall).toEqual(shortfalls(van.setup, [...aboard, rider])[0]);
      } else {
        expect(result.vanOf[rider.token]).toBe(van.id);
      }
    }
  });

  it("leaves a child pinned out of every van out of every van", () => {
    const day = makeDay(3);
    const rider = day.riders[0];
    const result = placeRiders(day.vans, day.riders, { [rider.token]: null });
    expect(result.vanOf[rider.token]).toBeNull();
    // Not a shortfall: nobody is short of anything, a person just took them out.
    expect(result.unplaced.some((one) => one.token === rider.token)).toBe(false);
  });
});

/**
 * (f) The founder's 7:17 PM ET addition: **a needs change is re-planned, not patched.**
 *
 * The child panel's Save writes three flags and then re-runs the plan on them. The property
 * that has to hold for that to be trustworthy is that re-planning a board whose needs have just
 * changed gives exactly the same answer as planning the same day from scratch with those needs —
 * same pins, same vans, same shortfalls. If it did not, a coordinator could get a different
 * plan by saving twice, or by reloading.
 */
describe("(f) re-planning after a needs change is a fresh run on the new needs", () => {
  it.each(cases)("case %i", (seed) => {
    const day = makeDay(seed);
    if (day.riders.length === 0 || day.vans.length === 0) return;
    const next = rng(seed * 2246822519 + 5);

    // Plan the day, then pin some of what it decided, the way a coordinator's drags would.
    const planned = placeRiders(day.vans, day.riders);
    const pins: Record<string, string | null> = {};
    for (const rider of day.riders) {
      if (next() < 0.3) pins[rider.token] = planned.vanOf[rider.token] ?? null;
    }

    // Somebody opens a child and changes what they need.
    const changed = day.riders[Math.floor(next() * day.riders.length)];
    const after: FitRider[] = day.riders.map((rider) =>
      rider.token === changed.token
        ? {
            ...rider,
            needs: {
              wheelchair: !rider.needs.wheelchair,
              carSeat: !rider.needs.carSeat,
              oxygen: !rider.needs.oxygen,
              nurse: rider.needs.nurse,
            },
          }
        : rider,
    );

    const replanned = placeRiders(day.vans, after, pins);
    const fresh = placeRiders(day.vans, after, pins);
    expect(replanned).toEqual(fresh);

    // And the answer is about the **new** needs: no van is over on any counter, and the child
    // whose needs changed is either on a van that can take them or named with a shortfall.
    for (const van of day.vans) {
      const aboard = replanned.byVan[van.id].map((token) => {
        const rider = after.find((candidate) => candidate.token === token);
        if (!rider) throw new Error("placed somebody who is not in the day");
        return rider;
      });
      expect(fits(van.setup, aboard), van.id).toBe(true);
    }
    const placedOn = replanned.vanOf[changed.token] ?? null;
    const listed = replanned.unplaced.some((one) => one.token === changed.token);
    // …unless a person pinned them out of every van, which is a decision and not a shortfall.
    const pinnedOut = changed.token in pins && pins[changed.token] === null;
    expect(placedOn !== null || listed || pinnedOut).toBe(true);
  });
});
