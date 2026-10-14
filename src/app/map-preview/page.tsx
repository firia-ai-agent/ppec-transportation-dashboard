/**
 * /map-preview — the M5 map pane on its own route, so Vera and Veri can walk the
 * §10 map checklist lines (attribution always visible, no violet on the map, positron
 * with the §5.1 water override, reduced-motion camera) before SURF-01 exists. With the
 * M5 simulator wired in, the trucks now move: a client-side scenario clock replays the
 * deterministic runs in src/fixtures/replays.ts (PRD §18.2 steps 7–8).
 *
 * Deliberately standalone: no auth, no database, no SSE, no server actions, no sending.
 * Everything on the page is Simulated by construction (ADR-015 synthetic-only). The DEMO
 * banner and the one NFR-09 source-mode chip come from the root layout (src/app/layout.tsx),
 * which renders them on every route — this page must not mount a second pair. The
 * notification list is *decisions* only.
 */

import LiveFleetMap from "@/components/map/LiveFleetMap";

export const metadata = { title: "Map preview · PPEC transportation dashboard" };

export default function MapPreviewPage() {
  return (
    <main style={{ padding: "var(--space-5)", display: "grid", gap: "var(--space-4)" }}>
      <h1
        style={{
          margin: 0,
          fontSize: "var(--text-20)",
          fontWeight: "var(--weight-semibold)",
          lineHeight: "var(--leading-tight)",
          color: "var(--color-ink)",
        }}
      >
        Map preview
      </h1>
      <p
        style={{
          margin: 0,
          maxWidth: "70ch",
          fontSize: "var(--body-console)",
          lineHeight: "var(--leading-normal)",
          color: "var(--color-ink-muted)",
        }}
      >
        Fleet map pane (SURF-01) on committed fixtures: the center at 2216 Jog Rd, public
        landmark stops, and the M5 GPS simulator driving V1–V3 along ADR-007 route fixtures with
        injected faults — a stall, a GPS gap, duplicate and out-of-order points, ±40 m jitter, and
        one unbound device. ETA windows come from the committed route durations and a simulated
        traffic band; freshness follows the four decided bands (live / aging / stale at 180 s / no
        signal at 600 s). Nothing here is live — no database, no GPS feed, no messages sent, no
        real children or families.
      </p>
      <LiveFleetMap />
    </main>
  );
}
