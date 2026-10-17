/**
 * Today's runs, in the shapes the modules that answer questions about them already speak.
 *
 * The board shows one row per child (PRD §14 SURF-01), and every fact on that row is computed
 * rather than written down: the seating verdict comes from the capacity solver
 * (src/domain/solver), the arrival window and the GPS age come from the replay engine over the
 * committed route fixtures (src/domain/eta/replay.ts), and the ride's state comes from the leg
 * machine (src/domain/machines.ts). What this file does is the one thing none of them can do
 * for themselves: turn the demo scenario — the synthetic day in
 * src/modules/demo/fixtures/standard.ts, the same rows `demo reset` seeds — into their inputs.
 *
 * Pure: no clock, no database, no network. The only data that reaches it is the demo fixture
 * and the committed ADR-007 routes, so the board is deterministic and a screenshot of it is
 * evidence rather than a moment.
 *
 * One geometry, read two ways:
 *
 *  - **the plan** — src/fixtures/run-routes.ts, which is each run's own children's own stops in
 *    the scenario's own order, read out of the scenario so it cannot disagree with it. Every
 *    ride's arrival window comes from here, which is how an afternoon ride has a window at nine
 *    in the morning instead of the "Window pending" this board used to print on half its rows;
 *  - **the replay** — the three committed ADR-007 tracks in src/fixtures/routes.ts, driven by the
 *    M5 simulator. They are the demo day's *live* morning: where a van is, how fresh that is,
 *    when it reaches the centre, and which of its riders' kerbs it has already made.
 *
 * Those two used to be different surveys, which is why this file once read the replay for the van
 * and never for the child: the committed routes were authored before the scenario and named stops
 * belonging to another run's children (docs/ui/B12-SLICE1-DEFERRED.md §3.1). The tracks are the
 * runs' own morning geometry now, so a live row and a planned row are about the same road, and a
 * van's arrival at a stop is an arrival at a *named child's* stop.
 */

import type {
  AmbSeat,
  Child as SolverChild,
  DailyCapability,
  Layout as SolverLayout,
  Leg as SolverLeg,
  ManifestStop,
  Vehicle as SolverVehicle,
  WcPosition,
} from "@/domain/solver";
import { runReplay, type ReplayResult } from "@/domain/eta/replay";
import { plannedEta, type StopEta } from "@/domain/eta/eta";
import { trafficMultiplierAt } from "@/domain/eta/traffic";
import {
  freeFlowSecondsBetween,
  measureRoute,
  stopHoldSeconds,
  type MeasuredRoute,
} from "@/domain/location/route";
import { DEMO_RUNS } from "@/fixtures/replays";
import { runRoute } from "@/fixtures/run-routes";
import { places } from "@/ui/copy";
import { localTimeOn, type ServiceDay } from "./day";
import {
  CHILDREN,
  EXTERNAL_PEOPLE,
  PROVIDERS,
  RUNS,
  VEHICLES,
  childByKey,
  familyByKey,
  providerDisplayName,
  stopByKey,
  type Child as DemoChild,
  type Layout as DemoLayout,
  type Position as DemoPosition,
  type Run as DemoRun,
  type Vehicle as DemoVehicle,
} from "@/modules/demo/fixtures/standard";

export type Direction = "AM" | "PM";

/** The stop id the committed routes give the centre; the board reads a run's arrival off it. */
export const CENTER_STOP_ID = "CENTER";

/**
 * A need that means the child rides in something anchored to the seat — a car seat, a booster
 * or a harness/vest. PRD §7 constraint 3 counts those riders against the layout's
 * tether/LATCH-capable seats, so the solver has to be told which children they are, and the
 * fixture says it twice: explicitly on the child (`tether`) and through the approved need.
 */
const TETHER_NEEDS = new Set(["CAR_SEAT_OR_BOOSTER", "HARNESS_OR_VEST"]);

function needsTether(child: DemoChild): boolean {
  return child.tether ?? child.needs.some((n) => TETHER_NEEDS.has(n.category));
}

/**
 * Position ids for one layout. Readable and deterministic ("V1/1WC/3A·W1"), because these never
 * leave the solver: the seed's own ids (src/modules/demo/seed.ts) belong to database rows, and
 * minting them here would claim a correspondence this projection does not have.
 */
function solverPositions(vehicleKey: string, layout: DemoLayout): SolverLayout["positions"] {
  let wc = 0;
  let amb = 0;
  return layout.positions.map((p: DemoPosition) => {
    const prefix = `${vehicleKey}/${layout.code}`;
    if (p.kind === "WC") {
      wc += 1;
      const position: WcPosition = {
        id: `${prefix}·W${wc}`,
        kind: "WC",
        securement: p.securement ?? "OTHER",
        maxLengthCm: p.maxLengthCm ?? 0,
        maxWidthCm: p.maxWidthCm ?? 0,
      };
      return position;
    }
    amb += 1;
    const seat: AmbSeat = { id: `${prefix}·A${amb}`, kind: "AMB", tetherCapable: p.tetherCapable };
    return seat;
  });
}

export function solverVehicle(vehicle: DemoVehicle): SolverVehicle {
  const provider = PROVIDERS.find((p) => p.key === vehicle.providerKey);
  if (!provider) throw new Error(`unknown provider ${vehicle.providerKey}`);
  // The fixture writes a vehicle as "V1 convertible van": the label and then what it is. The
  // solver keeps them apart, because a tile shows the label and a sentence shows the words.
  const [label, ...rest] = vehicle.label.split(" ");
  return {
    id: vehicle.key,
    label,
    description: rest.join(" "),
    providerId: provider.key,
    // The fixture keeps the "SYN" marker on every organisation name; a screen does not
    // (Vera's review, 2026-10-17 — `providerDisplayName`).
    providerName: providerDisplayName(provider.name),
    liftEquipped: vehicle.liftEquipped,
    layouts: vehicle.layouts.map((l) => ({
      id: `${vehicle.key}/${l.code}`,
      code: l.code,
      liftRequired: l.liftRequired,
      positions: solverPositions(vehicle.key, l),
    })),
  };
}

export function solverChild(child: DemoChild): SolverChild {
  return {
    token: child.key,
    displayName: child.label,
    mobility: child.mobility,
    wcLengthCm: child.wcLengthCm,
    wcWidthCm: child.wcWidthCm,
    securement: child.securement,
    tether: needsTether(child),
    escort: child.escortRequired ?? false,
  };
}

/** The window a child's ride is planned for, "HH:MM" in site-local time. */
export function plannedWindow(child: DemoChild, direction: Direction): string {
  return direction === "AM" ? child.amWindow : child.pmWindow;
}

/**
 * A child's own stop, in words. `null` for a child with no stop of their own — the census
 * children arrive with their family, so there is no landmark to name (standard.ts).
 */
export function stopLabel(child: DemoChild): string | null {
  return child.stopKey === null ? null : stopByKey(child.stopKey).label;
}

/**
 * The centre as a stop on a manifest. It is named, never addressed: the fixture's own label
 * carries the street, and no screen may print one (COPY-GUIDE §7), so the words come from the
 * copy module like every other word on a screen.
 */
const CENTRE_LABEL = places.center;

/**
 * One run's manifest for one direction.
 *
 * AM picks the children up at their own stops, earliest window first, and sets everyone down at
 * the centre; PM is the reverse — everyone boards at the centre and is set down in window
 * order. That is the shape the fixture states (`amWindow` / `pmWindow` per child, PM reverses
 * the order; standard.ts `RUNS`), and it is what the solver needs: its constraints are checked
 * per stop over On_k, so the order of the stops *is* the question being asked.
 */
export function manifestFor(run: DemoRun, direction: Direction): ManifestStop[] {
  const riders = run.childKeys
    .map(childByKey)
    .sort((a, b) => plannedWindow(a, direction).localeCompare(plannedWindow(b, direction)));
  const centre = { label: CENTRE_LABEL };
  if (direction === "AM") {
    const pickups = riders.map((child, i) => ({
      k: i + 1,
      label: stopLabel(child) ?? CENTRE_LABEL,
      boarding: [child.key],
      // An escort boards with their child and rides to the centre (PRD §7 constraint 2).
      staffEscorts: 0,
    }));
    return [
      ...pickups,
      { k: riders.length + 1, ...centre, alighting: riders.map((c) => c.key), staffEscorts: 0 },
    ];
  }
  return [
    { k: 1, ...centre, boarding: riders.map((c) => c.key), staffEscorts: 0 },
    ...riders.map((child, i) => ({
      k: i + 2,
      label: stopLabel(child) ?? CENTRE_LABEL,
      alighting: [child.key],
      staffEscorts: 0,
    })),
  ];
}

export function solverLeg(run: DemoRun, direction: Direction): SolverLeg {
  const vehicle = vehicleOf(run);
  const layout = vehicle.layouts.find((l) => l.code === run.layoutCode);
  if (!layout) throw new Error(`run ${run.key}: ${vehicle.key} has no layout ${run.layoutCode}`);
  return {
    id: `${run.key}/${direction}`,
    direction,
    manifestId: `${run.key}/${direction}`,
    // ASM-17: the layout is fixed per ride, so the solver checks the one the manifest planned.
    layoutId: `${vehicle.key}/${layout.code}`,
    children: run.childKeys.map((key) => solverChild(childByKey(key))),
    stops: manifestFor(run, direction),
  };
}

/**
 * The adult the family has on file to receive this child, by name.
 *
 * The screens that read this say "Alma R. (parent) may receive Mia R." rather than "an adult on
 * file may receive this child" (COPY-GUIDE §1 "name the person"): the second sentence is true of
 * every family in the building, so it tells a coordinator nothing they can check. `null` is the
 * TRP-02 case — the family holds every other scope but not RECEIVE_CHILD — and it is a missing
 * authorization, never a missing name: there is no adult to name because none is allowed.
 *
 * Same rule as everywhere else: first name plus last initial, no surname anywhere (D-3).
 */
export type ReceivingAdult = { name: string; relationship: string };

export function receivingAdultOf(child: DemoChild): ReceivingAdult | null {
  if (!child.scopes.includes("RECEIVE_CHILD")) return null;
  const { guardian } = familyByKey(child.familyKey);
  return {
    name: `${guardian.firstName} ${guardian.lastInitial}.`,
    relationship: guardian.relationship,
  };
}

/**
 * The person at the provider who answers for what a vehicle can carry today, by name.
 *
 * `null` for the centre's own fleet, which has no dispatcher on file — so the drawer's step says
 * "Ask Greenacres center fleet" rather than inventing somebody to ask.
 */
export function dispatcherOf(vehicle: DemoVehicle): string | null {
  const provider = PROVIDERS.find((p) => p.key === vehicle.providerKey);
  if (!provider?.dispatcher) return null;
  const person = EXTERNAL_PEOPLE.find((p) => p.key === provider.dispatcher);
  return person ? `${person.firstName} ${person.lastInitial}.` : null;
}

export function vehicleOf(run: DemoRun): DemoVehicle {
  const vehicle = VEHICLES.find((v) => v.key === run.vehicleKey);
  if (!vehicle) throw new Error(`unknown vehicle ${run.vehicleKey}`);
  return vehicle;
}

export function runOfChild(key: string): DemoRun | undefined {
  return RUNS.find((r) => r.childKeys.includes(key));
}

/**
 * The capability observation the day has produced for this vehicle so far.
 *
 * `UNKNOWN` is the state every vehicle-day starts in (the seed writes it, MOCKS §2) and it is
 * the normal morning answer, not an error (PRD §9, DESIGN-DIRECTION §4.2): nothing about the
 * vehicle is assumed until somebody reports it. A vehicle that is *driving its run* has been
 * through that gate already — a manifest cannot be locked, and a van cannot be released, on an
 * unchecked vehicle (PRD §6.3: CAPABILITY_VERIFIED → MANIFEST_LOCKED) — so the one fact the
 * board reads off the replay, "does this device have a displayable position", decides which of
 * the two observations today's run carries. Nothing else is inferred.
 */
export function capabilityFor(
  run: DemoRun,
  serviceDate: string,
  departed: boolean,
): DailyCapability {
  const vehicle = vehicleOf(run);
  if (!departed) {
    return {
      vehicleId: vehicle.key,
      serviceDate,
      state: "UNKNOWN",
      liftOk: null,
      latchOk: null,
      unavailablePositionIds: [],
    };
  }
  return {
    vehicleId: vehicle.key,
    serviceDate,
    state: "VERIFIED",
    observedLayoutId: `${vehicle.key}/${run.layoutCode}`,
    liftOk: true,
    latchOk: true,
    unavailablePositionIds: [],
  };
}

/* ───────────────────── the plan's own windows (ADR-007 geometry, not replayed) ───────────────────── */

const measuredCache = new Map<string, MeasuredRoute>();

/** The committed geometry of one run in one direction, measured once per process. */
export function measuredRunRoute(run: DemoRun, direction: Direction): MeasuredRoute {
  const key = `${run.key}/${direction}`;
  const cached = measuredCache.get(key);
  if (cached) return cached;
  const measured = measureRoute(runRoute(run.key, direction));
  measuredCache.set(key, measured);
  return measured;
}

/** The rider this run picks up or sets down at a stop of the committed route. */
function riderAtStop(run: DemoRun, stopId: string): DemoChild {
  const rider = run.childKeys.map(childByKey).find((child) => child.stopKey === stopId);
  if (!rider) throw new Error(`run ${run.key}: nobody on it rides from ${stopId}`);
  return rider;
}

/**
 * When the run leaves, and the traffic it is planned against.
 *
 * Anchored on one promise and derived from the geometry after that: **the run's first family
 * stop is served at the window that family holds**. In the morning that stop is where the run
 * starts, so it leaves at the window itself; in the afternoon the run starts at the centre, so
 * it leaves early enough to make the first drop on time. Every later stop then follows from the
 * committed durations, which is what makes the plan and the route one thing rather than two
 * numbers that have to be kept in step by hand (run-routes.test.ts holds them together).
 */
function plannedDeparture(
  run: DemoRun,
  direction: Direction,
  day: ServiceDay,
): { departureMs: number; trafficMultiplier: number } {
  const measured = measuredRunRoute(run, direction);
  const stops = measured.route.stops;
  const first = stops.findIndex((stop) => stop.familyLabel !== undefined);
  if (first < 0) throw new Error(`run ${run.key} ${direction}: no family stop to plan against`);

  const targetMs = localTimeOn(day, plannedWindow(riderAtStop(run, stops[first].id), direction));
  const trafficMultiplier = trafficMultiplierAt(targetMs);
  let owedSeconds = freeFlowSecondsBetween(measured, 0, first) * trafficMultiplier;
  // Dwell and service at the stops in between; the origin carries none (PRD §8).
  for (let i = 1; i < first; i += 1) owedSeconds += stopHoldSeconds(stops[i]);
  return { departureMs: targetMs - owedSeconds * 1000, trafficMultiplier };
}

const plannedCache = new Map<string, readonly StopEta[]>();

/** Every stop's planned window on this run, on this service day (PRD §8, no vehicle yet). */
export function plannedStops(
  run: DemoRun,
  direction: Direction,
  day: ServiceDay,
): readonly StopEta[] {
  const key = `${run.key}/${direction}/${day.offsetDays}`;
  const cached = plannedCache.get(key);
  if (cached) return cached;
  const measured = measuredRunRoute(run, direction);
  const stops = plannedEta({ measured, ...plannedDeparture(run, direction, day) });
  plannedCache.set(key, stops);
  return stops;
}

/**
 * The window one child's family holds for one ride, from the plan.
 *
 * This is the afternoon's answer, and it is why no row on this board says a child's window is
 * still being worked out: the committed geometry of the run their van will drive says when it
 * reaches their stop, and the family is given the 10-minute window that falls in (PRD §8).
 * It is a plan and not an observation, so nothing comes back with it — a shift belongs to a
 * recalculation against a real position, and there is no position in a plan.
 */
export function plannedWindowFor(
  child: DemoChild,
  run: DemoRun,
  direction: Direction,
  day: ServiceDay,
): string | null {
  if (child.stopKey === null) return null;
  return plannedStops(run, direction, day).find((s) => s.stopId === child.stopKey)?.windowText ?? null;
}

/* ───────────────────── committed runs (ADR-007 geometry, replayed) ───────────────────── */

const replayCache = new Map<string, ReplayResult | null>();

/**
 * The committed demo run this vehicle is driving today, replayed.
 *
 * One `runReplay` per vehicle per process: the engine is pure and deterministic, so the result
 * is the same every time it is asked for and there is no reason to pay for it twice.
 * `null` means this vehicle has no committed geometry at all, which is not the same as a
 * vehicle whose device sends nothing — see `ReplayResult.accepted` for that (LOC-01).
 */
export function replayForVehicle(vehicleKey: string): ReplayResult | null {
  const cached = replayCache.get(vehicleKey);
  if (cached !== undefined) return cached;
  const demo = DEMO_RUNS.find((r) => r.spec.route.vehicleId === vehicleKey);
  const result = demo ? runReplay(demo.spec) : null;
  replayCache.set(vehicleKey, result);
  return result;
}

/** The children the standard scenario puts on the board, in fixture order. */
export const boardChildren: readonly DemoChild[] = CHILDREN;
