"use client";

/**
 * The map itself: #53's MapLibre engine, drawing the founder's screen.
 *
 * The engine is reused whole and unchanged — the positron style fetch and the §5.1 overrides,
 * the worker URL, the attribution control, the camera move, the `idle` publication that lets a
 * browser check prove the tiles actually drew (all from src/components/map/style.ts). What is
 * this screen's own is the *paint*: one colour per van, from the app's one van palette
 * (./map-layers.ts), so the line, the pin and the square beside a van's name all match.
 *
 * What is NOT reused is #53's UI around the pane — the "Fit all" button, the vehicle list with
 * its freshness pills and ETA windows, the notification-decision log. That list is the screen
 * the founder's redesign replaces; the list beside this map is ./VanList.tsx and it carries one
 * chip per van and no ETA.
 *
 * **Credits collapse to an (i).** ADR-008 and §5.1 require the basemap's attribution to be
 * present and never removed, and png/live-map.png has no licence strip across the bottom of the
 * map. MapLibre's own compact `AttributionControl` is both at once: the credits are always in
 * the page, behind a round button, and one click opens them. The button's accessible name is
 * ours (`liveMap.credits`), because MapLibre's default is a string this app does not own.
 *
 * One request leaves this component: GET of the style URL. No database, no SSE, no sending.
 */

import {
  AttributionControl,
  config as maplibreConfig,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  applyPositronOverrides,
  ATTRIBUTION_HTML,
  cameraMove,
  MAP_WORKER_URL,
  resolveMapStyleUrl,
  SELECTION_ZOOM,
  type Coord,
  type StyleLike,
} from "@/components/map/style";
import { fleetMap, liveMap } from "@/ui/copy";
import {
  liveMapLayers,
  livePointGeoJson,
  liveRoutesGeoJson,
  liveStopsGeoJson,
  liveVansGeoJson,
  LIVE_LAYER_IDS,
  LIVE_SOURCE_IDS,
  type DrawableVan,
} from "./map-layers";
import styles from "./live-map.module.css";

/** Read at interaction time, so a mid-session OS change is honoured (§9). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * THE CREDITS, AS THE FOUNDER'S (i).
 *
 * MapLibre's compact attribution control is the right control — the licence text is in the page
 * from the first paint, which is what ADR-008 and §5.1 mean by "never removed", and a button
 * opens it — but its default is not the mockup's. Two corrections, both idempotent, because
 * MapLibre rebuilds this control's contents whenever the style's own attributions change:
 *
 *  1. **It starts open.** `compact` means "collapsible", and MapLibre adds `maplibregl-compact`
 *     *and* `maplibregl-compact-show` on init — the licence line written across the bottom of
 *     the map, which is the one thing png/live-map.png does not have. Dropping `-show` starts it
 *     collapsed; the button adds it back, and MapLibre will not re-add it on its own once
 *     `maplibregl-compact` is on the element.
 *  2. **Its button is named by a string this app does not own.** src/ui/copy.ts is the only
 *     place words live, so the toggle takes `liveMap.credits` — which is also the name
 *     e2e/live-map.spec.ts clicks it by.
 */
function dressCredits(container: HTMLElement): void {
  container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  const toggle = container.querySelector(".maplibregl-ctrl-attrib-button");
  if (toggle && toggle.getAttribute("aria-label") !== liveMap.credits) {
    toggle.setAttribute("aria-label", liveMap.credits);
    toggle.setAttribute("title", liveMap.credits);
  }
}

export interface LiveMapPaneProps {
  vans: readonly DrawableVan[];
  center: Coord;
  centerLabel: string;
  /** Accessible name of the map region (§9). */
  label: string;
  /** The van a coordinator has selected: it takes a ring, and the camera goes to it. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Overlaid on the map when the day has no saved plan: the mockup's "No routes yet" card. */
  children?: React.ReactNode;
}

export default function LiveMapPane({
  vans,
  center,
  centerLabel,
  label,
  selectedId,
  onSelect,
  children,
}: LiveMapPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The latest data, readable from inside the build effect without making the map depend on it.
  const dataRef = useRef({ vans, center, centerLabel });
  useEffect(() => {
    dataRef.current = { vans, center, centerLabel };
  }, [vans, center, centerLabel]);

  // A click has to reach the current handler, not the one that was current when the map built.
  const selectRef = useRef(onSelect);
  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  // Build once per mount (or retry). Strict-mode double-invoke is safe: the cleanup removes the
  // map and aborts the fetch.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const abort = new AbortController();
    const styleUrl = resolveMapStyleUrl(process.env.NEXT_PUBLIC_MAP_TILE_URL);
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

      // Before the first map, and therefore before the first worker (see MAP_WORKER_URL).
      maplibreConfig.WORKER_URL = MAP_WORKER_URL;
      map = new MapLibreMap({
        container,
        style: style as never,
        center: dataRef.current.center,
        zoom: 11,
        // Our own control follows, so the licence text is ours to compose.
        attributionControl: false,
      });
      mapRef.current = map;

      /*
       * The credits, collapsed. `compact` is MapLibre's own (i) button: the text is in the DOM
       * from the first paint and the button opens it, so ADR-008's "never removed" and the
       * mockup's clean map edge are the same control. `customAttribution` is added to whatever
       * the tile server's TileJSON already carries, so OpenMapTiles and OSM stay credited.
       */
      const attribution = new AttributionControl({
        compact: true,
        customAttribution: ATTRIBUTION_HTML,
      });
      map.addControl(attribution, "bottom-right");
      dressCredits(container);
      map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

      map.on("error", (e) => {
        // Tile hiccups must not blank the pane; surface them without tearing down.
        console.warn("[LiveMapPane] maplibre error", e.error ?? e);
      });

      map.on("load", () => {
        if (!map) return;
        // The control's button and its classes are built from the style's own attributions, so
        // they do not all exist at `addControl` time: dressing them again here is what actually
        // takes (see dressCredits, which is idempotent).
        dressCredits(container);
        const data = dataRef.current;
        map.addSource(LIVE_SOURCE_IDS.routesPlanned, {
          type: "geojson",
          data: liveRoutesGeoJson(data.vans, "planned") as never,
        });
        map.addSource(LIVE_SOURCE_IDS.routesDriven, {
          type: "geojson",
          data: liveRoutesGeoJson(data.vans, "driven") as never,
        });
        map.addSource(LIVE_SOURCE_IDS.stops, {
          type: "geojson",
          data: liveStopsGeoJson(data.vans) as never,
        });
        map.addSource(LIVE_SOURCE_IDS.center, {
          type: "geojson",
          data: livePointGeoJson(data.center, data.centerLabel) as never,
        });
        map.addSource(LIVE_SOURCE_IDS.vans, {
          type: "geojson",
          data: liveVansGeoJson(data.vans, null) as never,
        });
        for (const layer of liveMapLayers()) map.addLayer(layer as never);

        map.on("click", LIVE_LAYER_IDS.vanCircle, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id === "string") selectRef.current(id);
        });
        map.on("mouseenter", LIVE_LAYER_IDS.vanCircle, () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", LIVE_LAYER_IDS.vanCircle, () => {
          if (map) map.getCanvas().style.cursor = "";
        });

        setError(null);
        setReady(true);
      });

      /*
       * What actually got painted, published on the container.
       *
       * MapLibre draws into a WebGL canvas, so "the basemap is there" and "every van has a pin"
       * are invisible to the DOM: a pane that drew nothing looks exactly like one that drew a
       * whole county, which is how a blank map survived a browser check once already.
       * `queryRenderedFeatures` is MapLibre's own answer to "what is on screen", and `idle` is
       * the event that means it has stopped arriving — so e2e/live-map.spec.ts reads these two
       * attributes before it asserts anything about the map.
       */
      map.on("idle", () => {
        if (!map) return;
        dressCredits(container);
        const ours = new Set<string>(Object.values(LIVE_LAYER_IDS));
        const rendered = map.queryRenderedFeatures();
        container.dataset.basemapFeatures = String(
          rendered.filter((f) => !ours.has(String(f.layer?.id ?? ""))).length,
        );
        const drawn = map
          .queryRenderedFeatures({ layers: [LIVE_LAYER_IDS.vanCircle] })
          .map((f) => String(f.properties?.number ?? ""))
          .filter((n) => n.length > 0);
        container.dataset.vansDrawn = [...new Set(drawn)].sort().join(",");
        /*
         * And in what colour. The founder's ruling is that a van's line, pin, square and legend
         * swatch are one colour (11:25 PM ET), and three of those four are in the DOM where a
         * test can read them — the fourth is inside a canvas. So the pin's own paint is
         * published here, van number to colour, and e2e compares it with the three in the DOM.
         */
        container.dataset.vanColors = map
          .queryRenderedFeatures({ layers: [LIVE_LAYER_IDS.vanCircle] })
          .map((f) => `${f.properties?.number}:${String(f.properties?.color ?? "")}`)
          .sort()
          .join(",");
      });
    })();

    return () => {
      cancelled = true;
      abort.abort();
      setReady(false);
      mapRef.current = null;
      map?.remove();
    };
  }, [attempt]);

  // Push data on every clock tick: positions, the driven line growing behind each van, the
  // selection ring. No rebuild, no refetch.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const setData = (id: string, data: unknown): void => {
      const source = map.getSource(id);
      if (source && "setData" in source) (source as { setData: (d: unknown) => void }).setData(data);
    };
    setData(LIVE_SOURCE_IDS.vans, liveVansGeoJson(vans, selectedId));
    setData(LIVE_SOURCE_IDS.routesDriven, liveRoutesGeoJson(vans, "driven"));
    setData(LIVE_SOURCE_IDS.routesPlanned, liveRoutesGeoJson(vans, "planned"));
    setData(LIVE_SOURCE_IDS.stops, liveStopsGeoJson(vans));
  }, [vans, ready, selectedId]);

  // Selecting a van in the list moves the camera to it, the §9 way round: the list is the
  // non-map way to read the fleet, so it drives the map rather than the other way about.
  const selectedCoord = vans.find((van) => van.id === selectedId)?.coord;
  const lastFlownTo = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selectedId || !selectedCoord) return;
    // Only when the *selection* changes: a clock tick must not drag the camera every 250 ms.
    if (lastFlownTo.current === selectedId) return;
    lastFlownTo.current = selectedId;
    const move = cameraMove({ center: selectedCoord, zoom: SELECTION_ZOOM }, prefersReducedMotion());
    if (move.method === "jumpTo") map.jumpTo({ center: move.center, zoom: move.zoom });
    else map.flyTo({ center: move.center, zoom: move.zoom, duration: move.duration });
  }, [selectedId, selectedCoord, ready]);

  return (
    <div className={styles.mapw}>
      <div ref={containerRef} className={styles.canvas} role="region" aria-label={label} />
      {error ? (
        <p className={styles.tileNotice} role="alert">
          {error}
          <br />
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            {fleetMap.retry}
          </button>
        </p>
      ) : null}
      {children}
    </div>
  );
}
