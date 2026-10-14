/**
 * Spherical geometry for the M5 location/ETA engine.
 *
 * SOURCE: PRD §8 (geofence 100 m, recompute ≥300 m), DESIGN-DIRECTION §5.1 (motion
 * tweens **along route geometry**, not straight lines).
 *
 * Pure and dependency-free: no DOM, no clock, no database, no network. Everything is
 * plain numbers over `[lng, lat]` pairs so the simulator, the ETA engine and the map
 * pane all measure distance the same way (see geo.test.ts).
 */

/** `[lng, lat]`, GeoJSON order — the same `Coord` the map layer uses. */
export type Coord = [number, number];

/** IUGG mean Earth radius, in metres. The same constant the OSRM probe check used. */
export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Great-circle distance in metres (haversine). Good to a metre at demo scale, which
 * is well inside the 100 m geofence and the ±40 m jitter fault.
 */
export function distanceM(a: Coord, b: Coord): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a → b, in degrees clockwise from north, normalised to [0, 360). */
export function bearingDeg(a: Coord, b: Coord): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Metres per degree of longitude at this latitude; used by the jitter fault. */
export function metersPerDegreeLng(lat: number): number {
  return (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(toRad(lat));
}

/** Metres per degree of latitude (constant on a sphere). */
export function metersPerDegreeLat(): number {
  return (Math.PI / 180) * EARTH_RADIUS_M;
}

/** Offset a coordinate by a metre vector. Small offsets only (jitter, ±40 m). */
export function offsetByMeters(coord: Coord, eastM: number, northM: number): Coord {
  return [
    coord[0] + eastM / metersPerDegreeLng(coord[1]),
    coord[1] + northM / metersPerDegreeLat(),
  ];
}

/**
 * A polyline with its cumulative chainage, so "how far along" is one lookup.
 * `cumulativeM[i]` is the distance from the first vertex to vertex `i`.
 */
export interface MeasuredPath {
  readonly coords: readonly Coord[];
  readonly cumulativeM: readonly number[];
  readonly totalM: number;
}

/** Measure a polyline once. Zero-length segments (OSRM emits a few) are harmless. */
export function measurePath(coords: readonly Coord[]): MeasuredPath {
  if (coords.length === 0) throw new Error("measurePath: empty polyline");
  const cumulativeM: number[] = [0];
  for (let i = 1; i < coords.length; i += 1) {
    cumulativeM.push(cumulativeM[i - 1] + distanceM(coords[i - 1], coords[i]));
  }
  return { coords, cumulativeM, totalM: cumulativeM[cumulativeM.length - 1] };
}

/** Linear interpolation between two coordinates (metres-scale segments only). */
function lerpCoord(a: Coord, b: Coord, t: number): Coord {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * The point `m` metres along the path, clamped to both ends. This is the §5.1
 * "tween along route geometry" primitive: the marker always sits on the road.
 */
export function pointAtDistance(path: MeasuredPath, m: number): Coord {
  const target = Math.max(0, Math.min(m, path.totalM));
  const { coords, cumulativeM } = path;
  // Linear scan: demo paths are tens of vertices, so an index is not worth it.
  for (let i = 1; i < coords.length; i += 1) {
    const segStart = cumulativeM[i - 1];
    const segEnd = cumulativeM[i];
    if (target <= segEnd) {
      const segLen = segEnd - segStart;
      const t = segLen === 0 ? 0 : (target - segStart) / segLen;
      return lerpCoord(coords[i - 1], coords[i], t);
    }
  }
  return coords[coords.length - 1];
}

/** Heading of the path at `m` metres along it, in degrees clockwise from north. */
export function headingAtDistance(path: MeasuredPath, m: number): number {
  const { coords, cumulativeM, totalM } = path;
  if (coords.length < 2) return 0;
  const target = Math.max(0, Math.min(m, totalM));
  for (let i = 1; i < coords.length; i += 1) {
    if (target <= cumulativeM[i] && cumulativeM[i] > cumulativeM[i - 1]) {
      return bearingDeg(coords[i - 1], coords[i]);
    }
  }
  // Degenerate tail (repeated vertices): fall back to the last real segment.
  for (let i = coords.length - 1; i > 0; i -= 1) {
    if (cumulativeM[i] > cumulativeM[i - 1]) return bearingDeg(coords[i - 1], coords[i]);
  }
  return 0;
}

/**
 * The polyline from the start of `path` up to `m` metres along it, ending exactly at
 * that point. This is the driven-route line on the map (DESIGN-DIRECTION §5.1: driven
 * portion solid), so it must not lag to the last vertex the truck happened to pass.
 */
export function pathUpTo(path: MeasuredPath, m: number): Coord[] {
  const target = Math.max(0, Math.min(m, path.totalM));
  const coords: Coord[] = [];
  for (let i = 0; i < path.coords.length; i += 1) {
    if (path.cumulativeM[i] > target) break;
    coords.push(path.coords[i]);
  }
  const end = pointAtDistance(path, target);
  const last = coords[coords.length - 1];
  if (!last || last[0] !== end[0] || last[1] !== end[1]) coords.push(end);
  return coords;
}

export interface Projection {
  /** Chainage of the closest point on the path, in metres. */
  alongM: number;
  /** Perpendicular distance from the path, in metres (the jitter shows up here). */
  offsetM: number;
}

/**
 * Project a coordinate onto the path. Used by the ETA engine: a reported position —
 * jittered or not — becomes "how far along the route are we", which is the only
 * progress measure the §8 formula needs.
 */
export function projectToPath(path: MeasuredPath, coord: Coord): Projection {
  const { coords, cumulativeM } = path;
  if (coords.length === 1) return { alongM: 0, offsetM: distanceM(coords[0], coord) };

  let best: Projection = { alongM: 0, offsetM: Number.POSITIVE_INFINITY };
  // Work in a local metre frame per segment: at demo scale (segments ≤ a few km) the
  // error of treating lng/lat as planar after scaling is far below the 40 m jitter.
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    const mPerLng = metersPerDegreeLng(a[1]);
    const mPerLat = metersPerDegreeLat();
    const ax = 0;
    const ay = 0;
    const bx = (b[0] - a[0]) * mPerLng;
    const by = (b[1] - a[1]) * mPerLat;
    const px = (coord[0] - a[0]) * mPerLng;
    const py = (coord[1] - a[1]) * mPerLat;
    const segLenSq = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = segLenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / segLenSq));
    const cx = bx * t;
    const cy = by * t;
    const offsetM = Math.hypot(px - cx, py - cy);
    if (offsetM < best.offsetM) {
      const segLen = cumulativeM[i] - cumulativeM[i - 1];
      best = { alongM: cumulativeM[i - 1] + segLen * t, offsetM };
    }
  }
  return best;
}
