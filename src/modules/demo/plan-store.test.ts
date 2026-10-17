import { afterEach, describe, expect, it } from "vitest";
import { initialStages } from "@/domain/plan/stages";
import {
  clearSavedPlans,
  getSavedPlan,
  putSavedPlan,
  savedPlanKey,
  type SavedPlan,
} from "./plan-store";

/**
 * Where a saved plan is kept between the POST that made it and the GET that reads it back.
 *
 * The question this file answers is the one Veri's S1 turned on (2026-10-17): a plan put in
 * here comes out again whole — not just who is in which van, but the day it is a plan of — so
 * the screen that reloads can draw it instead of an empty day. The keying is the other half:
 * one plan per run, and the morning's is not the afternoon's.
 */
const STAGES = Object.fromEntries(
  Object.entries(initialStages("EVERY_RIDER_FITS")).map(([laneId, stage]) => [
    laneId,
    { vehicleKey: stage.vehicleKey, arrival: stage.arrival },
  ]),
);

function plan(over: Partial<SavedPlan> = {}): SavedPlan {
  return {
    scenario: "EVERY_RIDER_FITS",
    direction: "AM",
    stages: STAGES,
    measured: [],
    assignment: { V1: ["C7"], V2: [], V4: [] },
    savedAt: "2026-10-14T17:24:03.000Z",
    ...over,
  };
}

afterEach(() => clearSavedPlans());

describe("a plan goes in and comes back whole", () => {
  it("keeps the day as well as the assignment, so a screen can redraw it", () => {
    const kept = plan({
      stages: {
        ...STAGES,
        V1: { vehicleKey: "V3", arrival: "RAMP_CHECKED", rampLayoutId: "V3-L1" },
      },
      measured: ["C6"],
    });
    putSavedPlan(kept);
    // Every fact the screen needs to put the plan back: the lanes as they were described, the
    // chairs the ramp had measured, who was in which van, and the minute it was kept.
    expect(getSavedPlan("EVERY_RIDER_FITS", "AM")).toEqual(kept);
  });

  it("names no person: the driver stays on the screen on both sides of the wire", () => {
    putSavedPlan(plan());
    const read = JSON.stringify(getSavedPlan("EVERY_RIDER_FITS", "AM"));
    expect(read).not.toMatch(/driverName|Mia|Noah|Gus/);
  });

  it("is nothing at all until something is put there", () => {
    expect(getSavedPlan("EVERY_RIDER_FITS", "AM")).toBeNull();
    expect(getSavedPlan("ONE_RIDER_HAS_NO_VAN", "PM")).toBeNull();
  });
});

describe("one plan per run", () => {
  it("keys a plan by the run it is a plan of", () => {
    expect(savedPlanKey("EVERY_RIDER_FITS", "AM")).toBe("EVERY_RIDER_FITS/AM");
    expect(savedPlanKey("ONE_RIDER_HAS_NO_VAN", "PM")).toBe("ONE_RIDER_HAS_NO_VAN/PM");
  });

  it("keeps the runs apart: the morning's plan is not the afternoon's", () => {
    putSavedPlan(plan());
    putSavedPlan(plan({ direction: "PM", assignment: { V1: [], V2: ["C7"], V4: [] } }));
    expect(getSavedPlan("EVERY_RIDER_FITS", "AM")?.assignment).toEqual({
      V1: ["C7"],
      V2: [],
      V4: [],
    });
    expect(getSavedPlan("EVERY_RIDER_FITS", "PM")?.assignment).toEqual({
      V1: [],
      V2: ["C7"],
      V4: [],
    });
    // And neither is the other scenario's, which is a different fleet entirely.
    expect(getSavedPlan("ONE_RIDER_HAS_NO_VAN", "AM")).toBeNull();
  });

  it("replaces a run's plan rather than keeping two of them", () => {
    putSavedPlan(plan());
    const later = plan({ assignment: { V1: [], V2: ["C7"], V4: [] }, savedAt: "2026-10-14T18:00:00.000Z" });
    expect(putSavedPlan(later)).toEqual(later);
    expect(getSavedPlan("EVERY_RIDER_FITS", "AM")).toEqual(later);
  });

  it("forgets every one of them when the demo day is re-seeded", () => {
    putSavedPlan(plan());
    putSavedPlan(plan({ direction: "PM" }));
    clearSavedPlans();
    expect(getSavedPlan("EVERY_RIDER_FITS", "AM")).toBeNull();
    expect(getSavedPlan("EVERY_RIDER_FITS", "PM")).toBeNull();
  });
});
