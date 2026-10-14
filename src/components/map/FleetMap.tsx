"use client";

/**
 * M5 fleet map pane (PRD §14 SURF-01 "map right 40%"; DESIGN-DIRECTION §5 / §5.1).
 *
 * The only module that talks to MapLibre. Everything decidable without a browser —
 * the positron overrides, our layer paints, the camera move, freshness wording — lives
 * in ./style.ts and is unit-tested there.
 *
 * Data comes in as a prop (src/fixtures/map.ts for the preview). This component never
 * reads the database and makes exactly one network request of its own: GET of the
 * style URL, so the §5.1 overrides can be applied to the fetched style JSON before the
 * map is built.
 */

import { AttributionControl, Map as MapLibreMap, NavigationControl, type LngLatLike } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapFixture } from "@/fixtures/map";
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
  MAP_LAYER_IDS,
  MAP_SOURCE_IDS,
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

export default function FleetMap({ fixture, label = "Fleet map" }: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const styleUrl = useMemo(
    () => resolveMapStyleUrl(process.env.NEXT_PUBLIC_MAP_STYLE_URL),
    [],
  );

  const vehicleCoords = useMemo<Coord[]>(() => fixture.vehicles.map((v) => v.coord), [fixture]);

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
          e instanceof Error && e.name === "AbortError"
            ? "Map tiles did not load."
            : "Map tiles did not load. The board below is unaffected.",
        );
        return;
      }
      if (cancelled) return;

      map = new MapLibreMap({
        container,
        style: style as never,
        center: fixture.center,
        zoom: fixture.initialZoom,
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
        map.addSource(MAP_SOURCE_IDS.routesPlanned, {
          type: "geojson",
          data: plannedRoutesGeoJson(fixture.routes) as never,
        });
        map.addSource(MAP_SOURCE_IDS.routesDriven, {
          type: "geojson",
          data: drivenRoutesGeoJson(fixture.routes) as never,
        });
        map.addSource(MAP_SOURCE_IDS.stops, {
          type: "geojson",
          data: stopsGeoJson(fixture.stops) as never,
        });
        map.addSource(MAP_SOURCE_IDS.center, {
          type: "geojson",
          data: pointGeoJson(fixture.center, fixture.centerLabel) as never,
        });
        map.addSource(MAP_SOURCE_IDS.vehicles, {
          type: "geojson",
          data: vehiclesGeoJson(fixture.vehicles, null) as never,
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
    })();

    return () => {
      cancelled = true;
      abort.abort();
      setReady(false);
      mapRef.current = null;
      map?.remove();
    };
  }, [fixture, styleUrl, attempt]);

  // Keep the vehicle source in step with the selection (ring size + label).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(MAP_SOURCE_IDS.vehicles);
    if (source && "setData" in source) {
      (source as { setData: (d: unknown) => void }).setData(
        vehiclesGeoJson(fixture.vehicles, selectedId),
      );
    }
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
            Fit all vehicles
          </button>
          {error ? (
            <p className={styles.notice} role="alert">
              {error}
              <br />
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </p>
          ) : null}
        </div>
      </div>

      {/* §9: the map is never the only way. This list mirrors it for keyboard and
          screen-reader users, and selecting a row drives the same camera move. */}
      <div>
        <h3 className={styles.listTitle} id="fleet-map-vehicles">
          Vehicles
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
                    {vehicle.id} · {vehicle.description}
                  </span>
                  <span className={styles.vehicleMeta}>
                    {vehicle.owner} · {vehicle.stateLabel}
                  </span>
                  <span className={`${styles.freshness} ${TONE_CLASS[tone]}`}>
                    GPS: {gpsFreshnessLabel(vehicle.gpsAgeSeconds)}
                  </span>
                  <span className={styles.vehicleMeta}>Source: {fixture.sourceLabel}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
