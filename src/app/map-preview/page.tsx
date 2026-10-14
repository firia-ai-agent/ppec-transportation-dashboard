/**
 * /map-preview — the M5 map pane on its own route, so Vera and Veri can walk the
 * §10 map checklist lines (attribution always visible, no violet on the map, positron
 * with the §5.1 water override, reduced-motion camera) before SURF-01 exists.
 *
 * Deliberately standalone: no auth, no database, no SSE, no server actions. It renders
 * the committed fixtures in src/fixtures/map.ts, which are Simulated by construction
 * (ADR-015 synthetic-only; NFR-09 source badge below).
 */

import { DemoBanner, SimulatedBadge } from "@/components/demo/DemoBanner";
import FleetMap from "@/components/map/FleetMap";
import { MAP_FIXTURE } from "@/fixtures/map";

export const metadata = { title: "Map preview · PPEC transportation dashboard" };

export default function MapPreviewPage() {
  return (
    <>
      <DemoBanner />
      <main style={{ padding: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, font: "600 20px/1.2 system-ui, sans-serif", color: "#0F172A" }}>
            Map preview
          </h1>
          <SimulatedBadge />
        </div>
        <p style={{ margin: 0, maxWidth: "70ch", font: "400 14px/1.5 system-ui, sans-serif", color: "#475569" }}>
          Fleet map pane (SURF-01) on committed fixtures: the center at 2216 Jog Rd, four public landmark
          stops, and V1–V4 across the three GPS freshness tones. Nothing here is live — no database, no
          GPS feed, no real children or families.
        </p>
        <FleetMap fixture={MAP_FIXTURE} label="Fleet map: simulated vehicles near the PPEC center" />
      </main>
    </>
  );
}
