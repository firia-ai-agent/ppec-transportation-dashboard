/**
 * The live board: what a tick of the scenario clock puts on the surface, and what a delta
 * carries between two ticks.
 *
 * This is the surface half of AT-03 and AT-11. The replay engine's own tests
 * (src/domain/eta/replay.test.ts) prove the rules inside the engine; these prove that the
 * board a coordinator is looking at carries them — the damped window reaching one downstream
 * family and nobody else, the stale badge and the paused ETA text at 180 s, the location-loss
 * exception at 600 s, the duplicate and out-of-order points counted at ingest rather than
 * drawn, and the van that arrived still not being a child handed over.
 *
 * Nothing here mocks anything: every value comes from `liveSnapshotAt`, which is the same
 * function the stream serialises.
 */
import { describe, expect, it } from "vitest";
import { freshnessConfig } from "@/config/live";
import { BOARD_SCENARIO_TICK } from "./day";
import { LAST_TICK, tickAtScenarioSeconds } from "@/domain/eta/scenario-clock";
import {
  applyLiveDelta,
  liveDelta,
  liveDeltaBetween,
  liveSnapshotAt,
  publishedWindowsOf,
  type LiveSnapshot,
  type LiveVehicle,
} from "./live";

const at = (scenarioSeconds: number): LiveSnapshot =>
  liveSnapshotAt(tickAtScenarioSeconds(scenarioSeconds));

/** The van the §18.2 step 7 stall belongs to: the one standing still at the board's instant. */
function stalledVan(snapshot: LiveSnapshot): LiveVehicle {
  const van = snapshot.vehicles.find((v) => v.stoppedSeconds > 0);
  expect(van, "no van is stalled at this tick").toBeDefined();
  return van as LiveVehicle;
}

/** The van the §18.2 step 8 GPS gap belongs to: the one whose signal is about to go. */
function gapVan(snapshot: LiveSnapshot): LiveVehicle {
  const van = snapshot.vehicles.find((v) => v.counts.duplicate > 0 || v.counts.outOfOrder > 0);
  expect(van, "no van has the AT-11 fault points on it").toBeDefined();
  return van as LiveVehicle;
}

describe("a snapshot is the board at an instant", () => {
  const snapshot = liveSnapshotAt(BOARD_SCENARIO_TICK);

  it("reads the demo day at the tick the board's own instant falls on", () => {
    expect(snapshot.tick).toBe(BOARD_SCENARIO_TICK);
    expect(snapshot.scenarioSeconds).toBe(720);
    expect(snapshot.clockText).toBe("7:42 AM");
  });

  it("carries one entry per child and ride, keyed the way the board keys its rows", () => {
    expect(snapshot.rides).toHaveLength(56);
    expect(snapshot.rides.every((ride) => /\/(AM|PM)$/.test(ride.key))).toBe(true);
    expect(new Set(snapshot.rides.map((r) => r.key)).size).toBe(snapshot.rides.length);
  });

  it("carries the planned geometry once, for the pane to draw", () => {
    expect(snapshot.routes.length).toBe(snapshot.vehicles.length);
    for (const route of snapshot.routes) {
      expect(route.planned.length).toBeGreaterThan(2);
      expect(snapshot.vehicles.some((v) => v.id === route.vehicleId)).toBe(true);
    }
  });

  it("is deterministic: the same tick is the same board (AT-03)", () => {
    expect(liveSnapshotAt(BOARD_SCENARIO_TICK)).toEqual(snapshot);
    expect(at(1500)).toEqual(at(1500));
  });
});

describe("AT-03 · the delay reaches the downstream family and nobody else", () => {
  it("opens the gate exactly once over the whole morning", () => {
    const end = liveSnapshotAt(LAST_TICK);
    expect(end.notifications).toHaveLength(1);
    const [only] = end.notifications;
    expect(only.familyLabel).toBeDefined();
    // ASM-14: a 10-minute shift, published as a 10-minute window.
    expect(only.shiftText).toMatch(/^\+\d+ min$/);
    expect(only.windowText).toMatch(/^\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M$/);
  });

  it("tells the stop ahead of the stall, never the stop behind it", () => {
    const end = liveSnapshotAt(LAST_TICK);
    const van = stalledVan(liveSnapshotAt(BOARD_SCENARIO_TICK));
    const [notified] = end.notifications;
    expect(notified.vehicleId).toBe(van.id);

    // The stop the van had already left by the time the stall matured: it is "passed" on the
    // board and it holds no window at all, so there is nothing about it to tell anybody.
    const passed = end.vehicles
      .find((v) => v.id === van.id)
      ?.stops.filter((stop) => stop.status === "passed");
    expect(passed?.length).toBeGreaterThan(0);
    for (const stop of passed ?? []) {
      expect(stop.windowText, `${stop.stopId} is behind the stall`).toBeUndefined();
      expect(end.notifications.some((n) => n.stopId === stop.stopId)).toBe(false);
    }
  });

  it("moves the downstream window once the shift has persisted, and not before", () => {
    const vanId = stalledVan(liveSnapshotAt(BOARD_SCENARIO_TICK)).id;
    const windowsAt = (seconds: number) => {
      const van = at(seconds).vehicles.find((v) => v.id === vanId) as LiveVehicle;
      return publishedWindowsOf(van);
    };

    const before = windowsAt(720);
    const after = windowsAt(840);
    const changed = Object.keys(after).filter((stopId) => after[stopId] !== before[stopId]);
    expect(changed.length).toBeGreaterThan(0);

    // Hysteresis: the windows that moved hold their new value for the rest of the morning
    // rather than being re-rounded on every recalculation (PRD §8, ASM-14).
    const later = windowsAt(1200);
    for (const stopId of changed) expect(later[stopId]).toBe(after[stopId]);
  });

  it("never prints a minute-precision arrival anywhere on the surface", () => {
    for (const seconds of [720, 900, 1500, 2100]) {
      for (const van of at(seconds).vehicles) {
        for (const stop of van.stops) {
          if (stop.windowText === undefined) continue;
          expect(stop.windowText).toMatch(/^\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M$/);
        }
      }
    }
  });

  it("a notification is a decision: it names a family label and no address or phone", () => {
    const [only] = liveSnapshotAt(LAST_TICK).notifications;
    expect(Object.keys(only).sort()).toEqual([
      "atMs",
      "familyLabel",
      "shiftText",
      "stopId",
      "vehicleId",
      "windowText",
    ]);
  });
});

describe("AT-11 · duplicate and out-of-order points, counted rather than drawn", () => {
  it("shows the counts the ingest seam produced for the van that was sent them", () => {
    const van = gapVan(liveSnapshotAt(BOARD_SCENARIO_TICK));
    expect(van.counts.duplicate).toBeGreaterThan(0);
    expect(van.counts.outOfOrder).toBeGreaterThan(0);
    expect(van.counts.accepted).toBeGreaterThan(0);
    // The points that were refused are not in the accepted stream, so they move nothing.
    expect(van.counts.accepted).toBeLessThan(
      van.counts.accepted + van.counts.duplicate + van.counts.outOfOrder,
    );
  });

  it("never lets a refused point rewind the van: the age only ever grows inside the gap", () => {
    const vanId = gapVan(liveSnapshotAt(BOARD_SCENARIO_TICK)).id;
    const ageAt = (seconds: number) =>
      (at(seconds).vehicles.find((v) => v.id === vanId) as LiveVehicle).gpsAgeSeconds;
    const ages = [300, 420, 540, 660, 720, 780].map(ageAt);
    for (let i = 1; i < ages.length; i += 1) expect(ages[i]).toBeGreaterThan(ages[i - 1]);
  });
});

describe("AT-11 · location loss: the badge at 180 s, the exception at 600 s", () => {
  const vanId = gapVan(liveSnapshotAt(BOARD_SCENARIO_TICK)).id;
  const vanAt = (seconds: number) =>
    at(seconds).vehicles.find((v) => v.id === vanId) as LiveVehicle;

  it("walks the four bands in order as the gap runs", () => {
    expect(vanAt(180).band).toBe("fresh");
    expect(vanAt(300).band).toBe("aging");
    expect(vanAt(600).band).toBe("stale");
    expect(vanAt(780).band).toBe("lost");
    // …and comes back when positions do.
    expect(vanAt(840).band).toBe("fresh");
  });

  it("pauses the ETA text from the stale boundary and not before (LOC-03)", () => {
    const stale = vanAt(600);
    expect(stale.gpsAgeSeconds).toBeGreaterThanOrEqual(freshnessConfig.staleSeconds);
    expect(stale.etaTextSuppressed).toBe(true);
    expect(stale.exceptionRaised).toBe(false);

    const aging = vanAt(300);
    expect(aging.gpsAgeSeconds).toBeLessThan(freshnessConfig.staleSeconds);
    expect(aging.etaTextSuppressed).toBe(false);
  });

  it("raises the exception from the 600 s boundary, and says so on the van", () => {
    const lost = vanAt(780);
    expect(lost.gpsAgeSeconds).toBeGreaterThanOrEqual(freshnessConfig.lostSeconds);
    expect(lost.exceptionRaised).toBe(true);
    expect(lost.etaTextSuppressed).toBe(true);
  });

  it("puts every ride on that van into needs action, with the step that finds it", () => {
    const before = at(600).rides.filter((r) => r.gpsFreshness === "LOST");
    expect(before).toHaveLength(0);

    const lost = at(780).rides.filter((r) => r.gpsFreshness === "LOST");
    expect(lost.length).toBeGreaterThan(0);
    for (const ride of lost) {
      expect(ride.group).toBe("NEEDS_ACTION");
      expect(ride.needsActionReasons).toContain("LOCATION_LOST");
      expect(ride.nextStep).toBe("FIND_VAN");
      // Never hide data (§4.1): the last window the family holds is still on the row.
      expect(ride.windowText).not.toBeNull();
      expect(ride.etaPaused).toBe(true);
    }
  });

  it("keeps the ride rows of a stale van showing their window with the texts paused", () => {
    const stale = at(600).rides.filter((r) => r.gpsFreshness === "STALE");
    expect(stale.length).toBeGreaterThan(0);
    for (const ride of stale) {
      expect(ride.etaPaused).toBe(true);
      expect(ride.windowText).not.toBeNull();
    }
  });
});

describe("LOC-01 · a van whose device is not linked to it", () => {
  it("is on no marker, in no route and in no stop list — and is counted", () => {
    const snapshot = liveSnapshotAt(BOARD_SCENARIO_TICK);
    expect(snapshot.silent.length).toBeGreaterThan(0);
    for (const van of snapshot.silent) {
      expect(snapshot.vehicles.some((v) => v.id === van.id)).toBe(false);
      expect(snapshot.routes.some((r) => r.vehicleId === van.id)).toBe(false);
      expect(van.counts.unbound).toBeGreaterThan(0);
      expect(van.counts.accepted).toBe(0);
    }
  });
});

describe("AT-10 · a geofence is never a handoff, however long the clock runs", () => {
  it("says 'Arrived (vehicle)' and never 'Handed off' on any van at any tick", () => {
    for (const seconds of [720, 1200, 1800, 2400, 2700]) {
      const snapshot = at(seconds);
      for (const van of snapshot.vehicles) {
        expect(van.stateLabel).not.toMatch(/handed off/i);
      }
      for (const van of snapshot.vehicles) {
        for (const stop of van.stops) {
          expect(stop.status).not.toBe("handed-off" as never);
        }
      }
    }
  });

  it("moves no ride on the live day to a handoff, whatever the geofence sees", () => {
    for (const seconds of [720, 1500, 2700]) {
      for (const ride of at(seconds).rides) {
        expect(ride.state).not.toBe("COMPLETED_HANDOFF");
      }
    }
  });
});

describe("the reconnect delta (PRD SURF-01, ADR-002)", () => {
  it("carries only the rides and vans that moved", () => {
    const from = tickAtScenarioSeconds(720);
    const to = tickAtScenarioSeconds(780);
    const delta = liveDeltaBetween(from, to);
    expect(delta.fromTick).toBe(from);
    expect(delta.tick).toBe(to);
    expect(delta.rides.length).toBeGreaterThan(0);
    expect(delta.rides.length).toBeLessThan(liveSnapshotAt(to).rides.length);
    // Static halves stay out of a delta: the client already has them.
    expect(Object.keys(delta)).not.toContain("routes");
    expect(Object.keys(delta)).not.toContain("silent");
  });

  it("brings a client that missed a whole minute to exactly the current board", () => {
    const start = liveSnapshotAt(tickAtScenarioSeconds(720));
    const now = liveSnapshotAt(tickAtScenarioSeconds(840));
    const caughtUp = applyLiveDelta(start, liveDelta(start, now));
    expect(caughtUp).toEqual(now);
  });

  it("is a no-op when it does not fit the snapshot the client holds", () => {
    const held = liveSnapshotAt(tickAtScenarioSeconds(720));
    const mismatched = liveDeltaBetween(tickAtScenarioSeconds(900), tickAtScenarioSeconds(960));
    expect(applyLiveDelta(held, mismatched)).toEqual(held);
  });

  it("keeps the board's own row order when a delta is applied", () => {
    const start = liveSnapshotAt(tickAtScenarioSeconds(720));
    const applied = applyLiveDelta(start, liveDeltaBetween(start.tick, start.tick + 24));
    expect(applied.rides.map((r) => r.key)).toEqual(start.rides.map((r) => r.key));
    expect(applied.vehicles.map((v) => v.id)).toEqual(start.vehicles.map((v) => v.id));
  });

  it("appends the notifications the gate opened in between, exactly once", () => {
    const start = liveSnapshotAt(tickAtScenarioSeconds(720));
    const later = liveSnapshotAt(tickAtScenarioSeconds(900));
    const delta = liveDelta(start, later);
    expect(delta.notifications).toHaveLength(later.notifications.length - start.notifications.length);
    const applied = applyLiveDelta(start, delta);
    expect(applied.notifications).toEqual(later.notifications);
  });

  it("carries no ride that did not change, and leaves out none that did", () => {
    const from = liveSnapshotAt(tickAtScenarioSeconds(600));
    const to = liveSnapshotAt(tickAtScenarioSeconds(605));
    const delta = liveDelta(from, to);
    const sent = new Set(delta.rides.map((ride) => ride.key));
    const before = new Map(from.rides.map((ride) => [ride.key, ride]));
    for (const ride of to.rides) {
      const moved = JSON.stringify(before.get(ride.key)) !== JSON.stringify(ride);
      expect(sent.has(ride.key), `${ride.key} moved=${moved}, sent=${sent.has(ride.key)}`).toBe(
        moved,
      );
    }
    // A ride nobody has reported anything about and whose van is not moving is one of them:
    // the afternoon has no live van at all, so no PM row is ever in a delta.
    expect(delta.rides.some((ride) => ride.key.endsWith("/PM"))).toBe(false);
  });
});
