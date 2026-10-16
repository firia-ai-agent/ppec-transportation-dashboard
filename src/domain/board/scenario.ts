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
 * KNOWN FIXTURE GAP (for Rudy, not invented around here): the committed routes in
 * src/fixtures/routes.ts were authored before the standard scenario and name stops S1–S4 with
 * family labels that disagree with it — route2 carries V1 but stops at S4 and S1, which belong
 * to another run's children. So a run is paired with the committed geometry of *its own
 * vehicle* and nothing else: where the geometry names a child's own stop the board shows that
 * stop's window, and where it does not the board says the window is pending rather than
 * borrowing another run's numbers.
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
import { DEMO_RUNS } from "@/fixtures/replays";
import { places } from "@/ui/copy";
import {
  CHILDREN,
  PROVIDERS,
  RUNS,
  VEHICLES,
  childByKey,
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
    providerName: provider.name,
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
