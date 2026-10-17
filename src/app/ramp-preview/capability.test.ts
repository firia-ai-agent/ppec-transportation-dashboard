/** Ramp check helpers: checklist -> capability observation, solver verdict -> banner copy. */
import { describe, expect, it } from "vitest";
import { feasible } from "@/domain/solver";
import {
  ARRIVING_VEHICLES, C1, C2, C6_AT_RAMP, C7, C8, ROUTE2_PM, SERVICE_DATE, TWO_SEAT_CRISIS_AM, V1,
  V1_LAYOUT_1WC3A, V4, V4_LAYOUT_0WC3A, fullyAvailable,
} from "@/fixtures/fleet";
import { layoutName } from "@/ui/copy";
import type { Checklist } from "./capability";
import {
  availableSummary, bannerCopy, defaultChecklist, findingOfChecklist, needChips, needSummary,
  positionLabel, toCapability,
} from "./capability";
import {
  arrivedAsPlanned, decodeFinding, encodeFinding, observedCapability, rampArrivals,
} from "@/domain/plan/arrival";

const crisisChecklist: Checklist = {
  layoutId: V1_LAYOUT_1WC3A.id, lift: "YES", latch: "YES",
  positions: { "V1-L2-W1": "FREE", "V1-L2-A1": "FREE", "V1-L2-A2": "OUT", "V1-L2-A3": "OUT" },
};

describe("checklist to capability observation", () => {
  it("starts with nothing answered, so nothing is assumed", () => {
    const checklist = defaultChecklist(V1, V1_LAYOUT_1WC3A.id);
    const capability = toCapability(V1, checklist, SERVICE_DATE);
    expect(capability.liftOk).toBeNull();
    expect(capability.latchOk).toBeNull();
    expect(capability.unknownPositionIds).toHaveLength(V1_LAYOUT_1WC3A.positions.length);
    expect(feasible(V1, TWO_SEAT_CRISIS_AM, capability).status).toBe("CAPABILITY_PENDING");
  });

  it("maps Yes / No / Not sure onto the observation", () => {
    const capability = toCapability(V1, crisisChecklist, SERVICE_DATE);
    expect(capability).toMatchObject({
      vehicleId: "V1", serviceDate: SERVICE_DATE, state: "VERIFIED",
      observedLayoutId: V1_LAYOUT_1WC3A.id, liftOk: true, latchOk: true,
      unavailablePositionIds: ["V1-L2-A2", "V1-L2-A3"], unknownPositionIds: [],
    });
  });

  it("counts only what the ramp says is free", () => {
    expect(availableSummary(V1, crisisChecklist)).toEqual({ wc: 1, amb: 1, tether: 1 });
    expect(availableSummary(V1, { ...crisisChecklist, latch: "NO" }).tether).toBe(0);
  });
});

describe("what the run needs", () => {
  it("takes the peak over the manifest, escorts included", () => {
    expect(needSummary({ ...ROUTE2_PM, children: [C6_AT_RAMP, C7, C8] })).toEqual({ wc: 1, amb: 3, tether: 1 });
    expect(needSummary(TWO_SEAT_CRISIS_AM)).toEqual({ wc: 1, amb: 2, tether: 1 });
  });
});

describe("feasibility banner (COPY-GUIDE §5 SURF-04)", () => {
  it("says what fits", () => {
    const capability = fullyAvailable(V1, { observedLayoutId: V1_LAYOUT_1WC3A.id });
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, capability);
    const banner = bannerCopy(result, needSummary(TWO_SEAT_CRISIS_AM), { wc: 1, amb: 3, tether: 2 });
    expect(banner.tone).toBe("ok");
    expect(banner.title).toBe("Fits: 1 wheelchair, 2 walking seats (1 with an anchor).");
  });

  it("says what does not fit, with the numbers", () => {
    const capability = toCapability(V1, crisisChecklist, SERVICE_DATE);
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, capability);
    const banner = bannerCopy(result, needSummary(TWO_SEAT_CRISIS_AM), availableSummary(V1, crisisChecklist));
    expect(banner.tone).toBe("crit");
    expect(banner.title).toBe("Doesn't fit: needs 2 walking seats, has 1. Coordinator alerted.");
    expect(banner.detail).toBe("Found at stop 3.");
  });

  it("says when the answer is still unknown", () => {
    // Everything is free, but nobody has said whether the lift works, and a rider boards by lift.
    const checklist: Checklist = {
      layoutId: V1_LAYOUT_1WC3A.id, lift: "UNSURE", latch: "YES",
      positions: { "V1-L2-W1": "FREE", "V1-L2-A1": "FREE", "V1-L2-A2": "FREE", "V1-L2-A3": "FREE" },
    };
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, toCapability(V1, checklist, SERVICE_DATE));
    const banner = bannerCopy(result, needSummary(TWO_SEAT_CRISIS_AM), availableSummary(V1, checklist));
    expect(banner.tone).toBe("warn");
    expect(banner.title).toBe("Not checked yet.");
    expect(banner.detail).toMatch(/Lift not reported/);
  });

  it("uses plain words for a securement or footprint problem", () => {
    const leg = { ...ROUTE2_PM, children: [C6_AT_RAMP] , stops: ROUTE2_PM.stops.map((s) => ({
      ...s, boarding: (s.boarding ?? []).filter((t) => t === "C6"), alighting: (s.alighting ?? []).filter((t) => t === "C6"),
    })) };
    const result = feasible(V1, leg, fullyAvailable(V1, { observedLayoutId: V1_LAYOUT_1WC3A.id }));
    const banner = bannerCopy(result, needSummary(leg), { wc: 1, amb: 3, tether: 2 });
    expect(banner.title).toBe("Doesn't fit: a rider's chair is larger than the position allows. Coordinator alerted.");
  });

  it("names a vehicle that is out of service", () => {
    const result = feasible(V4, TWO_SEAT_CRISIS_AM, fullyAvailable(V4, { state: "UNAVAILABLE" }));
    expect(bannerCopy(result, { wc: 0, amb: 0, tether: 0 }, { wc: 0, amb: 0, tether: 0 }).title)
      .toBe("This vehicle is out of service today.");
  });
});

describe("rider and position labels", () => {
  it("describes needs, never a diagnosis", () => {
    expect(needChips(C2)).toEqual(["Uses a wheelchair · L-track", "Chair 110 × 70 cm"]);
    expect(needChips(C1)).toEqual(["Needs an anchored seat"]);
    expect(needChips(C8)).toEqual([]);
  });

  it("describes a position the way the ramp sees it", () => {
    expect(positionLabel(V1_LAYOUT_1WC3A.positions[0], 1))
      .toBe("Wheelchair position 1 · L-track · fits 122 × 76 cm");
    expect(positionLabel(V4_LAYOUT_0WC3A.positions[0], 1)).toBe("Walking seat 1 · has an anchor");
    expect(positionLabel(V4_LAYOUT_0WC3A.positions[2], 3)).toBe("Walking seat 3");
  });
});

describe("seat layouts in words (Vera's review)", () => {
  it("names the three V1 configurations exactly as the review asked", () => {
    expect(layoutName("0WC/6A")).toBe("No wheelchairs · 6 seats");
    expect(layoutName("1WC/3A")).toBe("1 wheelchair · 3 seats");
    expect(layoutName("2WC/1A")).toBe("2 wheelchairs · 1 seat");
  });

  it("says zero rather than counting it, and singulars at exactly one", () => {
    expect(layoutName("0WC/1A")).toBe("No wheelchairs · 1 seat");
    expect(layoutName("1WC/1A")).toBe("1 wheelchair · 1 seat");
  });

  it("names every layout the fixtures ship, so no button is left showing shorthand", () => {
    const codes = ARRIVING_VEHICLES.flatMap((a) => a.vehicle.layouts.map((l) => l.code));
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(layoutName(code), code).not.toBe(code);
      expect(layoutName(code), code).not.toMatch(/WC\//);
    }
  });

  it("hands back a shorthand it does not recognise, rather than an empty button", () => {
    expect(layoutName("FLATBED")).toBe("FLATBED");
  });

  it("the banner reads the words the button reads, not the shorthand", () => {
    const capability = toCapability(V1, crisisChecklist, SERVICE_DATE);
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, capability);
    const banner = bannerCopy(result, needSummary(TWO_SEAT_CRISIS_AM), availableSummary(V1, crisisChecklist));
    if (result.status === "FEASIBLE") {
      expect(banner.detail).toBe(`Checked as ${layoutName(V1_LAYOUT_1WC3A.code)}.`);
      expect(banner.detail).not.toMatch(/WC\//);
    }
  });
});

/**
 * The checklist as the finding the other two screens read.
 *
 * The whole of the join between the ramp iPad and the plan goes through this one function, so
 * it is checked over the *demo day's* own vans and children (src/domain/plan/arrival.ts), which
 * is what the iPad now shows — not the fleet fixtures the solver's own unit tests use.
 */
describe("checklist to a finding the plan and the board can read", () => {
  const arrival = rampArrivals()[0];
  const planned = defaultChecklist(arrival.vehicle, arrival.plannedLayoutId);
  const answered: Checklist = {
    ...planned,
    lift: "YES",
    latch: "YES",
    positions: Object.fromEntries(Object.keys(planned.positions).map((id) => [id, "FREE"])),
  };

  it("a van answered as arriving exactly as planned has nothing to report", () => {
    expect(findingOfChecklist(arrival, answered)).toEqual(
      arrivedAsPlanned(arrival),
    );
  });

  it("names the places by where they are in the configuration, not by their ids", () => {
    const ids = Object.keys(planned.positions);
    const finding = findingOfChecklist(arrival, {
      ...answered,
      positions: { ...answered.positions, [ids[2]]: "OUT", [ids[3]]: "UNSURE" },
    });
    expect(finding.outOfService).toEqual([3]);
    expect(finding.unanswered).toEqual([4]);
    // And the observation it produces names the ids again, so nothing is lost in the round trip.
    expect(observedCapability(finding).unavailablePositionIds).toEqual([ids[2]]);
    expect(observedCapability(finding).unknownPositionIds).toEqual([ids[3]]);
  });

  it("a checklist nobody has touched reports every place unanswered, and never as free", () => {
    const finding = findingOfChecklist(arrival, planned);
    expect(finding.unanswered).toHaveLength(Object.keys(planned.positions).length);
    expect(finding.outOfService).toEqual([]);
    expect(finding.liftOk).toBeNull();
    expect(finding.latchOk).toBeNull();
  });

  it("carries the configuration the ramp actually chose, not the one the manifest planned", () => {
    const other = arrival.vehicle.layouts.find((l) => l.id !== arrival.plannedLayoutId);
    const finding = findingOfChecklist(
      arrival,
      defaultChecklist(arrival.vehicle, other!.id),
    );
    expect(finding.layoutCode).toBe(other!.code);
  });

  it("only measures a chair that was in front of the ramp", () => {
    const onThisVan = arrival.riders[0].child.token;
    const finding = findingOfChecklist(arrival, answered, [onThisVan, "C2"]);
    expect(finding.measured).toEqual([onThisVan]);
  });

  it("is the same finding a link carries, so the plan re-plans what the iPad showed", () => {
    const finding = findingOfChecklist(arrival, {
      ...answered,
      positions: { ...answered.positions, [Object.keys(planned.positions)[2]]: "OUT" },
    });
    expect(decodeFinding(encodeFinding(finding))).toEqual(finding);
  });
});
