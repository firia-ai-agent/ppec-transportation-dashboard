/**
 * THE LIVE MAP'S OWN LAYERS: one colour per van, all the way through.
 *
 * #53's engine draws a fleet in one colour — `MAP_TOKENS.route`, teal, for every planned line
 * and every driven line, with the van marker carrying GPS freshness instead
 * (src/components/map/style.ts `fleetMapLayers`). That is right for a pane watching one run and
 * wrong for the screen the founder drew: in png/live-map.png Van 1's line, its pin and the
 * square beside its name are all the same blue, Van 2's are all amber, Van 3's all pink, which
 * is how a coordinator finds the line belonging to the row they are reading.
 *
 * So the colour is a *feature property* here rather than a paint constant: every line, every
 * stop ring and every pin carries its van's colour from {@link VAN_COLORS}, the app's one van
 * palette (Firia, 2026-10-17 11:25 PM ET). The engine underneath is unchanged — the positron
 * overrides, the worker, the camera and the attribution are all #53's, imported from style.ts —
 * and these are separate source and layer ids so the fleet pane's own layers keep their paint.
 *
 * Nothing here is a status colour and nothing here is the demo violet: a van's colour says
 * *which van*, and the van's state is the chip beside its name and the shape of its marker
 * (§3 — colour is never the only cue). The "No GPS" marker is hollow and dashed, the others are
 * filled; that difference survives a greyscale screenshot, which is the test §9 asks for.
 */
import {
  LABEL_HALO_WIDTH,
  type FeatureCollection,
  type LineFeature,
  type PointFeature,
  type StyleLayerLike,
} from "@/components/map/style";
import type { Coord } from "@/domain/location/geo";
import type { VanChip } from "@/domain/location/van-chip";
import { color, vanColor } from "@/ui/tokens";

/** Positron ships these two faces; a third would be a glyph request that 404s. */
const LABEL_FONT_BOLD = ["Noto Sans Bold"];

export const LIVE_SOURCE_IDS = {
  routesPlanned: "ppec-live-routes-planned",
  routesDriven: "ppec-live-routes-driven",
  stops: "ppec-live-stops",
  center: "ppec-live-center",
  vans: "ppec-live-vans",
} as const;

export const LIVE_LAYER_IDS = {
  routePlanned: "ppec-live-route-planned",
  routeDriven: "ppec-live-route-driven",
  stopCircle: "ppec-live-stop-circle",
  centerPin: "ppec-live-center-pin",
  centerLabel: "ppec-live-center-label",
  vanCircle: "ppec-live-van-circle",
  vanNumber: "ppec-live-van-number",
} as const;

/** What the pane needs to know about a van to draw it. */
export type DrawableVan = {
  id: string;
  number: number;
  chip: VanChip;
  coord: Coord;
  planned: readonly Coord[];
  driven: readonly Coord[];
  stops: ReadonlyArray<{ id: string; coord: Coord }>;
};

type VanProps = {
  id: string;
  /** The number painted on the door, which is what the pin prints. */
  number: number;
  color: string;
  /** True for No GPS: a hollow dashed ring rather than a filled disc (§3, §5.1). */
  lost: boolean;
  /** The van a coordinator has selected, which takes a ring — never a different fill. */
  selected: boolean;
};

type LineProps = { id: string; color: string };

/**
 * The colour of a van's everything.
 *
 * Keyed by the van's *number* rather than by its id, so the day's first van is the palette's
 * first colour on the map, in the list and in the legend at once, and a day that runs two vans
 * simply never uses the third.
 */
export function colorForVan(number: number): string {
  return vanColor(number - 1);
}

export function liveRoutesGeoJson(
  vans: readonly DrawableVan[],
  which: "planned" | "driven",
): FeatureCollection<LineFeature<LineProps>> {
  return {
    type: "FeatureCollection",
    features: vans
      .map((van) => ({ van, line: which === "planned" ? van.planned : van.driven }))
      .filter((x) => x.line.length >= 2)
      .map((x) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: [...x.line] },
        properties: { id: `${x.van.id}-${which}`, color: colorForVan(x.van.number) },
      })),
  };
}

export function liveStopsGeoJson(
  vans: readonly DrawableVan[],
): FeatureCollection<PointFeature<LineProps>> {
  return {
    type: "FeatureCollection",
    features: vans.flatMap((van) =>
      van.stops.map((stop) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: stop.coord },
        properties: { id: `${van.id}-${stop.id}`, color: colorForVan(van.number) },
      })),
    ),
  };
}

export function liveVansGeoJson(
  vans: readonly DrawableVan[],
  selectedId: string | null,
): FeatureCollection<PointFeature<VanProps>> {
  return {
    type: "FeatureCollection",
    features: vans.map((van) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: van.coord },
      properties: {
        id: van.id,
        number: van.number,
        color: colorForVan(van.number),
        lost: van.chip === "noGps",
        selected: van.id === selectedId,
      },
    })),
  };
}

export function livePointGeoJson(
  coord: Coord,
  name: string,
): FeatureCollection<PointFeature<{ name: string }>> {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: { name } }],
  };
}

/**
 * Bottom to top: the planned line faded, the driven line solid over it, the stops, the centre,
 * then the vans. The order is the mockup's reading order — a route is context and a van is the
 * thing you are looking for, so the van is never under its own line.
 */
export function liveMapLayers(): StyleLayerLike[] {
  return [
    {
      // The road ahead: the van's colour at low opacity, so a line is readable as "this van's"
      // without competing with the part it has actually driven.
      id: LIVE_LAYER_IDS.routePlanned,
      type: "line",
      source: LIVE_SOURCE_IDS.routesPlanned,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.35 },
    },
    {
      // The road behind: the same colour, solid, growing as the van moves.
      id: LIVE_LAYER_IDS.routeDriven,
      type: "line",
      source: LIVE_SOURCE_IDS.routesDriven,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 1 },
    },
    {
      // A stop is a white disc ringed in its van’s colour (the mockup’s white stop circles).
      id: LIVE_LAYER_IDS.stopCircle,
      type: "circle",
      source: LIVE_SOURCE_IDS.stops,
      paint: {
        "circle-radius": 6,
        "circle-color": color.surface,
        "circle-stroke-width": 3,
        "circle-stroke-color": ["get", "color"],
      },
    },
    {
      id: LIVE_LAYER_IDS.centerPin,
      type: "circle",
      source: LIVE_SOURCE_IDS.center,
      paint: {
        "circle-radius": 8,
        "circle-color": color.ink,
        "circle-stroke-width": 2,
        "circle-stroke-color": color.surface,
      },
    },
    {
      id: LIVE_LAYER_IDS.centerLabel,
      type: "symbol",
      source: LIVE_SOURCE_IDS.center,
      layout: {
        "text-field": ["get", "name"],
        "text-font": LABEL_FONT_BOLD,
        "text-size": 12,
        "text-anchor": "top",
        "text-offset": [0, 1],
        "text-max-width": 10,
      },
      paint: {
        "text-color": color.ink,
        "text-halo-color": color.surface,
        "text-halo-width": LABEL_HALO_WIDTH,
      },
    },
    {
      /*
       * The van. Filled in its own colour, with a white halo so it holds ≥3:1 over every
       * positron fill — except when there is no GPS, where it is a white disc with a dashed
       * ring in its colour, exactly as the mockup draws the van it has lost. Shape, not hue:
       * a greyscale screenshot still tells the two apart (§9).
       *
       * A SELECTED van gets a wider ring and nothing else. Never a different fill: the fill is
       * which van it is, and a second meaning on it is a coordinator reading a selection as a
       * state (Firia, 11:25 PM ET).
       */
      id: LIVE_LAYER_IDS.vanCircle,
      type: "circle",
      source: LIVE_SOURCE_IDS.vans,
      paint: {
        "circle-radius": 13,
        "circle-color": ["case", ["get", "lost"], color.surface, ["get", "color"]],
        "circle-stroke-width": ["case", ["get", "selected"], 4, 3],
        "circle-stroke-color": ["case", ["get", "lost"], ["get", "color"], color.surface],
      },
    },
    {
      // The number inside the pin: white on the van's colour, ink on the hollow one.
      id: LIVE_LAYER_IDS.vanNumber,
      type: "symbol",
      source: LIVE_SOURCE_IDS.vans,
      layout: {
        "text-field": ["to-string", ["get", "number"]],
        "text-font": LABEL_FONT_BOLD,
        "text-size": 12,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": ["case", ["get", "lost"], color["ink-muted"], color.surface],
      },
    },
  ];
}
