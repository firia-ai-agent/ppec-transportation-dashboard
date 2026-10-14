"use client";

/**
 * The M5 fleet map, moving: a client-side scenario clock reading the deterministic
 * replay runs in src/fixtures/replays.ts.
 *
 * SOURCE: PRD §18.2 steps 7–8, §8 (freshness, ETA windows), AT-03 / AT-10 / AT-11,
 * DESIGN-DIRECTION §5.1 (motion: tween along route geometry, stall shows a clock
 * label; reduced motion = no tween at all) and §6.2 (clock controls), MOCKS §5.
 *
 * All the thinking happens in the pure domain modules: this component owns a clock and
 * a shape conversion, nothing else. No database, no SSE, no network of its own — the
 * only request on this page is MapLibre's style fetch. Nothing is sent anywhere: the
 * notification list below the map is *decisions*, which is all M5 produces.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import FleetMap from "./FleetMap";
import { formatClock } from "@/domain/eta/eta";
import type { NotificationDecision } from "@/domain/eta/notify-gate";
import {
  frameAt,
  legStateLabel,
  runReplay,
  type ReplayFrame,
  type ReplayResult,
} from "@/domain/eta/replay";
import { measurePath, pathUpTo } from "@/domain/location/geo";
import { routeGeometry } from "@/domain/location/route";
import { DEMO_RUNS, DEMO_RUN_SECONDS, SCENARIO_START_MS } from "@/fixtures/replays";
import {
  DEMO_CENTER,
  DEMO_VEHICLES,
  type MapFixture,
  type MapRouteFixture,
  type MapStopFixture,
  type MapVehicleFixture,
} from "@/fixtures/map";

/** §6.2 clock speeds. ×10 by default: a 25-minute run plays in two and a half. */
const SPEEDS = [1, 10, 60] as const;
const DEFAULT_SPEED = 10;
/** Wall-clock tick. 4 Hz is smooth enough for a tween between 5 s points. */
const TICK_MS = 250;

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOTION_QUERY).matches;
}

/** §9: honoured live, so a mid-session OS change takes effect without a reload. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, readMotion, () => false);
}

/** The scenario clock (PRD §8: acceleration applies here, never to a carrier stamp). */
function useSimClock(playing: boolean, speed: number, reduced: boolean) {
  const [simSeconds, setSimSeconds] = useState(0);

  useEffect(() => {
    if (!playing) return;
    // Under reduced motion the clock still runs, it just steps a second at a time:
    // the trucks jump point to point instead of gliding (§5.1, §9).
    const intervalMs = reduced ? 1000 : TICK_MS;
    const id = window.setInterval(() => {
      setSimSeconds((s) => (s + (speed * intervalMs) / 1000) % DEMO_RUN_SECONDS);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [playing, speed, reduced]);

  return { simSeconds, restart: () => setSimSeconds(0) };
}

interface RunView {
  label: string;
  faultLabel: string;
  provenance: string;
  result: ReplayResult;
  frame: ReplayFrame;
}

const VEHICLE_META = new Map(DEMO_VEHICLES.map((v) => [v.id, v]));

function stopsOf(runs: RunView[]): MapStopFixture[] {
  const byId = new Map<string, MapStopFixture>();
  for (const run of runs) {
    for (const stop of run.result.spec.route.stops) {
      // The center has its own pin layer; a stop circle on top of it would double up.
      if (stop.id === "CENTER" || byId.has(stop.id)) continue;
      byId.set(stop.id, { id: stop.id, name: stop.name, coord: stop.coord, sourceMode: "SIMULATED" });
    }
  }
  return [...byId.values()];
}

/**
 * Planned and driven geometry per visible run. Two entries per route: the full planned
 * line (never "driven"), and the driven prefix ending exactly where the truck is, so
 * the solid line keeps up with the marker instead of lagging to the last vertex.
 */
function routesOf(runs: RunView[]): MapRouteFixture[] {
  const out: MapRouteFixture[] = [];
  for (const run of runs) {
    const route = run.result.spec.route;
    const planned = routeGeometry(route);
    out.push({
      id: `${route.id}-planned`,
      vehicleId: route.vehicleId,
      planned,
      drivenCount: 0,
      sourceMode: "SIMULATED",
    });
    const driven = pathUpTo(measurePath(planned), run.frame.drivenM);
    if (driven.length >= 2) {
      out.push({
        id: `${route.id}-driven`,
        vehicleId: route.vehicleId,
        planned: driven,
        drivenCount: driven.length,
        sourceMode: "SIMULATED",
      });
    }
  }
  return out;
}

function vehiclesOf(runs: RunView[]): MapVehicleFixture[] {
  return runs.map((run) => {
    const route = run.result.spec.route;
    const meta = VEHICLE_META.get(route.vehicleId);
    return {
      id: route.vehicleId,
      description: meta?.description ?? "Vehicle",
      owner: meta?.owner ?? "Provider",
      stateLabel: legStateLabel(run.frame),
      coord: run.frame.coord,
      headingDeg: run.frame.headingDeg,
      gpsAgeSeconds: run.frame.gpsAgeSeconds ?? 0,
      routeId: route.id,
      sourceMode: "SIMULATED",
      stops: run.frame.stops.map((stop) => ({
        stopId: stop.stopId,
        name: stop.stopName,
        familyLabel: stop.familyLabel,
        status: stop.status,
        windowText: stop.windowText,
      })),
      stoppedSeconds: run.frame.stoppedSeconds,
      etaTextSuppressed: run.frame.etaTextSuppressed,
      exceptionRaised: run.frame.exceptionRaised,
    };
  });
}

const button: React.CSSProperties = {
  minHeight: 44,
  padding: "0 12px",
  font: "600 14px/1.2 system-ui, sans-serif",
  color: "#0F172A",
  background: "#FFFFFF",
  border: "1px solid #64748B",
  borderRadius: 6,
  cursor: "pointer",
};

const pressed: React.CSSProperties = { ...button, borderColor: "#1D4ED8", boxShadow: "inset 0 0 0 1px #1D4ED8" };
const meta: React.CSSProperties = { font: "400 14px/1.5 system-ui, sans-serif", color: "#475569" };

export default function LiveFleetMap() {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const { simSeconds, restart } = useSimClock(playing, speed, reduced);

  // One replay per run, computed once: the clock only reads frames out of them.
  const results = useMemo(
    () => DEMO_RUNS.map((run) => ({ ...run, result: runReplay(run.spec) })),
    [],
  );

  const nowMs = SCENARIO_START_MS + simSeconds * 1000;
  const runs: RunView[] = results.map((run) => ({
    label: run.spec.route.vehicleId,
    faultLabel: run.faultLabel,
    provenance: run.provenance,
    result: run.result,
    frame: frameAt(run.result, nowMs, !reduced),
  }));

  // LOC-01: a device with no active binding has no displayable position, so it is not
  // in the fixture at all — not hidden with CSS, not drawn faintly. Absent.
  const displayed = runs.filter((run) => !run.frame.hidden);
  const unbound = runs.filter((run) => run.frame.hidden);

  const fixture: MapFixture = {
    center: DEMO_CENTER,
    centerLabel: "PPEC center",
    initialZoom: 11,
    stops: stopsOf(displayed),
    vehicles: vehiclesOf(displayed),
    routes: routesOf(displayed),
    sourceMode: "SIMULATED",
    sourceLabel: "Simulated",
  };

  const decisions: Array<{ vehicleId: string; decision: NotificationDecision }> = runs
    .flatMap((run) =>
      run.frame.decisions
        .filter((decision) => decision.outcome === "NOTIFY")
        .map((decision) => ({ vehicleId: run.result.spec.route.vehicleId, decision })),
    )
    .sort((a, b) => a.decision.atMs - b.decision.atMs);

  const suppressed = runs.reduce(
    (n, run) => n + run.frame.decisions.filter((d) => d.outcome === "SUPPRESS").length,
    0,
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ font: "600 16px/1.2 system-ui, sans-serif", color: "#0F172A" }}>
          Scenario clock {formatClock(nowMs)} ET
        </span>
        <button type="button" style={button} onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        {SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            style={speed === option ? pressed : button}
            aria-pressed={speed === option}
            onClick={() => setSpeed(option)}
          >
            ×{option}
          </button>
        ))}
        <button type="button" style={button} onClick={restart}>
          Restart
        </button>
        <span style={meta}>
          {reduced ? "Reduced motion: markers step, no tween" : "Tweened along route geometry"}
        </span>
      </div>

      <FleetMap fixture={fixture} label="Fleet map: simulated vehicles near the PPEC center" />

      <section style={{ display: "grid", gap: 6 }}>
        <h2 style={{ margin: 0, font: "600 16px/1.2 system-ui, sans-serif", color: "#0F172A" }}>
          Notification decisions
        </h2>
        <p style={{ ...meta, margin: 0, maxWidth: "70ch" }}>
          Decisions only — M5 computes what <em>would</em> be sent and why. Nothing is queued,
          nothing is sent, nothing is written to a database. {suppressed} suppression
          {suppressed === 1 ? "" : "s"} so far this run (below threshold, not persisted, cooldown,
          stale GPS, or a stop already passed).
        </p>
        {decisions.length === 0 ? (
          <p style={{ ...meta, margin: 0 }}>No notification decision yet.</p>
        ) : (
          <ul style={{ ...meta, margin: 0, paddingLeft: 18 }}>
            {decisions.map(({ vehicleId, decision }) => (
              <li key={`${vehicleId}-${decision.stopId}-${decision.atMs}`}>
                {formatClock(decision.atMs)} ET · {vehicleId} · {decision.familyLabel} ·{" "}
                {decision.shiftText} · new pickup window {decision.windowText}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ display: "grid", gap: 6 }}>
        <h2 style={{ margin: 0, font: "600 16px/1.2 system-ui, sans-serif", color: "#0F172A" }}>
          Injected faults
        </h2>
        <ul style={{ ...meta, margin: 0, paddingLeft: 18 }}>
          {runs.map((run) => (
            <li key={run.result.spec.route.id}>
              {run.result.spec.route.vehicleId} · {run.result.spec.route.id} · {run.faultLabel} (
              {run.provenance})
            </li>
          ))}
        </ul>
        {unbound.map((run) => {
          const device = run.result.ingest.devices[run.result.spec.route.deviceId];
          return (
            <p key={run.result.spec.route.id} style={{ ...meta, margin: 0, maxWidth: "70ch" }}>
              {run.result.spec.route.vehicleId}&apos;s device has no active binding:{" "}
              {device?.counts.unbound ?? 0} points ingested and stored with{" "}
              <code>bound=false</code>, {device?.counts.accepted ?? 0} displayable. It has no
              marker, no row and no ETA (LOC-01, ADR-013).
            </p>
          );
        })}
      </section>
    </div>
  );
}
