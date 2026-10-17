/**
 * The plan as something a map can draw: one line per van, the stops in the order the van drives
 * them, and the centre at the end of the morning or the start of the afternoon.
 *
 * Read off the board's own columns and nothing else: each van, the stops it drives, and the
 * number the column prints beside each one — so the line a van carries on the map and the list
 * inside its column cannot disagree. A child dragged between columns changes the plan, and the
 * map is a second reading of the same change rather than a copy kept in step by hand.
 *
 * It takes stops rather than a `RoutePlan` (Firia's rule 2, 2026-10-17 5:48 PM ET): the capacity
 * solver makes no placement decision anywhere in the rebuild, so the map is not drawn off one of
 * its verdicts either. Ordering the stops of a van somebody has already been put in is the
 * board's own arithmetic (src/domain/plan/board.ts `ridersInVan`).
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
import { distanceM, type Coord } from "@/domain/location/geo";
import type { Direction } from "@/domain/day/leg";
import { CENTER_STOP_ID, committedLeg } from "@/fixtures/run-routes";
import { PROBE_SPEED_MPS } from "@/fixtures/survey";
import { CENTER_STOP, STOPS } from "@/modules/demo/fixtures/standard";
import { places } from "@/ui/copy";

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
  /**
   * The lane's own stop number for this place: the `k` the lane's stop list prints beside it, so
   * "stop 3" on the map and "stop 3" in the lane are the same stop.
   */
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
  /**
   * How long this stretch takes. The survey's own measured duration where it has the pair, and
   * the straight line at the survey's own probe speed where it does not — the same speed the
   * committed durations were measured at (src/fixtures/survey.ts), so a rearranged plan is
   * timed on one number rather than on a guess invented here. The van's footer reads the sum.
   */
  durationSec: number;
};

export type PlanMapRoute = {
  /** The lane this is the route of, so selecting a lane and selecting a line are one thing. */
  laneId: string;
  /** "Van 2" — the one name this van has (src/config/vans.ts `vanNameOf`). */
  vanName: string;
  /** Which of the route colours this van has; the palette lives in src/ui/tokens.ts. */
  colorIndex: number;
  riderCount: number;
  /** The van's own stops, centre excluded: the centre is one pin for every van. */
  stops: PlanMapStop[];
  segments: PlanMapSegment[];
  /** The whole line's driving time, rounded to minutes: what the van's footer says (§1.2). */
  minutes: number;
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
  if (leg && leg.geometry.length >= 2) {
    return { geometry: leg.geometry, surveyed: true, durationSec: leg.durationSec };
  }
  return {
    geometry: [from.coord, to.coord],
    surveyed: false,
    durationSec: distanceM(from.coord, to.coord) / PROBE_SPEED_MPS,
  };
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

/** One place a van stops at, with the number its column prints beside that stop. */
type LanePlace = { key: string; coord: Coord; label: string; k: number };

/**
 * One van as the map is handed it: its id, its name, and the stops it drives in order.
 *
 * Two children at one kerb are **one** stop here — the board collapses them before it asks
 * (src/domain/plan/board.ts `stopNumbers`), because two discs on one coordinate are one disc
 * with a smudge, and the number on the disc is the number on their cards.
 */
export type PlanMapVan = {
  laneId: string;
  vanName: string;
  stops: readonly { order: number; label: string }[];
};

/**
 * The places one van drives, centre included, in the order it drives them: the morning ends at
 * the centre and the afternoon starts there (PRD §8).
 *
 * A stop the fixtures place nowhere is dropped rather than drawn at a guessed coordinate.
 */
function placesOf(direction: Direction, van: PlanMapVan): LanePlace[] {
  const stops: LanePlace[] = [];
  for (const stop of van.stops) {
    const place = placeOf(stop.label);
    if (!place) continue;
    const previous = stops[stops.length - 1];
    if (previous && previous.key === place.key) {
      previous.k = stop.order;
      continue;
    }
    stops.push({ ...place, label: stop.label, k: stop.order });
  }
  if (stops.length === 0) return [];
  const centre: LanePlace = {
    key: CENTER_STOP_ID,
    coord: PLAN_CENTER_COORD,
    label: PLAN_CENTER_LABEL,
    k: 0,
  };
  return direction === "AM" ? [...stops, centre] : [centre, ...stops];
}

/**
 * The whole plan, drawable.
 *
 * A van with nobody in it still gets a route — with no stops and no line — so the map names every
 * van the day has rather than only the ones that happen to be loaded. Its colour is its position
 * in the day's van order, so a van keeps the same colour while children move in and out of it.
 */
export function planMap(direction: Direction, vans: readonly PlanMapVan[]): PlanMapData {
  const routes = vans.map((van, index) => {
    const driven = placesOf(direction, van);
    const segments = driven.slice(0, -1).map((stop, i) => segmentBetween(stop, driven[i + 1]));
    return {
      laneId: van.laneId,
      vanName: van.vanName,
      colorIndex: index,
      riderCount: van.stops.length,
      stops: driven
        .filter((place) => place.key !== CENTER_STOP_ID)
        .map((place) => ({ order: place.k, label: place.label, coord: place.coord })),
      segments,
      minutes: Math.round(segments.reduce((sec, segment) => sec + segment.durationSec, 0) / 60),
      line: joined(segments),
      surveyed: segments.every((segment) => segment.surveyed),
    };
  });
  return {
    direction,
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
