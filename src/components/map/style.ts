/**
 * Pure map-style helpers for the M5 fleet map pane.
 *
 * SOURCE: docs/design/DESIGN-DIRECTION.md §5 / §5.1 (positron overrides, our layer
 * stack, attribution, camera) and §8 (tokens); docs/adr/ADR-008-map-tiles.md.
 *
 * This module is deliberately dependency-free: no `maplibre-gl` import, no DOM, no
 * network, no database. Everything here is a pure function over plain JSON so it can
 * be unit-tested (see style.test.ts). `FleetMap.tsx` is the only place that talks to
 * MapLibre.
 */

// ---------------------------------------------------------------------------
// Tokens (DESIGN-DIRECTION §8). Every value below is a token from that table.
// ---------------------------------------------------------------------------

export const MAP_TOKENS = {
  /** `ink` — center pin, stop ring, stop/vehicle labels. */
  ink: "#0F172A",
  /** `ink-muted` — basemap label text after the §5.1 override. */
  inkMuted: "#475569",
  /** `surface` — white halos and stop fills. */
  surface: "#FFFFFF",
  /** `route`/`brand` — planned and driven route lines. */
  route: "#1D4ED8",
  /** `osm-water` — the §5.1 water override (positron's default fails 3:1 vs trucks). */
  water: "#D9E2E7",
  /** `map-truck-ok` — GPS fresh/aging. */
  truckOk: "#15803D",
  /** `map-truck-stale` — GPS stale. */
  truckStale: "#A16207",
  /** `map-truck-crit` — GPS lost. */
  truckCrit: "#B91C1C",
} as const;

/**
 * `demo-bg` / `src-sim` violet. Reserved for the DEMO banner and the Simulated
 * source badge (DESIGN-DIRECTION §7, §7.1) and **must never appear on the map**, so
 * it never reads as a status colour. style.test.ts asserts this.
 */
export const DEMO_VIOLET = "#6D28D9";

// ---------------------------------------------------------------------------
// Style URL (ONE env var, ADR-008)
// ---------------------------------------------------------------------------

/** OpenFreeMap `positron`: the quiet near-monochrome base style (DESIGN-DIRECTION §5.1). */
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/**
 * The single map config knob: `NEXT_PUBLIC_MAP_STYLE_URL` (ADR-008). Unset, blank or
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
// GPS freshness (DESIGN-DIRECTION §3; MOCKS-AND-DEMO §5)
// ---------------------------------------------------------------------------

/** Stale band starts here (MOCKS §5, PRD l.456). */
export const GPS_STALE_SECONDS = 180;
/** "No signal" band starts here. */
export const GPS_LOST_SECONDS = 600;
/** Fresh ("Live") band ends here. */
export const GPS_FRESH_SECONDS = 60;

/** The four §3 freshness bands. */
export type GpsBand = "fresh" | "aging" | "stale" | "lost";

/** The three map truck tones (§5.1). Aging shares the ok tone; the label differs. */
export type TruckTone = "ok" | "stale" | "crit";

export function gpsBand(ageSeconds: number): GpsBand {
  if (ageSeconds >= GPS_LOST_SECONDS) return "lost";
  if (ageSeconds >= GPS_STALE_SECONDS) return "stale";
  if (ageSeconds >= GPS_FRESH_SECONDS) return "aging";
  return "fresh";
}

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
  vehicleLabel: "ppec-vehicle-label",
} as const;

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
  PointFeature<{ id: string; tone: TruckTone; label: string; selected: boolean }>
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
