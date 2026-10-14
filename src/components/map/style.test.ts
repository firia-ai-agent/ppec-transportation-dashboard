import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_HTML,
  ATTRIBUTION_TEXT,
  applyPositronOverrides,
  boundsOf,
  CAMERA_DURATION_MS,
  cameraMove,
  centerOfBounds,
  DEFAULT_MAP_STYLE_URL,
  DEMO_VIOLET,
  DETAIL_MIN_ZOOM,
  drivenRoutesGeoJson,
  fleetMapLayers,
  formatGpsAge,
  gpsBand,
  gpsFreshnessLabel,
  isBasemapLabelLayerId,
  isDetailLayerId,
  LABEL_HALO_WIDTH,
  MAP_LAYER_IDS,
  MAP_TOKENS,
  plannedRoutesGeoJson,
  resolveMapStyleUrl,
  truckTone,
  type Coord,
  type StyleLike,
  vehicleMapLabel,
  vehiclesGeoJson,
} from "./style";

/**
 * A trimmed stand-in for the real OpenFreeMap positron style: one layer per override
 * row in DESIGN-DIRECTION §5.1 plus layers that must be left alone. Paint values are
 * the real positron defaults (fetched from
 * https://tiles.openfreemap.org/styles/positron, 2026-10-14).
 */
function positronFixture(): StyleLike {
  return {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "rgb(242,243,240)" } },
      { id: "park", type: "fill", paint: { "fill-color": "rgb(230, 233, 229)" } },
      { id: "water", type: "fill", paint: { "fill-antialias": true, "fill-color": "rgb(194, 200, 202)" } },
      { id: "landuse_residential", type: "fill", paint: { "fill-color": "rgb(234, 234, 230)" } },
      { id: "landcover_wood", type: "fill", minzoom: 10, paint: { "fill-color": "rgb(220,224,220)" } },
      {
        id: "building",
        type: "fill",
        minzoom: 12,
        paint: { "fill-color": "rgb(234, 234, 229)", "fill-outline-color": "rgb(219, 219, 218)" },
      },
      {
        id: "highway_major_casing",
        type: "line",
        minzoom: 11,
        paint: { "line-color": "rgb(213, 213, 213)" },
      },
      {
        id: "highway_motorway_inner",
        type: "line",
        minzoom: 6,
        paint: { "line-color": "#fff", "line-width": 2 },
      },
      {
        id: "highway-name-major",
        type: "symbol",
        minzoom: 12.2,
        layout: { "text-field": ["get", "name"] },
        paint: { "text-color": "#666", "text-halo-blur": 0.5, "text-halo-width": 1 },
      },
      {
        id: "highway-name-path",
        type: "symbol",
        minzoom: 15.5,
        paint: { "text-color": "hsl(30,0%,62%)", "text-halo-color": "#f8f4f0", "text-halo-width": 0.5 },
      },
      { id: "airport", type: "symbol", minzoom: 11, paint: { "text-color": "#666" } },
      {
        id: "label_town",
        type: "symbol",
        minzoom: 6,
        paint: { "text-color": "#000", "text-halo-blur": 1, "text-halo-color": "#fff", "text-halo-width": 1 },
      },
      {
        id: "label_city",
        type: "symbol",
        minzoom: 3,
        paint: { "text-color": "#000", "text-halo-color": "#fff", "text-halo-width": 1 },
      },
      {
        id: "water_name_point_label",
        type: "symbol",
        paint: { "text-color": "#495e91", "text-halo-color": "rgba(255,255,255,0.7)" },
      },
    ],
  };
}

function layerById(style: StyleLike, id: string) {
  const layer = style.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`no layer ${id}`);
  return layer;
}

describe("resolveMapStyleUrl (ONE env var, ADR-008)", () => {
  it("defaults to OpenFreeMap positron", () => {
    expect(DEFAULT_MAP_STYLE_URL).toBe("https://tiles.openfreemap.org/styles/positron");
    for (const blank of [undefined, null, "", "   "]) {
      expect(resolveMapStyleUrl(blank)).toBe(DEFAULT_MAP_STYLE_URL);
    }
  });

  it("uses NEXT_PUBLIC_MAP_STYLE_URL when set, trimmed", () => {
    expect(resolveMapStyleUrl("  https://tiles.example.test/styles/positron  ")).toBe(
      "https://tiles.example.test/styles/positron",
    );
  });
});

describe("applyPositronOverrides (DESIGN-DIRECTION §5.1)", () => {
  it("lightens water to the osm-water token", () => {
    expect(layerById(applyPositronOverrides(positronFixture()), "water").paint?.["fill-color"]).toBe("#D9E2E7");
    expect(MAP_TOKENS.water).toBe("#D9E2E7");
  });

  it("keeps the already-muted land fills untouched", () => {
    const patched = applyPositronOverrides(positronFixture());
    expect(layerById(patched, "background").paint?.["background-color"]).toBe("rgb(242,243,240)");
    expect(layerById(patched, "park").paint?.["fill-color"]).toBe("rgb(230, 233, 229)");
    expect(layerById(patched, "landuse_residential").paint?.["fill-color"]).toBe("rgb(234, 234, 230)");
    expect(layerById(patched, "landcover_wood").paint?.["fill-color"]).toBe("rgb(220,224,220)");
    expect(layerById(patched, "highway_major_casing").paint?.["line-color"]).toBe("rgb(213, 213, 213)");
  });

  it("recolours label_* and highway-name-* to ink-muted with a 1.5 px white halo", () => {
    const patched = applyPositronOverrides(positronFixture());
    for (const id of ["label_town", "label_city", "highway-name-major", "highway-name-path"]) {
      const paint = layerById(patched, id).paint ?? {};
      expect(paint["text-color"]).toBe("#475569");
      expect(paint["text-halo-color"]).toBe("#FFFFFF");
      expect(paint["text-halo-width"]).toBe(LABEL_HALO_WIDTH);
      expect(LABEL_HALO_WIDTH).toBe(1.5);
    }
  });

  it("leaves non-label symbol layers alone", () => {
    const paint = layerById(applyPositronOverrides(positronFixture()), "water_name_point_label").paint ?? {};
    expect(paint["text-color"]).toBe("#495e91");
  });

  it("hides building and POI/airport layers below zoom 15", () => {
    const patched = applyPositronOverrides(positronFixture());
    expect(DETAIL_MIN_ZOOM).toBe(15);
    expect(layerById(patched, "building").minzoom).toBe(15);
    expect(layerById(patched, "airport").minzoom).toBe(15);
    // A layer outside the detail set keeps its own minzoom.
    expect(layerById(patched, "highway_major_casing").minzoom).toBe(11);
  });

  it("drops the motorway inner line to 0.8 so route lines sit above it", () => {
    const paint = layerById(applyPositronOverrides(positronFixture()), "highway_motorway_inner").paint ?? {};
    expect(paint["line-opacity"]).toBe(0.8);
  });

  it("keeps every layer id and its order, and adds or removes none", () => {
    const before = positronFixture();
    const after = applyPositronOverrides(before);
    expect(after.layers.map((l) => l.id)).toEqual(before.layers.map((l) => l.id));
  });

  it("does not mutate the input style", () => {
    const style = positronFixture();
    const snapshot = JSON.stringify(style);
    applyPositronOverrides(style);
    expect(JSON.stringify(style)).toBe(snapshot);
  });

  it("classifies layer ids", () => {
    expect(isBasemapLabelLayerId("label_city")).toBe(true);
    expect(isBasemapLabelLayerId("highway-name-minor")).toBe(true);
    expect(isBasemapLabelLayerId("water_name_line_label")).toBe(false);
    expect(isDetailLayerId("building")).toBe(true);
    expect(isDetailLayerId("airport")).toBe(true);
    expect(isDetailLayerId("poi_z16")).toBe(true);
    expect(isDetailLayerId("park")).toBe(false);
  });
});

describe("our layers (DESIGN-DIRECTION §5.1, §8)", () => {
  it("draws planned route 4 px brand at 60% and driven route solid", () => {
    const layers = fleetMapLayers();
    const planned = layers.find((l) => l.id === MAP_LAYER_IDS.routePlanned)?.paint ?? {};
    expect(planned["line-color"]).toBe("#1D4ED8");
    expect(planned["line-width"]).toBe(4);
    expect(planned["line-opacity"]).toBe(0.6);

    const driven = layers.find((l) => l.id === MAP_LAYER_IDS.routeDriven)?.paint ?? {};
    expect(driven["line-color"]).toBe("#1D4ED8");
    expect(driven["line-opacity"]).toBe(1);
  });

  it("draws stops as a white circle with a 2 px ink ring plus a label", () => {
    const layers = fleetMapLayers();
    const stop = layers.find((l) => l.id === MAP_LAYER_IDS.stopCircle)?.paint ?? {};
    expect(stop["circle-color"]).toBe("#FFFFFF");
    expect(stop["circle-stroke-width"]).toBe(2);
    expect(stop["circle-stroke-color"]).toBe("#0F172A");
    expect(layers.some((l) => l.id === MAP_LAYER_IDS.stopLabel)).toBe(true);
  });

  it("draws the center pin in ink", () => {
    const pin = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.centerPin)?.paint ?? {};
    expect(pin["circle-color"]).toBe("#0F172A");
  });

  it("gives trucks the §8 state tones and a 2 px white halo", () => {
    const truck = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.vehicleCircle)?.paint ?? {};
    expect(truck["circle-stroke-width"]).toBe(2);
    expect(truck["circle-stroke-color"]).toBe("#FFFFFF");
    const color = JSON.stringify(truck["circle-color"]);
    expect(color).toContain("#15803D"); // map-truck-ok
    expect(color).toContain("#A16207"); // map-truck-stale
    expect(color).toContain("#B91C1C"); // map-truck-crit
  });

  it("orders the stack planned route → driven route → stops → center → trucks", () => {
    expect(fleetMapLayers().map((l) => l.id)).toEqual([
      MAP_LAYER_IDS.routePlanned,
      MAP_LAYER_IDS.routeDriven,
      MAP_LAYER_IDS.stopCircle,
      MAP_LAYER_IDS.stopLabel,
      MAP_LAYER_IDS.centerPin,
      MAP_LAYER_IDS.centerLabel,
      MAP_LAYER_IDS.vehicleCircle,
      MAP_LAYER_IDS.vehicleLabel,
    ]);
  });

  it("never uses the demo violet anywhere on the map (§5.1)", () => {
    expect(DEMO_VIOLET).toBe("#6D28D9");
    const violets = [DEMO_VIOLET.toLowerCase(), "rgb(109,40,217)", "rgb(109, 40, 217)", "109,40,217"];
    const haystacks = [
      JSON.stringify(fleetMapLayers()),
      JSON.stringify(Object.values(MAP_TOKENS)),
      JSON.stringify(applyPositronOverrides(positronFixture())),
    ];
    for (const haystack of haystacks) {
      for (const violet of violets) {
        expect(haystack.toLowerCase()).not.toContain(violet);
      }
    }
  });
});

describe("attribution (DESIGN-DIRECTION §5.1, ADR-008)", () => {
  it("uses the required text and links both licences", () => {
    expect(ATTRIBUTION_TEXT).toBe("© OpenFreeMap © OpenStreetMap contributors");
    expect(ATTRIBUTION_HTML).toContain("© OpenFreeMap");
    expect(ATTRIBUTION_HTML).toContain("© OpenStreetMap contributors");
    expect(ATTRIBUTION_HTML).toContain("https://openfreemap.org/");
    expect(ATTRIBUTION_HTML).toContain("https://www.openstreetmap.org/copyright");
  });
});

describe("GPS freshness (DESIGN-DIRECTION §3, MOCKS §5)", () => {
  it("bands at 60 / 180 / 600 s", () => {
    expect(gpsBand(0)).toBe("fresh");
    expect(gpsBand(59)).toBe("fresh");
    expect(gpsBand(60)).toBe("aging");
    expect(gpsBand(179)).toBe("aging");
    expect(gpsBand(180)).toBe("stale");
    expect(gpsBand(599)).toBe("stale");
    expect(gpsBand(600)).toBe("lost");
  });

  it("maps the four bands onto the three truck tones", () => {
    expect(truckTone(12)).toBe("ok");
    expect(truckTone(95)).toBe("ok");
    expect(truckTone(245)).toBe("stale");
    expect(truckTone(720)).toBe("crit");
  });

  it("never prints raw seconds over 60", () => {
    expect(formatGpsAge(12)).toBe("12 s");
    expect(formatGpsAge(59)).toBe("59 s");
    expect(formatGpsAge(60)).toBe("1 min");
    expect(formatGpsAge(245)).toBe("4 min");
    expect(formatGpsAge(3900)).toBe("1 h 5 min");
    expect(formatGpsAge(-5)).toBe("0 s");
  });

  it("always pairs the tone with words, so freshness is never colour-only", () => {
    expect(gpsFreshnessLabel(12)).toBe("Live · 12 s");
    expect(gpsFreshnessLabel(95)).toBe("Last seen 1 min");
    expect(gpsFreshnessLabel(245)).toBe("Stale · 4 min · ETA texts paused");
    expect(gpsFreshnessLabel(720)).toBe("No signal · 12 min");
    expect(vehicleMapLabel("V1", 12)).toBe("V1 · Live 12 s");
    expect(vehicleMapLabel("V4", 720)).toBe("V4 · No signal 12 min");
  });
});

describe("camera (DESIGN-DIRECTION §5.1, §9)", () => {
  const target = { center: [-80.145541, 26.645352] as Coord, zoom: 13 };

  it("flies in at most 600 ms", () => {
    const move = cameraMove(target, false);
    expect(move.method).toBe("flyTo");
    expect(move.method === "flyTo" && move.duration).toBe(CAMERA_DURATION_MS);
    expect(CAMERA_DURATION_MS).toBeLessThanOrEqual(600);
  });

  it("jumps with no animation under prefers-reduced-motion", () => {
    const move = cameraMove(target, true);
    expect(move.method).toBe("jumpTo");
    expect(move).not.toHaveProperty("duration");
    expect(move.center).toEqual(target.center);
    expect(move.zoom).toBe(13);
  });

  it("bounds all vehicles", () => {
    const coords: Coord[] = [
      [-80.145541, 26.645352],
      [-80.080532, 26.602482],
      [-80.164767, 26.652165],
    ];
    expect(boundsOf(coords)).toEqual([
      [-80.164767, 26.602482],
      [-80.080532, 26.652165],
    ]);
    expect(boundsOf([])).toBeNull();
    const single = boundsOf([coords[0]]);
    expect(single).toEqual([coords[0], coords[0]]);
    expect(centerOfBounds([
      [-80.2, 26.6],
      [-80.0, 26.8],
    ])).toEqual([-80.1, 26.700000000000003]);
  });
});

describe("GeoJSON builders", () => {
  it("tags each vehicle with its tone, label and selection", () => {
    const fc = vehiclesGeoJson(
      [
        { id: "V1", coord: [-80.1, 26.6], gpsAgeSeconds: 12 },
        { id: "V4", coord: [-80.2, 26.7], gpsAgeSeconds: 720 },
      ],
      "V4",
    );
    expect(fc.features[0].properties).toEqual({
      id: "V1",
      tone: "ok",
      label: "V1 · Live 12 s",
      selected: false,
    });
    expect(fc.features[1].properties.tone).toBe("crit");
    expect(fc.features[1].properties.selected).toBe(true);
  });

  it("splits planned and driven geometry", () => {
    const routes = [
      {
        id: "R1",
        vehicleId: "V1",
        planned: [
          [-80.1, 26.6],
          [-80.1, 26.61],
          [-80.1, 26.62],
          [-80.1, 26.63],
        ] as Coord[],
        drivenCount: 3,
      },
    ];
    expect(plannedRoutesGeoJson(routes).features[0].geometry.coordinates).toHaveLength(4);
    expect(drivenRoutesGeoJson(routes).features[0].geometry.coordinates).toHaveLength(3);
  });

  it("drops degenerate geometry instead of drawing a dot", () => {
    const planned: Coord[] = [
      [-80.1, 26.6],
      [-80.1, 26.61],
    ];
    expect(drivenRoutesGeoJson([{ id: "R1", vehicleId: "V1", planned, drivenCount: 1 }]).features).toHaveLength(0);
    expect(drivenRoutesGeoJson([{ id: "R1", vehicleId: "V1", planned, drivenCount: 99 }]).features[0]
      .geometry.coordinates).toHaveLength(2);
    expect(plannedRoutesGeoJson([{ id: "R1", vehicleId: "V1", planned: [planned[0]], drivenCount: 0 }]).features)
      .toHaveLength(0);
  });
});
