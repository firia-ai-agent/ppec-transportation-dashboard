/**
 * Acceptance-shaped tests for the M5 location/ETA engine: AT-03 (traffic delay,
 * downstream only, hysteresis, deterministic replay), AT-10 (geofence ≠ handoff) and
 * AT-11 (duplicate / out-of-order points, 180 s / 600 s location loss), plus PRD §18.2
 * steps 7–8 read as a demo rehearsal.
 *
 * These are PASS (mock) evidence only (founder lock ADR-016 / BUILD-PLAN §2): the whole
 * run is synthetic, nothing is sent and nothing is written to a database.
 */

import { describe, expect, it } from "vitest";
import {
  DEMO_RUNS,
  DEMO_RUN_SECONDS,
  RUN_GPS_GAP,
  RUN_JITTER,
  RUN_STALL,
  RUN_UNBOUND,
  SCENARIO_START_MS,
  UNBOUND_ROUTE,
  VAN3_ROUTE,
} from "@/fixtures/replays";
import { ROUTE_1, ROUTE_2 } from "@/fixtures/routes";
import { GPS_LOST_SECONDS, GPS_STALE_SECONDS } from "@/domain/location/freshness";
import { distanceM } from "@/domain/location/geo";
import {
  frameAt,
  lastCalcAt,
  legStateLabel,
  runReplay,
  shortestTurn,
  type ReplayResult,
} from "./replay";

const START = SCENARIO_START_MS;
const sec = (ms: number) => (ms - START) / 1000;

/** Stall run, used by most of the AT-03 assertions. */
const stall = runReplay(RUN_STALL);
const gap = runReplay(RUN_GPS_GAP);
const jitter = runReplay(RUN_JITTER);

/**
 * The stall run is R1's morning (src/fixtures/routes.ts): Palm Beach State College, the Lantana
 * library, Boynton Beach Mall, the centre. Named here by what they are to the run, so an
 * assertion reads as a claim about the demo rather than about a fixture id.
 */
const ORIGIN = RUN_STALL.route.stops[0].id;
const NEXT_PICKUP = RUN_STALL.route.stops[1].id;
const LAST_PICKUP = RUN_STALL.route.stops[2].id;

function notifiedWindows(result: ReplayResult, stopId: string): string[] {
  return result.calcs.map((c) => c.publishedWindows[stopId] ?? "—");
}

/** The windows a stop's family was given over the run, in order, without the repeats. */
function publishedWindowRun(result: ReplayResult, stopId: string): string[] {
  const windows: string[] = [];
  for (const window of notifiedWindows(result, stopId)) {
    if (window !== "—" && window !== windows[windows.length - 1]) windows.push(window);
  }
  return windows;
}

describe("AT-03 · a replayed stall moves one window, for downstream families only", () => {
  it("produces exactly one notification decision for the whole run", () => {
    expect(stall.notifications).toHaveLength(1);
  });

  it("sends it to the downstream family, with a damped 10-minute window", () => {
    const [decision] = stall.notifications;
    // The run's third pickup: the one still more than ten minutes away when the stall matures
    // (ASM-14), and F7 is the family who rides from Boynton Beach Mall in the scenario.
    expect(decision.stopId).toBe(LAST_PICKUP);
    expect(decision.familyLabel).toBe("F7");
    expect(decision.shiftText).toBe("+12 min");
    expect(decision.windowText).toBe("8:10–8:20 AM");
    expect(decision.windowEndMs! - decision.windowStartMs!).toBe(600_000);
    // Damped: it arrives minutes into the stall, not on the first slipped calculation.
    expect(sec(decision.atMs)).toBeGreaterThan(600);
  });

  it("never notifies about the stop the vehicle has already left", () => {
    const upstream = stall.decisions.filter((d) => d.stopId === ORIGIN);
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((d) => d.outcome === "SUPPRESS")).toBe(true);
    expect(stall.notifications.map((d) => d.stopId)).not.toContain(ORIGIN);
  });

  it("never notifies about a stop closer than ten minutes, however far the ETA slips", () => {
    // ASM-14's lead rule, which the regenerated geometry makes visible: the stall lands on the
    // first leg, so the next pickup is minutes away throughout and is never texted — the family
    // the van is about to reach is the one a text cannot help.
    const close = stall.decisions.filter((d) => d.stopId === NEXT_PICKUP);
    expect(close.length).toBeGreaterThan(0);
    expect(close.some((d) => d.reason === "too-close")).toBe(true);
    expect(stall.notifications.map((d) => d.stopId)).not.toContain(NEXT_PICKUP);
  });

  it("notifies no family about the center drop", () => {
    expect(stall.notifications.map((d) => d.stopId)).not.toContain("CENTER");
  });

  it("publishes exactly one new window for the downstream stop: before the stall, and after it", () => {
    const windows = new Set(notifiedWindows(stall, LAST_PICKUP).filter((w) => w !== "—"));
    expect([...windows]).toEqual(["7:50–8:00 AM", "8:10–8:20 AM"]);
  });

  it("recomputes on the ASM-11 triggers, including while the vehicle stands still", () => {
    const triggers = new Set(stall.calcs.map((c) => c.trigger));
    expect(triggers.has("initial")).toBe(true);
    expect(triggers.has("position")).toBe(true);
    expect(triggers.has("stop-completion")).toBe(true);
    // 30 s debounce: no two calculations closer together than that.
    for (let i = 1; i < stall.calcs.length; i += 1) {
      expect(stall.calcs[i].atMs - stall.calcs[i - 1].atMs).toBeGreaterThanOrEqual(30_000);
    }
  });

  it("explains every suppression with a reason, so the demo can show its work", () => {
    for (const decision of stall.decisions) {
      expect(decision.reason).toBeTruthy();
      if (decision.outcome === "NOTIFY") expect(decision.reason).toBe("shift-persisted");
    }
  });
});

describe("AT-03 · an injected traffic band also moves the window, by itself", () => {
  const slow = runReplay({ ...RUN_STALL, faults: [], injectedTrafficMultiplier: 1.5 });

  it("multiplies the committed durations by band × fault", () => {
    expect(slow.trafficMultiplier).toBeCloseTo(1.25 * 1.5, 10);
    expect(stall.trafficMultiplier).toBeCloseTo(1.25, 10);
  });

  it("predicts a later arrival than the same run without the fault", () => {
    const plain = runReplay({ ...RUN_STALL, faults: [] });
    const firstDrive = (r: ReplayResult) =>
      r.calcs[0].snapshot.stops.find((s) => s.stopId === "CENTER")!.driveSeconds!;
    // The whole difference is the ×1.5 fault on the committed leg duration.
    expect(firstDrive(slow) / firstDrive(plain)).toBeCloseTo(1.5, 6);
    expect(firstDrive(slow) - firstDrive(plain)).toBeGreaterThan(400);
  });
});

describe("AT-03 · jitter moves the marker and not the ETA text", () => {
  const clean = runReplay({ ...RUN_JITTER, faults: [] });

  it("notifies nobody", () => {
    expect(jitter.notifications).toHaveLength(0);
  });

  it("publishes the same window as the run without jitter", () => {
    // The windows a family holds, in order, with the repeats a recalculation leaves behind
    // dropped: jitter moves the ASM-11 position triggers, so the two runs recompute a different
    // number of times, and "the same window" is a claim about the text and not about the count.
    expect(publishedWindowRun(jitter, "CENTER")).toEqual(publishedWindowRun(clean, "CENTER"));
  });

  it("does move the reported positions, by up to 40 m", () => {
    const offsets = jitter.accepted.map((p, i) =>
      distanceM([p.lon, p.lat], [clean.accepted[i].lon, clean.accepted[i].lat]),
    );
    expect(Math.max(...offsets)).toBeGreaterThan(10);
    expect(Math.max(...offsets)).toBeLessThan(60);
  });

  /**
   * Compared calculation by calculation at the instants the two runs *share*. Jitter moves the
   * ASM-11 position triggers around, so the two runs do not recompute in lockstep — and comparing
   * the nth calculation of one against the nth of the other compares two different moments of the
   * drive, which is a measurement artefact rather than an ETA that moved.
   */
  it("keeps the ETA within a few seconds of the clean run at every shared calculation", () => {
    const etaOf = (r: ReplayResult, atMs: number) =>
      r.calcs.find((c) => c.atMs === atMs)?.snapshot.stops.find((s) => s.stopId === "CENTER")
        ?.etaMs;
    let compared = 0;
    for (const calc of clean.calcs) {
      const a = etaOf(jitter, calc.atMs);
      const b = etaOf(clean, calc.atMs);
      if (a === undefined || b === undefined) continue;
      compared += 1;
      expect(Math.abs(a - b), `at +${Math.round(calc.simSeconds)} s`).toBeLessThan(30_000);
    }
    // The shared instants are the initial calculation, the stop completions and the 5-minute
    // periods; a run that had drifted into sharing almost none would make this vacuous.
    expect(compared).toBeGreaterThanOrEqual(10);
  });

  /**
   * The ambiguity the regenerated geometry brought with it: R1's morning collects a child at the
   * Lantana library and leaves the way it came, so one stretch of Lantana Rd is driven twice and
   * a position on it has two chainages, kilometres apart. Projected without the hint
   * (`projectToPath`'s `nearM`), a ±40 m wobble flips between them and the ETA moves by the time
   * it takes to drive the loop again.
   */
  it("never reads a position as being on the pass of the road the van already drove", () => {
    const worstBackwards = (result: ReplayResult) =>
      result.calcs.reduce(
        (worst, calc, i) =>
          i === 0 ? worst : Math.max(worst, result.calcs[i - 1].alongM - calc.alongM),
        0,
      );
    // A run whose positions are where the simulator put them never goes backwards at all.
    for (const result of [clean, stall, gap]) {
      expect(worstBackwards(result), result.spec.route.id).toBe(0);
    }
    // Under the ±40 m fault it can wobble at a turnaround, where the two passes of the road are
    // a few hundred metres apart in chainage — never the 3.5 km back to the Lantana Rd pass,
    // which is the reading that moved the ETA by nine minutes.
    expect(worstBackwards(jitter)).toBeLessThan(500);
  });
});

describe("AT-03 · replay is deterministic", () => {
  it("gives byte-identical decisions for the same seed", () => {
    expect(runReplay(RUN_STALL).decisions).toEqual(stall.decisions);
    expect(runReplay(RUN_GPS_GAP).decisions).toEqual(gap.decisions);
  });

  it("gives identical positions and calculations for the same seed", () => {
    const again = runReplay(RUN_JITTER);
    expect(again.accepted).toEqual(jitter.accepted);
    expect(again.calcs).toEqual(jitter.calcs);
  });

  it("changes the positions but not the published windows when the seed changes", () => {
    const other = runReplay({ ...RUN_JITTER, seed: 1234 });
    expect(other.accepted).not.toEqual(jitter.accepted);
    expect(publishedWindowRun(other, "CENTER")).toEqual(publishedWindowRun(jitter, "CENTER"));
  });
});

describe("AT-11 · duplicate and out-of-order points", () => {
  it("drops them at ingest instead of letting them reach the ETA engine", () => {
    const counts = gap.ingest.devices[RUN_GPS_GAP.route.deviceId].counts;
    expect(counts.duplicate).toBe(2);
    expect(counts.outOfOrder).toBe(1);
    expect(gap.accepted).toHaveLength(gap.run.points.length - 3);
  });

  it("keeps the accepted stream strictly increasing in recorded_at", () => {
    for (let i = 1; i < gap.accepted.length; i += 1) {
      expect(gap.accepted[i].recordedAtMs).toBeGreaterThan(gap.accepted[i - 1].recordedAtMs);
    }
  });
});

describe("AT-11 · location loss: 180 s stale, 600 s exception", () => {
  it("suppresses ETA texts once the gap passes 180 s (LOC-03)", () => {
    const stale = gap.decisions.filter((d) => d.reason === "gps-stale");
    expect(stale.length).toBeGreaterThan(0);
    for (const decision of stale) {
      const calc = lastCalcAt(gap, decision.atMs)!;
      expect(calc.gpsAgeSeconds).toBeGreaterThanOrEqual(GPS_STALE_SECONDS);
    }
    expect(gap.notifications).toHaveLength(0);
  });

  it("raises exactly one exception, with a dispatcher ping, at 600 s", () => {
    expect(gap.exceptions).toHaveLength(1);
    const [exception] = gap.exceptions;
    expect(exception.deviceId).toBe(RUN_GPS_GAP.route.deviceId);
    expect(exception.dispatcherPing).toBe(true);
    const gapStart = 180;
    expect(sec(exception.raisedAtMs)).toBeGreaterThanOrEqual(gapStart + GPS_LOST_SECONDS);
    expect(sec(exception.raisedAtMs)).toBeLessThan(gapStart + GPS_LOST_SECONDS + 60);
  });

  it("closes the exception when positions come back", () => {
    expect(gap.exceptions[0].recoveredAtMs).toBeDefined();
    expect(sec(gap.exceptions[0].recoveredAtMs!)).toBeGreaterThan(sec(gap.exceptions[0].raisedAtMs));
  });

  it("raises no exception on a run that never loses GPS", () => {
    expect(stall.exceptions).toHaveLength(0);
    expect(jitter.exceptions).toHaveLength(0);
  });

  it("walks the bands in order while the gap runs", () => {
    const bandAt = (s: number) => frameAt(gap, START + s * 1000).band;
    expect(bandAt(170)).toBe("fresh");
    expect(bandAt(180 + 90)).toBe("aging");
    expect(bandAt(180 + 200)).toBe("stale");
    expect(bandAt(180 + 620)).toBe("lost");
    expect(bandAt(900)).toBe("fresh");
  });
});

describe("AT-10 · a geofence never completes a handoff", () => {
  it("records ARRIVED_PICKUP at the pickup and ARRIVED_DROPOFF at the center", () => {
    expect(stall.arrivals.map((a) => `${a.stopId}:${a.state}`)).toEqual([
      `${NEXT_PICKUP}:ARRIVED_PICKUP`,
      `${LAST_PICKUP}:ARRIVED_PICKUP`,
      "CENTER:ARRIVED_DROPOFF",
    ]);
  });

  it("produces no state other than the two ARRIVED_* on any demo run", () => {
    for (const run of DEMO_RUNS) {
      for (const arrival of runReplay(run.spec).arrivals) {
        expect(["ARRIVED_PICKUP", "ARRIVED_DROPOFF"]).toContain(arrival.state);
      }
    }
  });

  it("arrives within the 100 m geofence, after the vehicle has stopped", () => {
    for (const arrival of stall.arrivals) {
      expect(arrival.distanceM).toBeLessThanOrEqual(100);
    }
  });
});

describe("LOC-01 · an unbound device is stored and displayed nowhere", () => {
  const unbound = runReplay(RUN_UNBOUND);

  it("ingests every point as unbound and accepts none", () => {
    const device = unbound.ingest.devices[UNBOUND_ROUTE.deviceId];
    expect(device.counts.accepted).toBe(0);
    expect(device.counts.unbound).toBe(unbound.run.points.length);
    expect(device.latest).toBeUndefined();
    expect(unbound.accepted).toHaveLength(0);
  });

  it("computes no ETA and decides nothing", () => {
    expect(unbound.calcs).toHaveLength(0);
    expect(unbound.decisions).toHaveLength(0);
  });

  it("reads as a location loss, and its frame is marked hidden", () => {
    expect(unbound.exceptions).toHaveLength(1);
    const frame = frameAt(unbound, START + 60_000);
    expect(frame.hidden).toBe(true);
    expect(frame.band).toBe("lost");
    expect(frame.stops).toHaveLength(0);
  });
});

describe("frames (what the map pane reads)", () => {
  it("tweens along the route geometry between 5 s points", () => {
    const a = frameAt(stall, START + 300_000);
    const b = frameAt(stall, START + 302_500);
    const c = frameAt(stall, START + 305_000);
    expect(b.drivenM).toBeGreaterThanOrEqual(a.drivenM);
    expect(b.drivenM).toBeLessThanOrEqual(c.drivenM);
  });

  it("snaps to the last reported point when motion is reduced (§5.1, §9)", () => {
    const reduced = frameAt(stall, START + 1_002_500, false);
    const snapped = frameAt(stall, START + 1_000_000, false);
    expect(reduced.coord).toEqual(snapped.coord);
  });

  it("reports how long a stalled vehicle has been stopped (§5.1 'Stopped 3 min')", () => {
    // The stall runs from 00:02 for 12 minutes.
    expect(frameAt(stall, START + 100_000).stoppedSeconds).toBe(0);
    expect(frameAt(stall, START + 480_000).stoppedSeconds).toBeGreaterThan(300);
  });

  it("shows the published window, not the raw ETA, and only for pending stops", () => {
    const frame = frameAt(stall, START + 900_000);
    const ahead = frame.stops.find((s) => s.stopId === LAST_PICKUP)!;
    expect(ahead.status).toBe("pending");
    expect(ahead.windowText).toBe("8:10–8:20 AM");
    expect(frame.stops.find((s) => s.stopId === ORIGIN)!.status).toBe("passed");
  });

  it("carries the decisions made so far, and no later ones", () => {
    const before = frameAt(stall, START + 100_000);
    const after = frameAt(stall, START + 1_000_000);
    expect(before.decisions.length).toBeLessThan(after.decisions.length);
    expect(after.decisions.every((d) => d.atMs <= START + 1_000_000)).toBe(true);
  });

  it("has nothing to show before the first point", () => {
    const frame = frameAt(stall, START - 60_000);
    expect(frame.stops).toHaveLength(0);
    expect(frame.decisions).toHaveLength(0);
  });

  it("turns the short way round", () => {
    expect(shortestTurn(350, 10)).toBe(20);
    expect(shortestTurn(10, 350)).toBe(-20);
    // A half-turn is 180° either way; the sign is arbitrary.
    expect(Math.abs(shortestTurn(0, 180))).toBe(180);
  });
});

describe("the demo runs stay demonstrable", () => {
  it("covers the MOCKS §5 fault list across four runs", () => {
    const kinds = DEMO_RUNS.flatMap((r) => (r.spec.faults ?? []).map((f) => f.kind));
    expect(new Set(kinds)).toEqual(
      new Set(["stall", "gpsGap", "duplicate", "outOfOrder", "jitter", "unboundDevice"]),
    );
  });

  it("uses the committed fixture geometry, and one device per run", () => {
    expect(DEMO_RUNS.map((r) => r.spec.route.id)).toEqual([
      "route2",
      "route3",
      "route2-van3",
      "route1-unbound",
    ]);
    expect(VAN3_ROUTE.deviceId).not.toBe(ROUTE_2.deviceId);
    // One device per vehicle (ADR-013), so the four runs are four devices.
    expect(new Set(DEMO_RUNS.map((r) => r.spec.route.deviceId)).size).toBe(DEMO_RUNS.length);
  });

  it("starts every run on the same scenario clock, inside one traffic band", () => {
    for (const run of DEMO_RUNS) expect(run.spec.startAtMs).toBe(SCENARIO_START_MS);
    expect(new Set(DEMO_RUNS.map((r) => runReplay(r.spec).trafficMultiplier))).toEqual(
      new Set([1.25]),
    );
  });

  it("finishes every run inside the live map's scenario-clock loop", () => {
    for (const run of DEMO_RUNS) {
      expect(runReplay(run.spec).run.durationSeconds).toBeLessThanOrEqual(DEMO_RUN_SECONDS);
    }
  });

  it("keeps the stall run on route2, as the PRD demo script names it", () => {
    expect(RUN_STALL.route).toBe(ROUTE_2);
  });
});

describe("legStateLabel (DESIGN-DIRECTION §3 vocabulary)", () => {
  it("reads the state off the frame, and never says handed off (AT-10)", () => {
    expect(legStateLabel(frameAt(stall, START + 10_000))).toBe("On the way to pickup");
    expect(legStateLabel(frameAt(stall, START + 1_700_000))).toBe("In transit");
    expect(legStateLabel(frameAt(stall, stall.endAtMs))).toBe("Arrived (vehicle)");
    expect(legStateLabel({ stops: [], hidden: true })).toBe("No position");
    for (const ms of [10_000, 900_000, 1_700_000]) {
      expect(legStateLabel(frameAt(stall, START + ms))).not.toContain("Handed off");
    }
  });
});
