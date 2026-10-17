import { describe, expect, it } from "vitest";
import {
  HEADING_ICON_ID,
  headingChevronImage,
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
  gpsShortLabel,
  lateClockImage,
  markerGlyphImages,
  rgbOf,
  FADED_OPACITY,
  MARKER_GLYPH_IDS,
  ROTATING_MARKER_STATES,
  vehiclesGeoJson,
} from "./style";
import { vanMarkerMapLabel } from "@/ui/van-state";

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

  it("uses NEXT_PUBLIC_MAP_TILE_URL when set, trimmed", () => {
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
      MAP_LAYER_IDS.vehicleState,
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

describe("the marker's state glyph (DESIGN-DIRECTION §5.1 'Markers'; Vera's bar)", () => {
  it("draws the glyph of the state the van is in, aligned to the map", () => {
    const layer = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.vehicleState);
    expect(layer?.layout).toMatchObject({
      "icon-image": ["get", "glyph"],
      "icon-rotation-alignment": "map",
    });
  });

  it("turns it to the heading only for the state that has a direction to show", () => {
    const layer = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.vehicleState);
    // A van on its way points down the road; a clock, a pause and an empty ring do not rotate.
    expect(layer?.layout?.["icon-rotate"]).toEqual([
      "case",
      ["boolean", ["get", "rotates"], false],
      ["get", "headingDeg"],
      0,
    ]);
    expect(ROTATING_MARKER_STATES).toEqual(["ON_THE_WAY"]);
    expect(MARKER_GLYPH_IDS.ON_THE_WAY).toBe(HEADING_ICON_ID);
  });

  it("has one glyph per state, and no two of them are the same picture", () => {
    const images = markerGlyphImages(18);
    expect(images.map((i) => i.id)).toEqual(Object.values(MARKER_GLYPH_IDS));
    const seen = images.map((i) => i.image.data.join(","));
    expect(new Set(seen).size).toBe(images.length);
    for (const { image } of images) {
      expect(image.width).toBe(18);
      expect(image.data).toHaveLength(18 * 18 * 4);
      // Something is actually drawn: a glyph of all-transparent pixels is an invisible state.
      expect([...image.data].some((byte, i) => i % 4 === 3 && byte > 0)).toBe(true);
    }
  });

  it("builds its colours from the §8 tokens rather than from literals of its own", () => {
    expect(rgbOf(MAP_TOKENS.ink)).toEqual([15, 23, 42]);
    expect(rgbOf(MAP_TOKENS.surface)).toEqual([255, 255, 255]);
    // The clock's face is the surface token and its ring is ink: tokens, not hexes (no-hex).
    const clock = lateClockImage(18);
    const pixel = (x: number, y: number) => {
      const i = (y * 18 + x) * 4;
      return [clock.data[i], clock.data[i + 1], clock.data[i + 2], clock.data[i + 3]];
    };
    expect(pixel(0, 0)[3]).toBe(0);
    // The hands meet at the middle of an 18 px face, which is the pixel either side of 8.5.
    expect(pixel(9, 9).slice(0, 3)).toEqual(rgbOf(MAP_TOKENS.ink));
    // …and the face itself is the surface token, a few pixels off the hands and inside the ring.
    expect(pixel(5, 11).slice(0, 3)).toEqual(rgbOf(MAP_TOKENS.surface));
  });

  it("fades a van with no fix, and never its words (§4.1, §8)", () => {
    const circle = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.vehicleCircle)?.paint ?? {};
    const glyph = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.vehicleState)?.paint ?? {};
    const label = fleetMapLayers().find((l) => l.id === MAP_LAYER_IDS.vehicleLabel)?.paint ?? {};
    const faded = ["case", ["boolean", ["get", "faded"], false], FADED_OPACITY, 1];
    expect(circle["circle-opacity"]).toEqual(faded);
    expect(circle["circle-stroke-opacity"]).toEqual(faded);
    expect(glyph["icon-opacity"]).toEqual(faded);
    // The label is not faded out: it drops to the AA-passing muted ink and keeps its halo.
    expect(JSON.stringify(label["text-color"])).not.toContain(String(FADED_OPACITY));
    expect(label["text-color"]).toEqual([
      "case",
      ["boolean", ["get", "faded"], false],
      MAP_TOKENS.inkMuted,
      MAP_TOKENS.ink,
    ]);
    expect(label).not.toHaveProperty("text-opacity");
  });

  it("builds a square RGBA chevron with a white body and an ink edge", () => {
    const image = headingChevronImage(18);
    expect(image.width).toBe(18);
    expect(image.height).toBe(18);
    expect(image.data).toHaveLength(18 * 18 * 4);

    const pixel = (x: number, y: number) => {
      const i = (y * 18 + x) * 4;
      return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
    };
    // Tip at the top (icon-rotate 0 points north), body white, corners transparent.
    expect(pixel(9, 0)[3]).toBe(255);
    expect(pixel(8, 16)).toEqual([255, 255, 255, 255]);
    expect(pixel(0, 0)[3]).toBe(0);
    expect(pixel(17, 0)[3]).toBe(0);
  });

  it("is pure: the same size always gives the same bytes", () => {
    expect(headingChevronImage(12).data).toEqual(headingChevronImage(12).data);
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
    // And the marker's own label carries the band beside the van's state, so the disc's colour
    // is never the only thing saying how old the position is (Vera's bar kept §5.1's rule).
    expect(
      vanMarkerMapLabel("V1", { state: "ON_THE_WAY", label: "On the way" }, gpsShortLabel(12)),
    ).toBe("V1 · On the way · Live 12 s");
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
        {
          id: "V1",
          coord: [-80.1, 26.6],
          gpsAgeSeconds: 12,
          headingDeg: 2,
          marker: { state: "ON_THE_WAY" as const, label: "On the way" },
        },
        {
          id: "V4",
          coord: [-80.2, 26.7],
          gpsAgeSeconds: 720,
          marker: { state: "NO_FIX" as const, label: "Last seen 7:31 AM" },
        },
      ],
      "V4",
    );
    expect(fc.features[0].properties).toEqual({
      id: "V1",
      tone: "ok",
      label: "V1 · On the way · Live 12 s",
      selected: false,
      headingDeg: 2,
      state: "ON_THE_WAY",
      glyph: MARKER_GLYPH_IDS.ON_THE_WAY,
      rotates: true,
      faded: false,
    });
    // A van with no fix: its own words are a time, so the freshness is not said twice — and it
    // is the one that is drawn faded, at the last place it was seen.
    expect(fc.features[1].properties.label).toBe("V4 · Last seen 7:31 AM");
    expect(fc.features[1].properties.faded).toBe(true);
    expect(fc.features[1].properties.rotates).toBe(false);
    expect(fc.features[1].properties.glyph).toBe(MARKER_GLYPH_IDS.NO_FIX);
    // A vehicle with no heading yet points north rather than breaking the layer.
    expect(fc.features[1].properties.headingDeg).toBe(0);
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
