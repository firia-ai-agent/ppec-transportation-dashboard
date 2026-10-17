/**
 * The plan as something a map can draw: one line per van, the stops in the order the van drives
 * them, and the centre at the end of the morning or the start of the afternoon.
 *
 * Read off the solver's own answer and nothing else. The input is the `RoutePlan`
 * (src/domain/solver/plan.ts) the lanes beside the map are rendered from — the same object, in
 * the same render — so the line a van carries on the map and the stop list inside its lane
 * cannot disagree about what that van is doing. A child moved between lanes changes the plan,
 * and the map is a second reading of the same change rather than a copy kept in step by hand.
 *
 * The geometry is the committed survey (ADR-007): src/fixtures/run-routes.ts holds the eight
 * roads the scenario's own runs drive, and this module asks for the pair it needs in the
 * direction it needs it. A coordinator rearranging the day makes pairs nobody surveyed — drag a
 * child into another van and that van now drives from a kerb it has never driven from — and
 * those segments are drawn as the straight line between the two stops, marked `surveyed: false`
 * so the screen can say so in words (`planRoutes.mapNote`). Guessing a road would be inventing
 * survey data; drawing nothing would lose the stop.
 *
 * Pure: no clock, no database, no network, no map library. `Coord` is the domain's own
 * `[lng, lat]` (src/domain/location/geo.ts), which is the order GeoJSON wants, so the component
 * that hands it to MapLibre has nothing to convert.
 */
import type { Coord } from "@/domain/location/geo";
import type { Direction, RoutePlan } from "@/domain/solver";
import { CENTER_STOP_ID, committedLeg } from "@/fixtures/run-routes";
import { CENTER_STOP, STOPS } from "@/modules/demo/fixtures/standard";
import { places, vanName } from "@/ui/copy";

/** The centre, as the plan names it and as the survey places it. */
export const PLAN_CENTER_LABEL: string = places.center;
export const PLAN_CENTER_COORD: Coord = [CENTER_STOP.lng, CENTER_STOP.lat];

/**
 * Where each landmark the day can name actually is, keyed by the words the plan uses for it.
 *
 * The plan speaks stop *labels*: the solver is handed "Okeeheelee Park" because a manifest a
 * coordinator reads may not carry a stop code (COPY-GUIDE §2), and the demo fixtures are where
 * that label and its coordinate are both written down. So this is the one translation between
 * them, and a label the fixtures do not have has no place on the map rather than a made-up one.
 */
const PLACE_BY_LABEL: ReadonlyMap<string, { key: string; coord: Coord }> = new Map([
  ...STOPS.map(
    (stop) => [stop.label, { key: stop.key, coord: [stop.lng, stop.lat] as Coord }] as const,
  ),
  [PLAN_CENTER_LABEL, { key: CENTER_STOP_ID, coord: PLAN_CENTER_COORD }] as const,
]);

/** One stop a van's line passes through, in the order it is driven. */
export type PlanMapStop = {
  /** 1-based position in this van's drive, over the stops that are actually drawn. */
  order: number;
  /** The landmark, in words. Never an address and never a stop code. */
  label: string;
  coord: Coord;
};

/** One stretch of a van's line, between two stops it serves. */
export type PlanMapSegment = {
  geometry: Coord[];
  /** True when this stretch is the committed road; false when it is the line between two stops. */
  surveyed: boolean;
};

export type PlanMapRoute = {
  /** The lane this is the route of, so selecting a lane and selecting a line are one thing. */
  laneId: string;
  /** "the convertible van" — the name the lanes use, which is the label on the line. */
  vanName: string;
  /** Which of the route colours this van has; the palette lives in src/ui/tokens.ts. */
  colorIndex: number;
  riderCount: number;
  /** The van's own stops, centre excluded: the centre is one pin for every van. */
  stops: PlanMapStop[];
  segments: PlanMapSegment[];
  /** Every segment's geometry, end to end, with the shared vertex not repeated. */
  line: Coord[];
  /** True when every stretch of this line is the committed road. */
  surveyed: boolean;
};

export type PlanMapData = {
  direction: Direction;
  center: Coord;
  centerLabel: string;
  /** One per lane, in the day's own lane order — including a van with nobody in it yet. */
  routes: PlanMapRoute[];
  /** True while no van has a rider: the map has the centre on it and nothing else to draw. */
  empty: boolean;
};

/** The stop the leg hands over, or `undefined` for a label the fixtures place nowhere. */
function placeOf(label: string): { key: string; coord: Coord } | undefined {
  return PLACE_BY_LABEL.get(label);
}

/**
 * The stretch between two stops: the committed road where the survey has one, and the line
 * between them where it does not.
 */
function segmentBetween(
  from: { key: string; coord: Coord },
  to: { key: string; coord: Coord },
): PlanMapSegment {
  const leg = committedLeg(from.key, to.key);
  if (leg && leg.geometry.length >= 2) return { geometry: leg.geometry, surveyed: true };
  return { geometry: [from.coord, to.coord], surveyed: false };
}

/** Segments joined end to end, dropping the vertex each pair shares. */
function joined(segments: readonly PlanMapSegment[]): Coord[] {
  const line: Coord[] = [];
  for (const segment of segments) {
    for (const coord of segment.geometry) {
      const last = line[line.length - 1];
      if (last && last[0] === coord[0] && last[1] === coord[1]) continue;
      line.push(coord);
    }
  }
  return line;
}

/**
 * The places one lane drives, in manifest order, with the consecutive repeats collapsed.
 *
 * Two children of one family board at the same kerb (the scenario's siblings do), and the
 * manifest carries one stop per child, so a van really does have two stops at one place. The map
 * draws the place once — two circles on the same coordinate are one circle with a smudge — and
 * numbers what it drew, which is why `order` is the position in the drive rather than the
 * manifest's own `k`.
 */
function placesOf(plan: RoutePlan, laneIndex: number): Array<{ key: string; coord: Coord; label: string; isCenter: boolean }> {
  const lanePlan = plan.lanes[laneIndex];
  const stops = lanePlan.leg.stops;
  const lastK = stops.length;
  const out: Array<{ key: string; coord: Coord; label: string; isCenter: boolean }> = [];
  for (const stop of stops) {
    const isCenter = plan.direction === "AM" ? stop.k === lastK : stop.k === 1;
    const place = placeOf(stop.label);
    if (!place) continue;
    const previous = out[out.length - 1];
    if (previous && previous.key === place.key) continue;
    out.push({ ...place, label: stop.label, isCenter });
  }
  return out;
}

/**
 * The whole plan, drawable.
 *
 * A lane with nobody in it still gets a route — with no stops and no line — so the list beside
 * the map names every van the day has rather than only the ones that happen to be loaded. Its
 * colour is its lane's position, so a van keeps the same colour while children move in and out
 * of it.
 */
export function planMap(plan: RoutePlan): PlanMapData {
  const routes = plan.lanes.map((lanePlan, laneIndex) => {
    const stops = placesOf(plan, laneIndex);
    const segments = stops.slice(0, -1).map((stop, i) => segmentBetween(stop, stops[i + 1]));
    return {
      laneId: lanePlan.lane.id,
      vanName: vanName(lanePlan.lane.vehicle.description),
      colorIndex: laneIndex,
      riderCount: lanePlan.riders.length,
      stops: stops
        .filter((stop) => !stop.isCenter)
        .map((stop, i) => ({ order: i + 1, label: stop.label, coord: stop.coord })),
      segments,
      line: joined(segments),
      surveyed: segments.every((segment) => segment.surveyed),
    };
  });
  return {
    direction: plan.direction,
    center: PLAN_CENTER_COORD,
    centerLabel: PLAN_CENTER_LABEL,
    routes,
    empty: routes.every((route) => route.riderCount === 0),
  };
}

/** Every coordinate the map would draw, so a camera can be fitted to the plan. */
export function planMapCoords(data: PlanMapData): Coord[] {
  return [data.center, ...data.routes.flatMap((route) => route.line)];
}
