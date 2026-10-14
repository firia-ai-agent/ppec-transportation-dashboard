/**
 * Pure map-style helpers for the M5 fleet map pane.
 *
 * SOURCE: docs/design/DESIGN-DIRECTION.md §5 / §5.1 (positron overrides, our layer
 * stack, attribution, camera) and §8 (tokens); docs/adr/ADR-008-map-tiles.md.
 *
 * This module is deliberately thin: no `maplibre-gl` import, no DOM, no network, no
 * database. Everything here is a pure function over plain JSON so it can be
 * unit-tested (see style.test.ts). `FleetMap.tsx` is the only place that talks to
 * MapLibre. Its one import is the freshness band logic, which lives in
 * src/domain/location/freshness.ts so the map and the ETA engine can never disagree
 * about what "stale" means (DECISION-LEDGER row 30).
 */

import {
  gpsBand,
  GPS_FRESH_SECONDS,
  GPS_LOST_SECONDS,
  GPS_STALE_SECONDS,
  type GpsBand,
} from "@/domain/location/freshness";
import { color } from "@/ui/tokens";

// ---------------------------------------------------------------------------
// Tokens (DESIGN-DIRECTION §8)
// ---------------------------------------------------------------------------

/**
 * The §8 colours this module needs, under map-local names. The hexes themselves live in
 * src/ui/tokens.ts — the single source of colour (no-hex.test.ts enforces that nothing else
 * under src/ holds a literal). A MapLibre style is JSON, so it cannot resolve the
 * `var(--color-*)` properties a component would use and has to read the literals directly.
 */
export const MAP_TOKENS = {
  /** `ink` — center pin, stop ring, stop/vehicle labels. */
  ink: color.ink,
  /** `ink-muted` — basemap label text after the §5.1 override. */
  inkMuted: color["ink-muted"],
  /** `surface` — white halos and stop fills. */
  surface: color.surface,
  /** `route`/`brand` — planned and driven route lines. */
  route: color.brand,
  /** `osm-water` — the §5.1 water override (positron's default fails 3:1 vs trucks). */
  water: color["osm-water"],
  /** `map-truck-ok` — GPS fresh/aging. */
  truckOk: color["map-truck-ok"],
  /** `map-truck-stale` — GPS stale. */
  truckStale: color["map-truck-stale"],
  /** `map-truck-crit` — GPS lost. */
  truckCrit: color["map-truck-crit"],
} as const;

/**
 * `demo-bg` / `src-sim` violet. Reserved for the DEMO banner and the Simulated
 * source badge (DESIGN-DIRECTION §7, §7.1) and **must never appear on the map**, so
 * it never reads as a status colour. style.test.ts asserts this.
 */
export const DEMO_VIOLET = color["demo-bg"];

// ---------------------------------------------------------------------------
// Style URL (ONE env var, ADR-008)
// ---------------------------------------------------------------------------

/** OpenFreeMap `positron`: the quiet near-monochrome base style (DESIGN-DIRECTION §5.1). */
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/**
 * The single map config knob: `NEXT_PUBLIC_MAP_TILE_URL` (ADR-008). Unset, blank or
 * whitespace-only falls back to OpenFreeMap positron.
 */
export function resolveMapStyleUrl(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_MAP_STYLE_URL;
}

// ---------------------------------------------------------------------------
// Attribution (DESIGN-DIRECTION §5.1; OpenFreeMap + OSM ODbL)
// ---------------------------------------------------------------------------

/** Plain-text form, for the ADR, screenshots and tests. */
export const ATTRIBUTION_TEXT = "© OpenFreeMap © OpenStreetMap contributors";

/**
 * The HTML passed to MapLibre's `AttributionControl` as `customAttribution`. MapLibre
 * *adds* this to the attribution the OpenFreeMap TileJSON already carries
 * ("OpenFreeMap © OpenMapTiles Data from OpenStreetMap", required by
 * https://openfreemap.org/), so both the licence requirement and the §5.1 wording are
 * on screen. The control is never removed (ADR-008).
 */
export const ATTRIBUTION_HTML =
  '<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">© OpenFreeMap</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';

// ---------------------------------------------------------------------------
// Minimal structural subset of the MapLibre style spec
// ---------------------------------------------------------------------------

export interface StyleLayerLike {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

export interface StyleLike {
  version: number;
  sources: Record<string, unknown>;
  layers: StyleLayerLike[];
  sprite?: unknown;
  glyphs?: unknown;
}

// ---------------------------------------------------------------------------
// Positron overrides (DESIGN-DIRECTION §5.1 table). Layer ids are kept as-is.
// ---------------------------------------------------------------------------

/** Buildings and POI/airport pins are hidden below this zoom: less noise at fleet zoom. */
export const DETAIL_MIN_ZOOM = 15;

/** Basemap label halo width, in px. */
export const LABEL_HALO_WIDTH = 1.5;

/** Positron layer ids whose fill becomes the lighter `osm-water` token. */
export const WATER_LAYER_IDS = ["water"] as const;

/** Positron layer ids hidden below {@link DETAIL_MIN_ZOOM}. */
export const DETAIL_LAYER_IDS = ["building", "airport"] as const;

/** Positron's motorway inner line is dropped to 0.8 so route lines sit above it. */
export const MOTORWAY_INNER_LAYER_IDS = ["highway_motorway_inner"] as const;

/** `label_*` and `highway-name-*` take the AA-tone ink-muted text + white halo. */
export function isBasemapLabelLayerId(id: string): boolean {
  return id.startsWith("label_") || id.startsWith("highway-name-");
}

/** `building`, `airport` and any POI layer are the "hide below zoom 15" set. */
export function isDetailLayerId(id: string): boolean {
  return (DETAIL_LAYER_IDS as readonly string[]).includes(id) || id.startsWith("poi");
}

function patchLayer(layer: StyleLayerLike): StyleLayerLike {
  const paint = { ...(layer.paint ?? {}) };
  let minzoom = layer.minzoom;

  if ((WATER_LAYER_IDS as readonly string[]).includes(layer.id)) {
    paint["fill-color"] = MAP_TOKENS.water;
  }

  if (isBasemapLabelLayerId(layer.id)) {
    paint["text-color"] = MAP_TOKENS.inkMuted;
    paint["text-halo-color"] = MAP_TOKENS.surface;
    paint["text-halo-width"] = LABEL_HALO_WIDTH;
  }

  if ((MOTORWAY_INNER_LAYER_IDS as readonly string[]).includes(layer.id)) {
    paint["line-opacity"] = 0.8;
  }

  if (isDetailLayerId(layer.id)) {
    minzoom = DETAIL_MIN_ZOOM;
  }

  const next: StyleLayerLike = { ...layer };
  if (Object.keys(paint).length > 0) next.paint = paint;
  if (minzoom === undefined) delete next.minzoom;
  else next.minzoom = minzoom;
  return next;
}

/**
 * Patch a fetched positron style JSON with the §5.1 overrides. Pure: the input style
 * is not mutated, layer ids and their order are preserved, and no layer is added or
 * removed (our own layers come from {@link fleetMapLayers}).
 */
export function applyPositronOverrides<T extends StyleLike>(style: T): T {
  return { ...style, layers: style.layers.map(patchLayer) };
}

// ---------------------------------------------------------------------------
// GPS freshness (DESIGN-DIRECTION §3; DECISION-LEDGER row 30)
// ---------------------------------------------------------------------------

// The bands themselves are domain logic, re-exported here so existing map callers keep
// one import. `src/domain/location/freshness.ts` is the source of truth.
export { gpsBand, GPS_FRESH_SECONDS, GPS_LOST_SECONDS, GPS_STALE_SECONDS, type GpsBand };

/** The three map truck tones (§5.1). Aging shares the ok tone; the label differs. */
export type TruckTone = "ok" | "stale" | "crit";

export function truckTone(ageSeconds: number): TruckTone {
  const band = gpsBand(ageSeconds);
  if (band === "lost") return "crit";
  if (band === "stale") return "stale";
  return "ok";
}

export function truckToneColor(tone: TruckTone): string {
  if (tone === "crit") return MAP_TOKENS.truckCrit;
  if (tone === "stale") return MAP_TOKENS.truckStale;
  return MAP_TOKENS.truckOk;
}

/**
 * Human GPS age (§3): under a minute as seconds, then whole minutes, then hours and
 * minutes. Never raw seconds over 60 — no "245 s".
 */
export function formatGpsAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Full §3 freshness label, used by the accessible vehicle list beside the map. */
export function gpsFreshnessLabel(ageSeconds: number): string {
  const age = formatGpsAge(ageSeconds);
  switch (gpsBand(ageSeconds)) {
    case "fresh":
      return `Live · ${age}`;
    case "aging":
      return `Last seen ${age}`;
    case "stale":
      return `Stale · ${age} · ETA texts paused`;
    case "lost":
      return `No signal · ${age}`;
  }
}

/** Short freshness wording for the on-map label (the full §3 text is too long there). */
export function gpsShortLabel(ageSeconds: number): string {
  const age = formatGpsAge(ageSeconds);
  switch (gpsBand(ageSeconds)) {
    case "fresh":
      return `Live ${age}`;
    case "aging":
      return `Last seen ${age}`;
    case "stale":
      return `Stale ${age}`;
    case "lost":
      return `No signal ${age}`;
  }
}

/**
 * On-map vehicle label: "V1 · Live 12 s". Freshness is **never colour-only** (§5.1),
 * so the tone colour is always paired with this label.
 */
export function vehicleMapLabel(id: string, ageSeconds: number): string {
  return `${id} · ${gpsShortLabel(ageSeconds)}`;
}

// ---------------------------------------------------------------------------
// Our layers (DESIGN-DIRECTION §5.1 "Our layers (on top, in order)")
// ---------------------------------------------------------------------------

export const MAP_SOURCE_IDS = {
  routesPlanned: "ppec-routes-planned",
  routesDriven: "ppec-routes-driven",
  stops: "ppec-stops",
  center: "ppec-center",
  vehicles: "ppec-vehicles",
} as const;

export const MAP_LAYER_IDS = {
  routePlanned: "ppec-route-planned",
  routeDriven: "ppec-route-driven",
  stopCircle: "ppec-stop-circle",
  stopLabel: "ppec-stop-label",
  centerPin: "ppec-center-pin",
  centerLabel: "ppec-center-label",
  vehicleCircle: "ppec-vehicle-circle",
  vehicleHeading: "ppec-vehicle-heading",
  vehicleLabel: "ppec-vehicle-label",
} as const;

/** Image id of the heading chevron, registered with `map.addImage` by FleetMap. */
export const HEADING_ICON_ID = "ppec-heading-chevron";

/** Side of the heading-chevron image, in px (device pixels at `icon-size` 1). */
export const HEADING_ICON_SIZE = 18;

/**
 * The §5.1 marker polish, minus the font problem: a white chevron with a thin ink edge,
 * drawn as raw RGBA and rotated to the vehicle's heading. An `icon-image` needs no
 * glyph coverage from the tile server, which a unicode arrow in a `text-field` would,
 * and it sits on top of the tone disc so direction reads without adding a colour.
 *
 * Pure: returns the `{width, height, data}` shape `map.addImage` accepts. Row 0 is the
 * top of the image, which is the direction `icon-rotate: 0` points (north).
 */
export function headingChevronImage(size = HEADING_ICON_SIZE): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const data = new Uint8Array(size * size * 4);
  const mid = (size - 1) / 2;
  const put = (x: number, y: number, rgb: [number, number, number], alpha: number): void => {
    const i = (y * size + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = alpha;
  };
  const ink: [number, number, number] = [15, 23, 42]; // MAP_TOKENS.ink
  const white: [number, number, number] = [255, 255, 255];

  for (let y = 0; y < size; y += 1) {
    // A triangle pointing up: its half-width grows with y.
    const halfWidth = (y / (size - 1)) * mid;
    for (let x = 0; x < size; x += 1) {
      const dx = Math.abs(x - mid);
      if (dx > halfWidth + 1) continue;
      // The outer pixel of each row is the ink edge, the rest is the white body.
      if (dx > halfWidth - 1) put(x, y, ink, 255);
      else put(x, y, white, 255);
    }
  }
  return { width: size, height: size, data };
}

/** The font stack OpenFreeMap serves from its glyphs endpoint. */
const LABEL_FONT = ["Noto Sans Regular"];
const LABEL_FONT_BOLD = ["Noto Sans Bold"];

/**
 * Our layer stack, bottom to top: planned route, driven route, stops, center pin,
 * trucks. Colours come from {@link MAP_TOKENS} only — never {@link DEMO_VIOLET}.
 *
 * Truck tone is driven by the feature property `tone` ("ok" | "stale" | "crit"), set
 * from {@link truckTone}; the paired `label` property carries the freshness wording so
 * state is never colour-only.
 */
export function fleetMapLayers(): StyleLayerLike[] {
  return [
    {
      id: MAP_LAYER_IDS.routePlanned,
      type: "line",
      source: MAP_SOURCE_IDS.routesPlanned,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": MAP_TOKENS.route,
        "line-width": 4,
        "line-opacity": 0.6,
      },
    },
    {
      id: MAP_LAYER_IDS.routeDriven,
      type: "line",
      source: MAP_SOURCE_IDS.routesDriven,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": MAP_TOKENS.route,
        "line-width": 4,
        "line-opacity": 1,
      },
    },
    {
      id: MAP_LAYER_IDS.stopCircle,
      type: "circle",
      source: MAP_SOURCE_IDS.stops,
      paint: {
        "circle-radius": 6,
        "circle-color": MAP_TOKENS.surface,
        "circle-stroke-width": 2,
        "circle-stroke-color": MAP_TOKENS.ink,
      },
    },
    {
      id: MAP_LAYER_IDS.stopLabel,
      type: "symbol",
      source: MAP_SOURCE_IDS.stops,
      layout: {
        "text-field": ["get", "name"],
        "text-font": LABEL_FONT,
        "text-size": 12,
        "text-anchor": "top",
        "text-offset": [0, 0.8],
        "text-max-width": 10,
      },
      paint: {
        "text-color": MAP_TOKENS.ink,
        "text-halo-color": MAP_TOKENS.surface,
        "text-halo-width": LABEL_HALO_WIDTH,
      },
    },
    {
      id: MAP_LAYER_IDS.centerPin,
      type: "circle",
      source: MAP_SOURCE_IDS.center,
      paint: {
        "circle-radius": 8,
        "circle-color": MAP_TOKENS.ink,
        "circle-stroke-width": 2,
        "circle-stroke-color": MAP_TOKENS.surface,
      },
    },
    {
      id: MAP_LAYER_IDS.centerLabel,
      type: "symbol",
      source: MAP_SOURCE_IDS.center,
      layout: {
        "text-field": ["get", "name"],
        "text-font": LABEL_FONT_BOLD,
        "text-size": 12,
        "text-anchor": "top",
        "text-offset": [0, 1],
        "text-max-width": 10,
      },
      paint: {
        "text-color": MAP_TOKENS.ink,
        "text-halo-color": MAP_TOKENS.surface,
        "text-halo-width": LABEL_HALO_WIDTH,
      },
    },
    {
      id: MAP_LAYER_IDS.vehicleCircle,
      type: "circle",
      source: MAP_SOURCE_IDS.vehicles,
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "selected"], false], 13, 10],
        "circle-color": [
          "match",
          ["get", "tone"],
          "crit",
          MAP_TOKENS.truckCrit,
          "stale",
          MAP_TOKENS.truckStale,
          MAP_TOKENS.truckOk,
        ],
        // 2 px white halo: keeps ≥3:1 against every positron fill (§8).
        "circle-stroke-width": 2,
        "circle-stroke-color": MAP_TOKENS.surface,
      },
    },
    {
      // DESIGN-DIRECTION §5.1 "Markers": rotated to heading, aligned to the map so it
      // keeps pointing down the road when the map is rotated.
      id: MAP_LAYER_IDS.vehicleHeading,
      type: "symbol",
      source: MAP_SOURCE_IDS.vehicles,
      layout: {
        "icon-image": HEADING_ICON_ID,
        "icon-size": 0.8,
        "icon-rotate": ["get", "headingDeg"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
    {
      id: MAP_LAYER_IDS.vehicleLabel,
      type: "symbol",
      source: MAP_SOURCE_IDS.vehicles,
      layout: {
        "text-field": ["get", "label"],
        "text-font": LABEL_FONT_BOLD,
        "text-size": 12,
        "text-anchor": "left",
        "text-offset": [1, 0],
        "text-allow-overlap": true,
        "text-max-width": 14,
      },
      paint: {
        "text-color": MAP_TOKENS.ink,
        "text-halo-color": MAP_TOKENS.surface,
        "text-halo-width": LABEL_HALO_WIDTH,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Camera (DESIGN-DIRECTION §5.1 "Camera", §9 reduced motion)
// ---------------------------------------------------------------------------

/** `[lng, lat]`, GeoJSON order. */
export type Coord = [number, number];

/** `[[west, south], [east, north]]`. */
export type Bounds = [Coord, Coord];

/** §5.1: fly-to is capped at 600 ms. */
export const CAMERA_DURATION_MS = 600;

/** Zoom used when a single vehicle is selected. */
export const SELECTION_ZOOM = 14;

export type CameraMove =
  | { method: "flyTo"; center: Coord; zoom?: number; duration: number }
  | { method: "jumpTo"; center: Coord; zoom?: number };

/**
 * One camera move. Animated with `flyTo` at ≤600 ms normally; under
 * `prefers-reduced-motion` it becomes a `jumpTo` with no animation at all (§9).
 */
export function cameraMove(
  target: { center: Coord; zoom?: number },
  reducedMotion: boolean,
): CameraMove {
  if (reducedMotion) {
    return { method: "jumpTo", center: target.center, zoom: target.zoom };
  }
  return {
    method: "flyTo",
    center: target.center,
    zoom: target.zoom,
    duration: CAMERA_DURATION_MS,
  };
}

/** Bounding box of the given coordinates, or `null` when there are none. */
export function boundsOf(coords: readonly Coord[]): Bounds | null {
  if (coords.length === 0) return null;
  let west = coords[0][0];
  let east = coords[0][0];
  let south = coords[0][1];
  let north = coords[0][1];
  for (const [lng, lat] of coords) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [
    [west, south],
    [east, north],
  ];
}

/** Center of a bounding box. Used as the `jumpTo`/`flyTo` target for "Fit all vehicles". */
export function centerOfBounds(bounds: Bounds): Coord {
  return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
}

// ---------------------------------------------------------------------------
// GeoJSON builders (pure, so the preview page and tests share them)
// ---------------------------------------------------------------------------

export interface PointFeature<P> {
  type: "Feature";
  geometry: { type: "Point"; coordinates: Coord };
  properties: P;
}

export interface LineFeature<P> {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: Coord[] };
  properties: P;
}

export interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

export interface VehicleLike {
  id: string;
  coord: Coord;
  gpsAgeSeconds: number;
  /** Degrees clockwise from north; drives the §5.1 heading chevron. */
  headingDeg?: number;
}

export interface StopLike {
  id: string;
  name: string;
  coord: Coord;
}

export interface RouteLike {
  id: string;
  vehicleId: string;
  /** Full planned geometry, in travel order. */
  planned: Coord[];
  /** How many of `planned`'s points have been driven (clamped by the builders). */
  drivenCount: number;
}

export function vehiclesGeoJson(
  vehicles: readonly VehicleLike[],
  selectedId?: string | null,
): FeatureCollection<
  PointFeature<{
    id: string;
    tone: TruckTone;
    label: string;
    selected: boolean;
    headingDeg: number;
  }>
> {
  return {
    type: "FeatureCollection",
    features: vehicles.map((v) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: v.coord },
      properties: {
        id: v.id,
        tone: truckTone(v.gpsAgeSeconds),
        label: vehicleMapLabel(v.id, v.gpsAgeSeconds),
        selected: v.id === selectedId,
        headingDeg: v.headingDeg ?? 0,
      },
    })),
  };
}

export function stopsGeoJson(
  stops: readonly StopLike[],
): FeatureCollection<PointFeature<{ id: string; name: string }>> {
  return {
    type: "FeatureCollection",
    features: stops.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: s.coord },
      properties: { id: s.id, name: s.name },
    })),
  };
}

export function pointGeoJson(
  coord: Coord,
  name: string,
): FeatureCollection<PointFeature<{ name: string }>> {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: { name } }],
  };
}

/** Planned geometry for every route (drawn at 60% opacity under the driven line). */
export function plannedRoutesGeoJson(
  routes: readonly RouteLike[],
): FeatureCollection<LineFeature<{ id: string; vehicleId: string }>> {
  return {
    type: "FeatureCollection",
    features: routes
      .filter((r) => r.planned.length >= 2)
      .map((r) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: r.planned },
        properties: { id: r.id, vehicleId: r.vehicleId },
      })),
  };
}

/**
 * The driven portion of each route: the first `drivenCount` planned points. Routes
 * with fewer than two driven points produce no feature (nothing to draw yet).
 */
export function drivenRoutesGeoJson(
  routes: readonly RouteLike[],
): FeatureCollection<LineFeature<{ id: string; vehicleId: string }>> {
  return {
    type: "FeatureCollection",
    features: routes
      .map((r) => ({
        route: r,
        coordinates: r.planned.slice(0, Math.max(0, Math.min(r.drivenCount, r.planned.length))),
      }))
      .filter((x) => x.coordinates.length >= 2)
      .map((x) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: x.coordinates },
        properties: { id: x.route.id, vehicleId: x.route.vehicleId },
      })),
  };
}
