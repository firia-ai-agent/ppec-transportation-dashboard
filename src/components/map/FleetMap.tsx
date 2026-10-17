"use client";

/**
 * M5 fleet map pane (PRD §14 SURF-01 "map right 40%"; DESIGN-DIRECTION §5 / §5.1).
 *
 * The only module that talks to MapLibre. Everything decidable without a browser —
 * the positron overrides, our layer paints, the camera move, freshness wording — lives
 * in ./style.ts and is unit-tested there.
 *
 * Data comes in as a prop (src/fixtures/map.ts for the still-life preview, a simulated
 * run on /live-map). The map is built **once** per mount and every later data change
 * is pushed into the five GeoJSON sources with `setData`, so a clock ticking four times
 * a second never rebuilds a MapLibre instance or re-fetches the style. This component
 * never reads the database and makes exactly one network request of its own: GET of the
 * style URL, so the §5.1 overrides can be applied before the map is built.
 */

import {
  AttributionControl,
  config as maplibreConfig,
  Map as MapLibreMap,
  NavigationControl,
  type LngLatLike,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapFixture } from "@/fixtures/map";
import { fill, fleetMap as copy } from "@/ui/copy";
import styles from "./fleet-map.module.css";
import {
  ATTRIBUTION_HTML,
  applyPositronOverrides,
  boundsOf,
  cameraMove,
  centerOfBounds,
  drivenRoutesGeoJson,
  fleetMapLayers,
  gpsFreshnessLabel,
  HEADING_ICON_ID,
  headingChevronImage,
  MAP_LAYER_IDS,
  MAP_SOURCE_IDS,
  MAP_WORKER_URL,
  plannedRoutesGeoJson,
  pointGeoJson,
  resolveMapStyleUrl,
  SELECTION_ZOOM,
  stopsGeoJson,
  truckTone,
  vehiclesGeoJson,
  type CameraMove,
  type Coord,
  type StyleLike,
} from "./style";

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

/**
 * What a stop's ETA cell says. Arrivals read "Arrived (vehicle)" — never "Handed off",
 * because a geofence cannot complete a handoff (AT-10, SURF-01 l.1058). A stale vehicle
 * shows its last published window with the pause spelled out (LOC-03).
 */
export function stopWindowText(
  status: "arrived" | "passed" | "pending",
  windowText?: string,
  etaTextSuppressed?: boolean,
): string {
  if (status === "arrived") return copy.arrived;
  if (status === "passed") return copy.passed;
  if (!windowText) return copy.windowPending;
  return etaTextSuppressed ? fill(copy.windowPaused, { window: windowText }) : windowText;
}

const TONE_CLASS = {
  ok: styles.toneOk,
  stale: styles.toneStale,
  crit: styles.toneCrit,
} as const;

export interface FleetMapProps {
  fixture: MapFixture;
  /** Accessible name for the map region. */
  label?: string;
}

export default function FleetMap({ fixture, label = copy.label }: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const styleUrl = useMemo(
    () => resolveMapStyleUrl(process.env.NEXT_PUBLIC_MAP_TILE_URL),
    [],
  );

  const vehicleCoords = useMemo<Coord[]>(() => fixture.vehicles.map((v) => v.coord), [fixture]);

  // The latest data, readable from inside the build effect without making the map
  // depend on it. This effect is declared first, so it has already run by the time the
  // build effect below reads the ref on mount.
  const dataRef = useRef(fixture);
  useEffect(() => {
    dataRef.current = fixture;
  }, [fixture]);

  // Build the map once per mount (or retry). Strict-mode double-invoke is safe: the
  // cleanup removes the map and the fetch is aborted.
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
          e instanceof Error && e.name === "AbortError" ? copy.tilesFailed : copy.tilesFailedDetail,
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
        zoom: dataRef.current.initialZoom,
        // Our own control follows, so the licence text is ours to compose.
        attributionControl: false,
      });
      mapRef.current = map;

      // DESIGN-DIRECTION §5.1 / ADR-008: compact attribution, bottom-right, never
      // removed. `customAttribution` is added to the attribution the OpenFreeMap
      // TileJSON already carries, so OpenMapTiles and OSM stay credited too.
      map.addControl(
        new AttributionControl({ compact: true, customAttribution: ATTRIBUTION_HTML }),
        "bottom-right",
      );
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");

      map.on("error", (e) => {
        // Tile hiccups must not blank the pane; surface them without tearing down.
        console.warn("[FleetMap] maplibre error", e.error ?? e);
      });

      map.on("load", () => {
        if (!map) return;
        const data = dataRef.current;
        // The §5.1 heading chevron is raw RGBA from a pure builder, so it needs no
        // sprite from the tile server and no glyph coverage.
        if (!map.hasImage(HEADING_ICON_ID)) map.addImage(HEADING_ICON_ID, headingChevronImage());
        map.addSource(MAP_SOURCE_IDS.routesPlanned, {
          type: "geojson",
          data: plannedRoutesGeoJson(data.routes) as never,
        });
        map.addSource(MAP_SOURCE_IDS.routesDriven, {
          type: "geojson",
          data: drivenRoutesGeoJson(data.routes) as never,
        });
        map.addSource(MAP_SOURCE_IDS.stops, {
          type: "geojson",
          data: stopsGeoJson(data.stops) as never,
        });
        map.addSource(MAP_SOURCE_IDS.center, {
          type: "geojson",
          data: pointGeoJson(data.center, data.centerLabel) as never,
        });
        map.addSource(MAP_SOURCE_IDS.vehicles, {
          type: "geojson",
          data: vehiclesGeoJson(data.vehicles, null) as never,
        });
        for (const layer of fleetMapLayers()) map.addLayer(layer as never);

        map.on("click", MAP_LAYER_IDS.vehicleCircle, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id === "string") setSelectedId(id);
        });
        map.on("mouseenter", MAP_LAYER_IDS.vehicleCircle, () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", MAP_LAYER_IDS.vehicleCircle, () => {
          if (map) map.getCanvas().style.cursor = "";
        });

        setError(null);
        setReady(true);
      });

      /*
       * What actually got painted, published on the container.
       *
       * MapLibre draws into a WebGL canvas, so "the basemap is there" and "V1, V2 and V3 have
       * markers" are invisible to the DOM: a pane that drew nothing at all looks exactly like
       * a pane that drew a whole city, which is how a blank map survived a browser check once
       * already. `queryRenderedFeatures` is MapLibre's own answer to "what is on screen right
       * now", and `idle` is the event that means it has stopped arriving — so on idle the pane
       * writes down the count of basemap features it is showing and the ids of the vehicles it
       * has markers for, and e2e/screens.spec.ts reads them before it takes the screenshot.
       */
      map.on("idle", () => {
        if (!map) return;
        const ours = new Set<string>(Object.values(MAP_LAYER_IDS));
        const rendered = map.queryRenderedFeatures();
        const basemap = rendered.filter((f) => !ours.has(String(f.layer?.id ?? "")));
        const vehicles = map
          .queryRenderedFeatures({ layers: [MAP_LAYER_IDS.vehicleCircle] })
          .map((f) => String(f.properties?.id ?? ""))
          .filter((id) => id.length > 0);
        container.dataset.basemapFeatures = String(basemap.length);
        container.dataset.vehiclesDrawn = [...new Set(vehicles)].sort().join(",");
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

  // Push data on every change: vehicle positions and tones, the driven line growing
  // behind each truck, and the selection ring. No rebuild, no refetch.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const setData = (id: string, data: unknown): void => {
      const source = map.getSource(id);
      if (source && "setData" in source) (source as { setData: (d: unknown) => void }).setData(data);
    };
    setData(MAP_SOURCE_IDS.vehicles, vehiclesGeoJson(fixture.vehicles, selectedId));
    setData(MAP_SOURCE_IDS.routesDriven, drivenRoutesGeoJson(fixture.routes));
    setData(MAP_SOURCE_IDS.routesPlanned, plannedRoutesGeoJson(fixture.routes));
    setData(MAP_SOURCE_IDS.stops, stopsGeoJson(fixture.stops));
  }, [fixture, ready, selectedId]);

  const fitAllVehicles = useCallback(() => {
    const map = mapRef.current;
    const bounds = boundsOf(vehicleCoords);
    if (!map || !bounds) return;
    const camera = map.cameraForBounds(bounds, { padding: 56 });
    const target = camera?.center
      ? { center: toCoord(camera.center), zoom: camera.zoom }
      : { center: centerOfBounds(bounds) };
    applyCameraMove(map, cameraMove(target, prefersReducedMotion()));
  }, [vehicleCoords]);

  const selectVehicle = useCallback(
    (id: string, coord: Coord) => {
      setSelectedId(id);
      const map = mapRef.current;
      if (!map) return;
      applyCameraMove(map, cameraMove({ center: coord, zoom: SELECTION_ZOOM }, prefersReducedMotion()));
    },
    [],
  );

  return (
    <div className={styles.pane}>
      <div className={styles.canvasWrap}>
        <div ref={containerRef} className={styles.canvas} role="region" aria-label={label} />
        <div className={styles.overlay}>
          <button type="button" className={styles.fitButton} onClick={fitAllVehicles} disabled={!ready}>
            {copy.fitAll}
          </button>
          {error ? (
            <p className={styles.notice} role="alert">
              {error}
              <br />
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                {copy.retry}
              </button>
            </p>
          ) : null}
        </div>
      </div>

      {/* §9: the map is never the only way. This list mirrors it for keyboard and
          screen-reader users, and selecting a row drives the same camera move. */}
      <div>
        <h3 className={styles.listTitle} id="fleet-map-vehicles">
          {copy.vehiclesHeading}
        </h3>
        <ul className={styles.list} aria-labelledby="fleet-map-vehicles">
          {fixture.vehicles.map((vehicle) => {
            const tone = truckTone(vehicle.gpsAgeSeconds);
            return (
              <li key={vehicle.id}>
                <button
                  type="button"
                  className={styles.vehicleButton}
                  aria-pressed={selectedId === vehicle.id}
                  onClick={() => selectVehicle(vehicle.id, vehicle.coord)}
                >
                  <span className={styles.vehicleId}>
                    {fill(copy.vehicleRow, { id: vehicle.id, description: vehicle.description })}
                  </span>
                  <span className={styles.vehicleMeta}>
                    {fill(copy.vehicleMeta, { owner: vehicle.owner, state: vehicle.stateLabel })}
                  </span>
                  <span className={`${styles.freshness} ${TONE_CLASS[tone]}`}>
                    {fill(copy.gps, { age: gpsFreshnessLabel(vehicle.gpsAgeSeconds) })}
                  </span>
                  {vehicle.stoppedSeconds !== undefined && vehicle.stoppedSeconds >= 60 ? (
                    <span className={styles.vehicleMeta}>
                      {/* DESIGN-DIRECTION §5.1: a stall is words and a clock, not a colour. */}
                      {fill(copy.stopped, { minutes: Math.floor(vehicle.stoppedSeconds / 60) })}
                    </span>
                  ) : null}
                  {vehicle.exceptionRaised ? (
                    <span className={`${styles.freshness} ${styles.toneCrit}`}>
                      {copy.locationLost}
                    </span>
                  ) : null}
                  {vehicle.stops && vehicle.stops.length > 0 ? (
                    <span className={styles.stopList}>
                      {vehicle.stops.map((stop) => (
                        <span key={stop.stopId} className={styles.stopRow}>
                          {/* COPY-GUIDE §1–§2: the family code ("F4") is a build-internal label,
                              so the card's words are the place alone. The code rides along in
                              `title` only, for the reviewer who needs it; the span has text of its
                              own, so the tooltip never becomes the accessible name either. */}
                          <span
                            className={styles.stopName}
                            title={
                              stop.familyLabel
                                ? fill(copy.stopFamily, { stop: stop.name, family: stop.familyLabel })
                                : undefined
                            }
                          >
                            {stop.name}
                          </span>
                          <span className={styles.vehicleMeta}>
                            {stopWindowText(stop.status, stop.windowText, vehicle.etaTextSuppressed)}
                          </span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className={styles.vehicleMeta}>
                    {fill(copy.source, { label: fixture.sourceLabel })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
