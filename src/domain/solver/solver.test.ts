/**
 * Capacity solver tests (PRD §7 l.784-800 test list, §9, AT-04, AT-05, AT-12).
 * Pure: no DB, no network, no clock.
 */
import { describe, expect, it } from "vitest";
import { feasible, onboardByStop } from "./feasible";
import type { Child, DailyCapability, Leg, Vehicle } from "./types";
import {
  ARRIVING_VEHICLES, C1, C2, C3, C4, C5, C6, C6_AT_RAMP, C7, C8, CRISIS_CAPABILITY, FLEET, ROUTE2_AM,
  SEDAN_AM, SERVICE_DATE, STOPS, TWO_SEAT_CRISIS_AM, V1, V1_LAYOUT_1WC3A, V2, V3, V4,
  fullyAvailable, unknownCapability,
} from "@/fixtures/fleet";

/** One pickup per stop in order, then the center. */
function pickupLeg(children: Child[], extra: { staffEscorts?: number } = {}): Leg {
  return {
    id: "LEG-TEST", direction: "AM",
    children,
    stops: [
      ...children.map((child, index) => ({
        k: index + 1, label: `Stop ${index + 1}`, boarding: [child.token],
        ...(index === 0 && extra.staffEscorts !== undefined ? { staffEscorts: extra.staffEscorts } : {}),
      })),
      { k: children.length + 1, label: STOPS.center, alighting: children.map((c) => c.token) },
    ],
  };
}

describe("onboardByStop", () => {
  it("builds On_k over the manifest sequence", () => {
    const occupancy = onboardByStop(ROUTE2_AM);
    expect(occupancy.map((o) => o.onboard.map((c) => c.token))).toEqual([
      ["C6"], ["C6", "C7"], ["C6", "C7", "C8"], [],
    ]);
  });

  it("rejects a manifest that contradicts itself", () => {
    expect(() => onboardByStop({ ...pickupLeg([C1]), stops: [{ k: 1, label: "Stop 1", alighting: ["C1"] }] }))
      .toThrow(/not onboard/);
    expect(() => onboardByStop({ ...pickupLeg([C1]), stops: [{ k: 1, label: "Stop 1", boarding: ["C9"] }] }))
      .toThrow(/not on the roster/);
  });
});

describe("two-seat crisis (PRD §7 l.800, AT-04, demo step 6)", () => {
  it("needs {1WC, 2AMB}, the ramp observes {1WC, 1AMB} → INFEASIBLE, deficit 1 ambulatory seat", () => {
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, CRISIS_CAPABILITY);
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 3, type: "AMBULATORY_SEAT", count: 1 });
    expect(result.layout).toBeNull();
    expect(result.plan).toEqual([]);
    expect(result.severity).toBe("RED");
    expect(result.autoAssigned).toBe(false);
  });

  it("offers the center van and leaves the choice to a coordinator", () => {
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, CRISIS_CAPABILITY, {
      alternates: [{ vehicle: V2, capability: fullyAvailable(V2) }],
    });
    const moved = result.options.find((o) => o.candidateVehicleId === V2.id);
    expect(moved?.kind).toBe("ALTERNATE_PROVIDER"); // V2 belongs to the center, not provider P1
    expect(moved?.candidateLayoutCode).toBe("1WC/4A");
    // Only the rider who boards at the failing stop is proposed for the other vehicle.
    expect(moved?.affectedChildTokens).toEqual(["C8"]);
    expect(result.options.every((o) => o.requiresApproval)).toBe(true);
  });

  it("ranks the options in PRD order", () => {
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, CRISIS_CAPABILITY, {
      alternates: [{ vehicle: V2, capability: fullyAvailable(V2) }],
    });
    expect(result.options.map((o) => o.kind)).toEqual([
      "SPLIT_RUN", "ALTERNATE_PROVIDER", "FAMILY_TRANSPORT", "DELAY", "CANCEL",
    ]);
    expect(result.options.map((o) => o.rank)).toEqual([...result.options.map((o) => o.rank)].sort((a, b) => a - b));
  });

  it("is deterministic", () => {
    const a = feasible(V1, TWO_SEAT_CRISIS_AM, CRISIS_CAPABILITY, { alternates: [{ vehicle: V2, capability: fullyAvailable(V2) }] });
    const b = feasible(V1, TWO_SEAT_CRISIS_AM, CRISIS_CAPABILITY, { alternates: [{ vehicle: V2, capability: fullyAvailable(V2) }] });
    expect(a).toEqual(b);
  });
});

describe("never propose removing a boarded child (PRD §7 l.800, §9 l.880)", () => {
  it("proposes only riders who have not boarded", () => {
    const leg: Leg = {
      ...TWO_SEAT_CRISIS_AM,
      children: [{ ...C2, boarded: true }, { ...C7, boarded: true }, C8],
    };
    const result = feasible(V1, leg, CRISIS_CAPABILITY, { alternates: [{ vehicle: V2, capability: fullyAvailable(V2) }] });
    expect(result.status).toBe("INFEASIBLE");
    expect(result.boardedChildTokens).toEqual(["C2", "C7"]);
    for (const option of result.options) {
      expect(option.affectedChildTokens).not.toContain("C2");
      expect(option.affectedChildTokens).not.toContain("C7");
    }
    expect(result.options.some((o) => o.kind === "SPLIT_RUN" && o.affectedChildTokens.includes("C8"))).toBe(true);
  });

  it("still offers a delay when every rider has already boarded", () => {
    const leg: Leg = { ...TWO_SEAT_CRISIS_AM, children: TWO_SEAT_CRISIS_AM.children.map((c) => ({ ...c, boarded: true })) };
    const result = feasible(V1, leg, CRISIS_CAPABILITY);
    expect(result.status).toBe("INFEASIBLE");
    expect(result.options.map((o) => o.kind)).toEqual(["DELAY", "CANCEL"]);
    expect(result.options.every((o) => o.affectedChildTokens.length === 0)).toBe(true);
  });
});

describe("substitution (AT-05)", () => {
  it("feasible → substituted → UNKNOWN → re-request → re-solve", () => {
    const planned = feasible(V1, ROUTE2_AM, fullyAvailable(V1));
    expect(planned.status).toBe("FEASIBLE");
    expect(planned.layout?.code).toBe("1WC/3A");

    // The provider swaps in V3. Nothing about the new vehicle is known, so nothing is assumed.
    const substituted: DailyCapability = { ...unknownCapability(V3.id), state: "CHANGED" };
    const afterSwap = feasible(V3, ROUTE2_AM, substituted);
    expect(afterSwap.status).toBe("CAPABILITY_PENDING");
    expect(afterSwap.severity).toBe("AMBER");
    expect(afterSwap.layout).toBeNull();

    // Re-request: still unknown until the dispatcher reports.
    const requested = feasible(V3, ROUTE2_AM, { ...substituted, state: "REQUESTED" });
    expect(requested.status).toBe("CAPABILITY_PENDING");

    // Reported: now it can be solved, and the substitute cannot take this run.
    const reported = feasible(V3, ROUTE2_AM, fullyAvailable(V3, { state: "REPORTED" }));
    expect(reported.status).toBe("INFEASIBLE");
    expect(reported.deficit).toEqual({ k: 1, type: "WC_SECUREMENT", count: 1 });
  });
});

describe("no feasible vehicle (AT-12)", () => {
  it("goes RED, assigns nothing, and every option needs a human", () => {
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, CRISIS_CAPABILITY, {
      alternates: [
        // Both alternates are already carrying their own run today, so neither can take the rider.
        { vehicle: V3, capability: fullyAvailable(V3, { state: "REPORTED" }), leg: pickupLeg([C3]) },
        { vehicle: V4, capability: fullyAvailable(V4), leg: pickupLeg([C1, C3, C4]) },
        { vehicle: V2, capability: unknownCapability(V2.id) }, // not reported yet, so never offered
      ],
    });
    expect(result.status).toBe("INFEASIBLE");
    expect(result.severity).toBe("RED");
    expect(result.autoAssigned).toBe(false);
    expect(result.layout).toBeNull();
    expect(result.plan).toEqual([]);
    expect(result.options.every((o) => o.requiresApproval && o.approverRole === "COORDINATOR")).toBe(true);
    expect(result.options.some((o) => o.candidateVehicleId !== undefined)).toBe(false);
    expect(result.options.map((o) => o.kind)).toEqual(["SPLIT_RUN", "FAMILY_TRANSPORT", "DELAY", "CANCEL"]);
  });

  it("a vehicle taken out of service today is never feasible", () => {
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, fullyAvailable(V1, { state: "UNAVAILABLE" }));
    expect(result.status).toBe("VEHICLE_UNAVAILABLE");
    expect(result.severity).toBe("RED");
    expect(result.options.length).toBeGreaterThan(0);
  });
});

describe("a deficit is reported at the stop where it appears", () => {
  it("reports k = 3 when stops 1 and 2 fit", () => {
    const capability = fullyAvailable(V4, { unavailablePositionIds: ["V4-L1-A2"] });
    const result = feasible(V4, SEDAN_AM, capability);
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 3, type: "AMBULATORY_SEAT", count: 1 });
  });

  it("reports k = 1 when the first stop already fails", () => {
    const result = feasible(V4, pickupLeg([C2]), fullyAvailable(V4));
    expect(result.deficit).toEqual({ k: 1, type: "WC_POSITION", count: 1 });
  });
});

describe("layouts V1-V4 (PRD §18.1 l.1328)", () => {
  it("V1 picks 0WC/6A for a run of walking riders", () => {
    const result = feasible(V1, pickupLeg([C1, C3, C4, C5, C8]), fullyAvailable(V1));
    expect(result.status).toBe("FEASIBLE");
    expect(result.layout?.code).toBe("0WC/6A");
  });

  it("V1 picks 1WC/3A for one wheelchair and two walking riders", () => {
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, fullyAvailable(V1));
    expect(result.status).toBe("FEASIBLE");
    expect(result.layout?.code).toBe("1WC/3A");
    expect(result.plan.at(-2)?.ambulatorySeatsUsed).toBe(2);
  });

  it("V1 picks 2WC/1A for two wheelchair riders", () => {
    const result = feasible(V1, pickupLeg([C2, C6]), fullyAvailable(V1));
    expect(result.status).toBe("FEASIBLE");
    expect(result.layout?.code).toBe("2WC/1A");
    // Injective: the two chairs get different positions.
    const last = result.plan.at(-2);
    expect(new Set(last?.wcAssignments.map((a) => a.positionId)).size).toBe(2);
  });

  it("V2 center van carries one wheelchair and four walking riders", () => {
    const result = feasible(V2, pickupLeg([C2, C1, C3, C4, C8]), fullyAvailable(V2));
    expect(result.status).toBe("FEASIBLE");
    expect(result.layout?.code).toBe("1WC/4A");
  });

  it("V3 substitute carries one chair of its own securement type plus one walking rider", () => {
    const chair: Child = { ...C2, securement: "SLIDE_N_CLICK" };
    const result = feasible(V3, pickupLeg([chair, C3]), fullyAvailable(V3, { state: "REPORTED" }));
    expect(result.status).toBe("FEASIBLE");
    expect(result.layout?.code).toBe("1WC/1A");
  });

  it("V4 sedan carries three walking riders and no wheelchair", () => {
    expect(feasible(V4, SEDAN_AM, fullyAvailable(V4)).status).toBe("FEASIBLE");
    expect(feasible(V4, pickupLeg([C6]), fullyAvailable(V4)).status).toBe("INFEASIBLE");
  });

  it("layout is fixed per leg when the manifest pins one (ASM-17)", () => {
    const leg: Leg = { ...TWO_SEAT_CRISIS_AM, layoutId: "V1-L3" }; // 2WC/1A
    const result = feasible(V1, leg, fullyAvailable(V1));
    expect(result.attempts.map((a) => a.layoutCode)).toEqual(["2WC/1A"]);
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 3, type: "AMBULATORY_SEAT", count: 1 });
  });
});

describe("constraint 1: securement and footprint", () => {
  it("securement type must be equal, never merely similar", () => {
    const result = feasible(V3, pickupLeg([C2]), fullyAvailable(V3, { state: "REPORTED" }));
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 1, type: "WC_SECUREMENT", count: 1 });
  });

  it("a chair measured bigger at the ramp does not fit (AT-04)", () => {
    const leg: Leg = { ...ROUTE2_AM, children: [C6_AT_RAMP, C7, C8] };
    const result = feasible(V1, leg, { ...fullyAvailable(V1), observedLayoutId: V1_LAYOUT_1WC3A.id }, {
      alternates: [{ vehicle: V2, capability: fullyAvailable(V2) }],
    });
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 1, type: "WC_FOOTPRINT", count: 1 });
    // The same chair fits the center van, so moving that rider is offered.
    const moved = result.options.find((o) => o.candidateVehicleId === V2.id);
    expect(moved?.affectedChildTokens).toEqual(["C6"]);
    expect(feasible(V2, { ...ROUTE2_AM, children: [C6_AT_RAMP] , stops: ROUTE2_AM.stops.map((s) => ({
      ...s, boarding: (s.boarding ?? []).filter((t) => t === "C6"), alighting: (s.alighting ?? []).filter((t) => t === "C6"),
    })) }, fullyAvailable(V2)).status).toBe("FEASIBLE");
  });

  it("two chairs cannot share one position", () => {
    const result = feasible(V2, pickupLeg([C2, { ...C6, escort: false }]), fullyAvailable(V2));
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 2, type: "WC_POSITION", count: 1 });
  });
});

describe("constraint 2: ambulatory seats count escorts and staff", () => {
  it("an escort takes a seat", () => {
    const withEscort = pickupLeg([{ ...C6, escort: true }, C7, C8, C1]);
    const result = feasible(V1, withEscort, { ...fullyAvailable(V1), observedLayoutId: V1_LAYOUT_1WC3A.id });
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 4, type: "AMBULATORY_SEAT", count: 1 });
  });

  it("staff riding along take seats too", () => {
    const leg = pickupLeg([C2, C7, C8], { staffEscorts: 2 });
    const result = feasible(V1, leg, { ...fullyAvailable(V1), observedLayoutId: V1_LAYOUT_1WC3A.id });
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 3, type: "AMBULATORY_SEAT", count: 1 });
  });
});

describe("constraint 3: tether / LATCH seats", () => {
  it("counts riders who need an anchored seat", () => {
    const result = feasible(V4, pickupLeg([C1, C4, C5]), fullyAvailable(V4));
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 3, type: "TETHER_SEAT", count: 1 });
  });

  it("anchors reported broken empty the anchored seats", () => {
    const result = feasible(V4, pickupLeg([C1]), fullyAvailable(V4, { latchOk: false }));
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 1, type: "TETHER_SEAT", count: 1 });
  });

  it("anchors not reported are unknown, not feasible", () => {
    const result = feasible(V4, pickupLeg([C1]), fullyAvailable(V4, { latchOk: null }));
    expect(result.status).toBe("CAPABILITY_PENDING");
    expect(result.pendingReason).toMatch(/LATCH/);
  });
});

describe("constraint 4: lift", () => {
  it("a broken lift blocks a wheelchair rider", () => {
    const result = feasible(V1, ROUTE2_AM, fullyAvailable(V1, { liftOk: false }));
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficit).toEqual({ k: 1, type: "LIFT", count: 1 });
  });

  it("a broken lift does not block a run of walking riders", () => {
    const result = feasible(V1, pickupLeg([C1, C3, C8]), fullyAvailable(V1, { liftOk: false }));
    expect(result.status).toBe("FEASIBLE");
    expect(result.layout?.code).toBe("0WC/6A");
  });

  it("a vehicle with no lift cannot board a wheelchair in a lift-only layout", () => {
    const result = feasible(
      { ...V4, layouts: [{ ...V1_LAYOUT_1WC3A, id: "V4-L2" }] },
      pickupLeg([C2]),
      fullyAvailable({ ...V4, layouts: [{ ...V1_LAYOUT_1WC3A, id: "V4-L2" }] }),
    );
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficits.map((d) => d.type)).toContain("LIFT");
  });

  it("a lift not reported yet is unknown, not feasible", () => {
    const result = feasible(V1, ROUTE2_AM, fullyAvailable(V1, { liftOk: null }));
    expect(result.status).toBe("CAPABILITY_PENDING");
    expect(result.pendingReason).toMatch(/Lift not reported/);
  });
});

describe("unknown capability is never feasible (PRD §7 l.797, §9)", () => {
  it("nothing reported for the day", () => {
    const result = feasible(V1, ROUTE2_AM, unknownCapability(V1.id));
    expect(result.status).toBe("CAPABILITY_PENDING");
    expect(result.severity).toBe("AMBER");
    expect(result.layout).toBeNull();
    expect(result.options).toEqual([]);
  });

  it("“Not sure” on a position that would decide the answer", () => {
    const capability = fullyAvailable(V1, {
      observedLayoutId: V1_LAYOUT_1WC3A.id,
      unavailablePositionIds: ["V1-L2-A3"],
      unknownPositionIds: ["V1-L2-A2"],
    });
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, capability);
    expect(result.status).toBe("CAPABILITY_PENDING");
    expect(result.pendingReason).toMatch(/Not sure/);
  });

  it("“Not sure” on a position that cannot change the answer still leaves a deficit", () => {
    const capability = fullyAvailable(V1, {
      observedLayoutId: V1_LAYOUT_1WC3A.id,
      unavailablePositionIds: ["V1-L2-A2", "V1-L2-A3"],
      unknownPositionIds: ["V1-L2-W1"],
    });
    const result = feasible(V1, TWO_SEAT_CRISIS_AM, capability);
    expect(result.status).toBe("INFEASIBLE");
    expect(result.deficits.map((d) => d.type)).toContain("AMBULATORY_SEAT");
  });

  it("refuses a capability row for a different vehicle", () => {
    expect(() => feasible(V1, ROUTE2_AM, unknownCapability(V2.id))).toThrow(/not V1/);
  });
});

describe("fixtures", () => {
  it("are synthetic and self-consistent", () => {
    expect(new Set(FLEET.map((v) => v.id)).size).toBe(FLEET.length);
    for (const vehicle of FLEET) {
      expect(vehicle.layouts.length).toBeGreaterThan(0);
      const ids = vehicle.layouts.flatMap((l) => l.positions.map((p) => p.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(SERVICE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("every ramp arrival solves without throwing", () => {
    for (const arrival of ARRIVING_VEHICLES) {
      const capability = fullyAvailable(arrival.vehicle, { observedLayoutId: arrival.plannedLayoutId });
      expect(["FEASIBLE", "INFEASIBLE", "CAPABILITY_PENDING"]).toContain(
        feasible(arrival.vehicle, arrival.leg, capability).status,
      );
    }
  });
});

const everyVehicle: Vehicle[] = FLEET;
describe("capability states", () => {
  it("only an observed capability can be feasible", () => {
    for (const vehicle of everyVehicle) {
      for (const state of ["UNKNOWN", "REQUESTED", "CHANGED", "REJECTED", "UNAVAILABLE"] as const) {
        const result = feasible(vehicle, pickupLeg([C3]), fullyAvailable(vehicle, { state }));
        expect(result.status).not.toBe("FEASIBLE");
      }
    }
  });
});
