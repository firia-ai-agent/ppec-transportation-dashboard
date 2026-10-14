# ADR-008 Map rendering

**Status: Accepted (supersedes the Proposed OSM-raster version).** Decided 2026-10-14 for M5.

## Decision
`maplibre-gl` 6.14.0 (pinned exact, no `react-map-gl` — one `useEffect` is enough), rendering
**OpenFreeMap vector tiles** with the **`positron`** base style. One env var carries the whole map
config: **`NEXT_PUBLIC_MAP_STYLE_URL`**, defaulting to `https://tiles.openfreemap.org/styles/positron`
(`DEFAULT_MAP_STYLE_URL` in `src/components/map/style.ts`; documented in `src/lib/env.ts` and the
README). It is public, non-secret and browser-only — no app data rides along with a tile request.

The fetched style JSON is patched by the pure `applyPositronOverrides()` before the map is built, so
the DESIGN-DIRECTION §5.1 overrides are unit-tested rather than eyeballed: water → `#D9E2E7`,
`label_*` / `highway-name-*` → `#475569` text with a 1.5 px `#FFFFFF` halo, motorway inner line at
0.8 opacity, and `building` / POI / `airport` hidden below zoom 15. Layer ids and order are preserved.
Our own layers (planned route, driven route, stops, center pin, trucks) sit on top in §8 tokens; the
demo violet `#6D28D9` never appears on the map and a test asserts it.

This replaces the earlier proposal (OSM **raster** tiles from `tile.openstreetmap.org` via
`NEXT_PUBLIC_TILE_URL`, plus `react-map-gl` 8.1.3). The env name in DECISION-LEDGER row 24
(`NEXT_PUBLIC_MAP_TILE_URL`) is superseded by `NEXT_PUBLIC_MAP_STYLE_URL`: it is a style URL now, not
a tile template, and there is only one of them.

## Why
- **Positron is the quiet style.** Near-monochrome, so trucks, routes and state chips carry all the
  colour. `liberty`/`bright` are full-colour and compete with the §3 state tones; `dark`/`fiord` hurt
  daytime ramp/iPad legibility (DESIGN-DIRECTION §5.1).
- **Vector beats raster here.** We can restyle the basemap (the water override exists precisely
  because positron's default `#C2C8CA` water fails 3:1 against the ok/stale truck tones), hide noise
  below zoom 15, and keep labels at an AA tone — none of which is possible with raster tiles.
- **The OSM tile usage policy** (https://operations.osmfoundation.org/policies/tiles/) discourages
  app use of `tile.openstreetmap.org` and the old decision leaned on it. OpenFreeMap is purpose-built
  for this and free at any volume.
- **No lock-in.** Any MapLibre-compatible style URL drops in through the one env var, so a paid or
  self-hosted source (or Amazon Location on the AWS step) is a config change, not a rewrite.

## Terms we are accepting
- **OpenFreeMap ToS** — https://openfreemap.org/tos/ (Hyperknot Software Kft.; last updated
  2026-10-14, read that day):
  - free and **"as-is", "as available", "with all faults"**, with **no warranties** of accuracy,
    availability or fitness, and liability excluded to the fullest extent permitted;
  - **no SLA and no personalised support** (https://openfreemap.org/); a Pro plan is only a
    possibility;
  - the service **may be discontinued at any time without notice**;
  - **no automated bulk collection** of data from the service, except offline downloads;
  - **offline downloads** must be ≤ 3,000 tiles or 50 MB each, ≤ 4 parallel requests, with a unique
    User-Agent. We do none; if that ever changes, those limits bind us.
  - Cloudflare may serve as CDN; Hungarian law; arbitration in Budapest.
  - Consequence for P1: acceptable. The map is a demo surface on synthetic data, no app data leaves
    with a tile request, and an outage degrades the pane without blocking the board (the pane shows an
    error with Retry). **Risk to carry:** a discontinuation or outage during a founder demo. Mitigation
    is the env var — point it at another style, or self-host.
- **Attribution is required** (https://openfreemap.org/). The OpenFreeMap TileJSON carries
  `OpenFreeMap © OpenMapTiles Data from OpenStreetMap`, which MapLibre's `AttributionControl` renders
  automatically; we add the DESIGN-DIRECTION §5.1 wording
  **"© OpenFreeMap © OpenStreetMap contributors"** (linking https://openfreemap.org/ and
  https://www.openstreetmap.org/copyright) as `customAttribution` on the same control, compact,
  bottom-right. The control is **never removed**, and drawers, sheets and the demo panel must inset the
  map container rather than cover it (enforced in `fleet-map.module.css`; §10 checklist line).
- **OSM data is ODbL** — https://www.openstreetmap.org/copyright. Credit stays on screen as above;
  the same credit must appear on printed or exported map images.

## Alternatives rejected
| Option | Why not |
|---|---|
| OSM raster tiles (`tile.openstreetmap.org`) | usage policy discourages app traffic; no restyling, so §5.1 contrast overrides are impossible |
| MapTiler / Mapbox / Stadia | paid keys, a new data processor and a secret to manage for a mock demo |
| `react-map-gl` wrapper | one `useEffect` already does it; a second abstraction to version-match for no gain |
| Self-hosted tiles now | real ops work (planet extract, storage) before the POC has proved anything |
| Amazon Location | belongs to the AWS step, behind the same style-URL seam |

## Consequences / what to watch
- Tiles are fetched by the browser from `tiles.openfreemap.org`; add it to any future CSP
  `connect-src`/`img-src`.
- `maplibre-gl` is a ~900 KB-class dependency; it is only imported by the client `FleetMap` component,
  so it stays out of every other route's bundle.
- If OpenFreeMap disappears mid-demo: set `NEXT_PUBLIC_MAP_STYLE_URL` to another MapLibre style and
  redeploy. Nothing else changes.

**Related:** ADR-007 (route geometry from committed OSRM fixtures, no live routing),
DESIGN-DIRECTION §5 / §5.1 / §8, MOCKS-AND-DEMO §1 / §5.
