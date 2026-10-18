"use client";

/**
 * The Plan routes map pane (PRD B-09, §14 SURF-01 "map right 40%"; DESIGN-DIRECTION §4.1, §5.1).
 *
 * The planning screen's own reading of the plan: one line per van, the stops numbered in the
 * order that van drives them, the van's name along its line, and the centre every line runs to.
 * What it draws is `planMap(plan)` (src/domain/plan/map.ts) over the same `RoutePlan` the lanes
 * beside it are rendered from, so a child moved between lanes changes both in one render and the
 * map cannot be a stale copy of the plan.
 *
 * The second module that talks to MapLibre, and it talks to it the same way FleetMap does: the
 * positron overrides, the layer paints, the camera and the GeoJSON are all in ./style.ts and
 * unit-tested there, the map is built **once** per mount, and every later change is pushed into
 * the three sources with `setData` — so a drag re-solves the day without rebuilding a map or
 * re-fetching a style. One network request of its own: GET of the style URL (ADR-008), exactly
 * as on /map-preview.
 *
 * §9: the map is never the only way to read this. The list under the canvas names every van the
 * day has, says how many stops it drives, and selects it with a keyboard — which is the same
 * selection the lane's own "Show on the map" button makes and the same one a click on the line
 * makes. Selecting is a state with three cues (a check mark, a ring, a heavier line), never a
 * colour on its own.
 *
 * No database, no sending, no clock: the plan is computed in the browser from the synthetic day.
 */

import {
  AttributionControl,
  config as maplibreConfig,
  Map as MapLibreMap,
  NavigationControl,
  type LngLatLike,
} from "maplibre-gl";
import { Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PlanMapData } from "@/domain/plan/map";
import { planMapCoords } from "@/domain/plan/map";
import { countable, fill, fleetMap, planRoutes, pluralize } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import styles from "./plan-map.module.css";
import {
  ATTRIBUTION_HTML,
  applyPositronOverrides,
  boundsOf,
  cameraMove,
  centerOfBounds,
  MAP_SOURCE_IDS,
  MAP_WORKER_URL,
  PLAN_LAYER_IDS,
  PLAN_SOURCE_IDS,
  planMapLayers,
  planRoutesGeoJson,
  planStopsGeoJson,
  pointGeoJson,
  resolveMapStyleUrl,
  routeColor,
  type Bounds,
  type CameraMove,
  type Coord,
  type StyleLike,
} from "./style";

/** How far out the pane opens when the plan is one point: the centre and nothing else. */
const CENTER_ONLY_ZOOM = 11.5;

/** Read at interaction time, so a mid-session OS change is honoured (§9). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** MapLibre hands centers back in several shapes; we only ever want `[lng, lat]`. */
function toCoord(center: LngLatLike): Coord {
  if (Array.isArray(center)) return [center[0], center[1]];
  if ("lon" in center) return [center.lon, center.lat];
  return [center.lng, center.lat];
}

function applyCameraMove(map: MapLibreMap, move: CameraMove): void {
  if (move.method === "jumpTo") {
    map.jumpTo({ center: move.center, zoom: move.zoom });
    return;
  }
  map.flyTo({ center: move.center, zoom: move.zoom, duration: move.duration });
}

/** Fit the camera to a set of coordinates, or centre on the one point there is. */
function fitTo(map: MapLibreMap, coords: readonly Coord[]): void {
  const bounds: Bounds | null = boundsOf(coords);
  if (!bounds) return;
  const [[west, south], [east, north]] = bounds;
  if (west === east && south === north) {
    applyCameraMove(
      map,
      cameraMove({ center: bounds[0], zoom: CENTER_ONLY_ZOOM }, prefersReducedMotion()),
    );
    return;
  }
  const camera = map.cameraForBounds(bounds, { padding: 56 });
  const target = camera?.center
    ? { center: toCoord(camera.center), zoom: camera.zoom }
    : { center: centerOfBounds(bounds) };
  applyCameraMove(map, cameraMove(target, prefersReducedMotion()));
}

export interface PlanMapProps {
  data: PlanMapData;
  /** The lane whose route is in front, or null while every van is shown at full strength. */
  selectedLaneId: string | null;
  onSelect: (laneId: string | null) => void;
}

export default function PlanMap({ data, selectedLaneId, onSelect }: PlanMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const styleUrl = useMemo(() => resolveMapStyleUrl(process.env.NEXT_PUBLIC_MAP_TILE_URL), []);

  /*
   * The latest plan and the latest selection, readable from inside the build effect without
   * making the map depend on either. Declared before it, so they are already written by the time
   * the map is built on mount.
   */
  const dataRef = useRef(data);
  const selectedRef = useRef(selectedLaneId);
  const selectRef = useRef(onSelect);
  useEffect(() => {
    dataRef.current = data;
    selectedRef.current = selectedLaneId;
    selectRef.current = onSelect;
  }, [data, selectedLaneId, onSelect]);

  // Build the map once per mount (or retry). Strict-mode double-invoke is safe: the cleanup
  // removes the map and the style fetch is aborted.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const abort = new AbortController();
    let map: MapLibreMap | null = null;
    let cancelled = false;

    (async () => {
      let style: StyleLike;
      try {
        const res = await fetch(styleUrl, { signal: abort.signal });
        if (!res.ok) throw new Error(`style request failed (${res.status})`);
        style = applyPositronOverrides((await res.json()) as StyleLike);
      } catch (e) {
        if (abort.signal.aborted || cancelled) return;
        setError(
          e instanceof Error && e.name === "AbortError"
            ? fleetMap.tilesFailed
            : fleetMap.tilesFailedDetail,
        );
        return;
      }
      if (cancelled) return;

      // Before the first map, and therefore before the first worker: see MAP_WORKER_URL.
      maplibreConfig.WORKER_URL = MAP_WORKER_URL;
      map = new MapLibreMap({
        container,
        style: style as never,
        center: dataRef.current.center,
        zoom: CENTER_ONLY_ZOOM,
        // Our own control follows, so the licence text is ours to compose.
        attributionControl: false,
      });
      mapRef.current = map;

      // ADR-008 / §5.1: compact attribution, bottom-right, never removed. `customAttribution`
      // is added to what the OpenFreeMap TileJSON already carries, so OpenMapTiles and OSM stay
      // credited too.
      map.addControl(
        new AttributionControl({ compact: true, customAttribution: ATTRIBUTION_HTML }),
        "bottom-right",
      );
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");

      map.on("error", (e) => {
        // Tile hiccups must not blank the pane; surface them without tearing down.
        console.warn("[PlanMap] maplibre error", e.error ?? e);
      });

      map.on("load", () => {
        if (!map) return;
        const plan = dataRef.current;
        const selected = selectedRef.current;
        map.addSource(PLAN_SOURCE_IDS.routes, {
          type: "geojson",
          data: planRoutesGeoJson(plan.routes, selected) as never,
        });
        map.addSource(PLAN_SOURCE_IDS.stops, {
          type: "geojson",
          data: planStopsGeoJson(plan.routes, selected) as never,
        });
        map.addSource(MAP_SOURCE_IDS.center, {
          type: "geojson",
          data: pointGeoJson(plan.center, plan.centerLabel) as never,
        });
        for (const layer of planMapLayers()) map.addLayer(layer as never);

        /*
         * A click on a van's line or on one of its stops is the same selection the list below
         * makes, and clicking the one already in front puts every van back at full strength —
         * so the map can be used to look at one van and then at all of them without reaching
         * for the list.
         */
        const pick = (laneId: string) =>
          selectRef.current(selectedRef.current === laneId ? null : laneId);
        for (const layerId of [PLAN_LAYER_IDS.routeLine, PLAN_LAYER_IDS.stopCircle]) {
          map.on("click", layerId, (e) => {
            const laneId = e.features?.[0]?.properties?.laneId;
            if (typeof laneId === "string" && laneId.length > 0) pick(laneId);
          });
          map.on("mouseenter", layerId, () => {
            if (map) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layerId, () => {
            if (map) map.getCanvas().style.cursor = "";
          });
        }

        fitTo(map, planMapCoords(plan));
        setError(null);
        setReady(true);
      });

      /*
       * What actually got painted, published on the container.
       *
       * MapLibre draws into a WebGL canvas, so "the basemap is there" and "the three vans have
       * lines" are invisible to the DOM: a pane that drew nothing looks exactly like a pane that
       * drew a whole city. `queryRenderedFeatures` is MapLibre's own answer to "what is on
       * screen", and `idle` is the event that means it has stopped arriving — so on idle the
       * pane writes down how many basemap features it is showing and which vans it has lines
       * for, and e2e/plan-routes.spec.ts reads both before it takes the screenshot.
       */
      map.on("idle", () => {
        if (!map) return;
        const ours = new Set<string>(Object.values(PLAN_LAYER_IDS));
        const basemap = map
          .queryRenderedFeatures()
          .filter((f) => !ours.has(String(f.layer?.id ?? "")));
        const drawn = map
          .queryRenderedFeatures({ layers: [PLAN_LAYER_IDS.routeLine] })
          .map((f) => String(f.properties?.laneId ?? ""))
          .filter((id) => id.length > 0);
        container.dataset.basemapFeatures = String(basemap.length);
        container.dataset.routesDrawn = [...new Set(drawn)].sort().join(",");
      });
    })();

    return () => {
      cancelled = true;
      abort.abort();
      setReady(false);
      mapRef.current = null;
      map?.remove();
    };
  }, [styleUrl, attempt]);

  // Every later change — a move, a plan, a substitution, a selection — is three `setData` calls.
  // No rebuild, no refetch.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const setData = (id: string, value: unknown): void => {
      const source = map.getSource(id);
      if (source && "setData" in source) {
        (source as { setData: (d: unknown) => void }).setData(value);
      }
    };
    setData(PLAN_SOURCE_IDS.routes, planRoutesGeoJson(data.routes, selectedLaneId));
    setData(PLAN_SOURCE_IDS.stops, planStopsGeoJson(data.routes, selectedLaneId));
    setData(MAP_SOURCE_IDS.center, pointGeoJson(data.center, data.centerLabel));
  }, [data, selectedLaneId, ready]);

  /*
   * The camera re-frames on two things and no others: a van being picked, and the map going from
   * nothing to something. Picking is the action that means "show me this", and the first plan is
   * the moment there is anything to show — in between, a coordinator moving a child between two
   * lanes is reading the lanes, and a pane that flew somewhere on every drop would be reading
   * over their shoulder.
   */
  const selectedLine = data.routes.find((route) => route.laneId === selectedLaneId)?.line ?? [];
  const framing = `${selectedLaneId ?? ""}:${data.empty ? "empty" : "plan"}`;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    fitTo(map, selectedLine.length > 0 ? selectedLine : planMapCoords(data));
    // Re-framed when the pick or the emptiness changes, not when the plan is rearranged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing, ready]);

  const fitEverything = useCallback(() => {
    const map = mapRef.current;
    if (map) fitTo(map, planMapCoords(dataRef.current));
  }, []);

  return (
    <div className={styles.pane}>
      {/*
        The van toggles sit **on** the map (the re-cut §1.2 mockup, 2026-10-17): chips along the
        top, one per van, each a swatch and the van's own name. The paragraph that used to sit
        under the pane ("Each van's stops… A straight line is direct…") is gone — Vera's
        differences list counts it as the one over-long line on this screen, and what it said is
        in each chip's own label instead.
      */}
      <ul className={styles.vans} aria-label={planRoutes.mapVansHeading}>
        {data.routes.map((route) => (
          <li key={route.laneId}>
            <button
              type="button"
              className={styles.vanButton}
              data-van-line={route.laneId}
              aria-pressed={route.laneId === selectedLaneId}
              title={fill(planRoutes.mapVanRow, {
                vehicle: route.vanName,
                stops: pluralize(route.stops.length, countable.stop),
              })}
              onClick={() => onSelect(route.laneId === selectedLaneId ? null : route.laneId)}
            >
              {route.laneId === selectedLaneId ? (
                <Check size={icon.inline} aria-hidden="true" />
              ) : null}
              <span
                className={styles.swatch}
                aria-hidden="true"
                style={{ "--van-line": routeColor(route.colorIndex) } as React.CSSProperties}
              />
              <span className={styles.vanName}>{route.vanName}</span>
              <span className="srOnly">
                {fill(planRoutes.mapVanRow, {
                  vehicle: route.vanName,
                  stops: pluralize(route.stops.length, countable.stop),
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.canvasWrap}>
        <div
          ref={containerRef}
          className={styles.canvas}
          role="region"
          aria-label={planRoutes.mapLabel}
        />
        <div className={styles.overlay}>
          <button
            type="button"
            className={styles.button}
            onClick={fitEverything}
            disabled={!ready}
          >
            {planRoutes.mapFitAll}
          </button>
          {/* Nobody is in a van yet: the map has the centre on it and says what to press. */}
          {data.empty && !error ? <p className={styles.empty}>{planRoutes.mapEmpty}</p> : null}
          {error ? (
            <p className={styles.notice} role="alert">
              {error}
              <br />
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                {fleetMap.retry}
              </button>
            </p>
          ) : null}
        </div>
      </div>

      {selectedLaneId !== null ? (
        <button type="button" className={styles.button} onClick={() => onSelect(null)}>
          {planRoutes.mapShowAll}
        </button>
      ) : null}
    </div>
  );
}
