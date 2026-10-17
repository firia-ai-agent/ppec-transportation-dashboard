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
 *
 * What it draws depends on the signed-in role: `viewer` arrives from the server guard and
 * every section asks src/domain/access/map-view.ts whether this role sees that data, so the
 * matrix in that file is the one place the answer is written down.
 */

import { Check } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { canSeeMapData, type MapViewer } from "@/domain/access/map-view";
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
import { fill, liveMap, sourceMode } from "@/ui/copy";
import { routeGeometry, type Route } from "@/domain/location/route";
import { icon } from "@/ui/tokens";
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

/**
 * A run's name, in words: the place it starts, then "run". Built from the fixture's own first
 * stop rather than from a table of ids, so a new route is named the moment it is added and the
 * id ("route1", "route1-unbound") stays where it belongs — in the fixture file.
 */
function routeLabelOf(route: Route): string {
  return fill(liveMap.routeName, { stop: route.stops[0]?.name ?? "" });
}

interface RunView {
  label: string;
  faultLabel: string;
  /** The run in words — "Okeeheelee Park run" — never its fixture id. */
  routeLabel: string;
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

function vehiclesOf(
  runs: RunView[],
  show: { familyLabels: boolean; stopWindows: boolean },
): MapVehicleFixture[] {
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
        // A role that may not see the family list never receives it, so there is nothing in
        // the markup to hide: the label is absent, not styled away.
        familyLabel: show.familyLabels ? stop.familyLabel : undefined,
        status: stop.status,
        windowText: show.stopWindows ? stop.windowText : undefined,
      })),
      stoppedSeconds: run.frame.stoppedSeconds,
      etaTextSuppressed: run.frame.etaTextSuppressed,
      exceptionRaised: run.frame.exceptionRaised,
    };
  });
}

/*
 * Inline styles read the design tokens as the CSS custom properties the root layout emits
 * (src/ui/tokens.ts → `tokenCss()`), never as hexes: tokens.ts is the only file under src/
 * allowed to hold a colour literal, and src/ui/no-hex.test.ts enforces it.
 */
const button: React.CSSProperties = {
  minHeight: "var(--target-console)",
  padding: "0 var(--space-4)",
  fontSize: "var(--body-console)",
  fontWeight: "var(--weight-semibold)",
  lineHeight: "var(--leading-tight)",
  color: "var(--color-ink)",
  background: "var(--color-surface)",
  border: "var(--border-hairline) solid var(--color-border-strong)",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
};

/**
 * The chosen speed, filled rather than outlined.
 *
 * An outline in the brand tone is the same shape as the §9 focus ring, so "which speed is
 * running" and "where is my keyboard" read as the same signal. A filled button is a different
 * shape of answer: brand ink carrying surface-white text, the §8 pair that passes AA at 6.70:1,
 * with a check mark beside the label so the state is never colour alone (§3).
 */
const pressed: React.CSSProperties = {
  ...button,
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  color: "var(--color-surface)",
  background: "var(--color-brand)",
  borderColor: "var(--color-brand)",
};

const meta: React.CSSProperties = {
  fontSize: "var(--body-console)",
  lineHeight: "var(--leading-normal)",
  color: "var(--color-ink-muted)",
};

/** §2 section heading: 16 px semibold ink. */
const heading: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-16)",
  fontWeight: "var(--weight-semibold)",
  lineHeight: "var(--leading-tight)",
  color: "var(--color-ink)",
};

export interface LiveFleetMapProps {
  /** The signed-in role, from the route's own guard. */
  viewer: MapViewer;
}

export default function LiveFleetMap({ viewer }: LiveFleetMapProps) {
  const can = (key: Parameters<typeof canSeeMapData>[1]) => canSeeMapData(viewer, key);
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
    routeLabel: routeLabelOf(run.spec.route),
    result: run.result,
    frame: frameAt(run.result, nowMs, !reduced),
  }));

  // LOC-01: a device with no active binding has no displayable position, so it is not
  // in the fixture at all — not hidden with CSS, not drawn faintly. Absent.
  const displayed = runs.filter((run) => !run.frame.hidden);
  const unbound = runs.filter((run) => run.frame.hidden);

  const fixture: MapFixture = {
    center: DEMO_CENTER,
    centerLabel: liveMap.centerLabel,
    initialZoom: 11,
    stops: can("map") ? stopsOf(displayed) : [],
    // Each line of the matrix is load-bearing: a role without `vehiclePositions` gets an
    // empty vehicle list, so there is no marker and no row to hide.
    vehicles: can("vehiclePositions")
      ? vehiclesOf(displayed, { familyLabels: can("familyLabels"), stopWindows: can("stopWindows") })
      : [],
    routes: can("vehiclePositions") ? routesOf(displayed) : [],
    sourceMode: "SIMULATED",
    sourceLabel: sourceMode.SIMULATED,
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
  const suppressedText = fill(
    suppressed === 1 ? liveMap.suppression : liveMap.suppressionPlural,
    { count: suppressed },
  );

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <span style={heading}>{fill(liveMap.clock, { time: formatClock(nowMs) })}</span>
        {/* §6.2: the clock is a demo control, so only the role that holds them gets it. The
            clock itself keeps running for everyone — the readout above is not a control. */}
        {can("clockControls") ? (
          <>
            <button type="button" style={button} onClick={() => setPlaying((p) => !p)}>
              {playing ? liveMap.pause : liveMap.play}
            </button>
            {SPEEDS.map((option) => (
              <button
                key={option}
                type="button"
                style={speed === option ? pressed : button}
                aria-pressed={speed === option}
                onClick={() => setSpeed(option)}
              >
                {speed === option ? <Check size={icon.inline} aria-hidden="true" /> : null}
                {fill(liveMap.speed, { factor: option })}
              </button>
            ))}
            <button type="button" style={button} onClick={restart}>
              {liveMap.restart}
            </button>
          </>
        ) : null}
        <span style={meta}>
          {reduced ? liveMap.motionReduced : liveMap.motionTweened}
        </span>
      </div>

      <FleetMap fixture={fixture} label={liveMap.mapLabel} />

      {can("notificationDecisions") ? (
      <section style={{ display: "grid", gap: "var(--space-3)" }}>
        <h2 style={heading}>{liveMap.decisionsHeading}</h2>
        <p style={{ ...meta, margin: 0, maxWidth: "70ch" }}>
          {fill(liveMap.decisionsIntro, { suppressed: suppressedText })}
        </p>
        {decisions.length === 0 ? (
          <p style={{ ...meta, margin: 0 }}>{liveMap.decisionsEmpty}</p>
        ) : (
          <ul style={{ ...meta, margin: 0, paddingLeft: "var(--space-6)" }}>
            {decisions.map(({ vehicleId, decision }) => (
              <li key={`${vehicleId}-${decision.stopId}-${decision.atMs}`}>
                {fill(liveMap.decisionRow, {
                  time: formatClock(decision.atMs),
                  vehicle: vehicleId,
                  // Both are optional on the decision; a NOTIFY row always carries them, and
                  // an empty string keeps the old render behaviour if one is ever missing.
                  family: decision.familyLabel ?? "",
                  shift: decision.shiftText,
                  window: decision.windowText ?? "",
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
      ) : null}

      {can("injectedFaults") ? (
      <section style={{ display: "grid", gap: "var(--space-3)" }}>
        <h2 style={heading}>{liveMap.faultsHeading}</h2>
        <ul style={{ ...meta, margin: 0, paddingLeft: "var(--space-6)" }}>
          {runs.map((run) => (
            <li key={run.result.spec.route.id}>
              {fill(liveMap.faultRow, {
                vehicle: run.result.spec.route.vehicleId,
                route: run.routeLabel,
                fault: run.faultLabel,
              })}
            </li>
          ))}
        </ul>
        {unbound.map((run) => {
          const device = run.result.ingest.devices[run.result.spec.route.deviceId];
          return (
            // LOC-01 / ADR-013: unbound points are stored with `bound=false` and never displayed.
            <p key={run.result.spec.route.id} style={{ ...meta, margin: 0, maxWidth: "70ch" }}>
              {fill(liveMap.unbound, {
                vehicle: run.result.spec.route.vehicleId,
                unbound: device?.counts.unbound ?? 0,
                accepted: device?.counts.accepted ?? 0,
              })}
            </p>
          );
        })}
      </section>
      ) : null}
    </div>
  );
}
