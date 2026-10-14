/**
 * /map-preview — the M5 map pane on its own route, so Vera and Veri can walk the
 * §10 map checklist lines (attribution always visible, no violet on the map, positron
 * with the §5.1 water override, reduced-motion camera) before SURF-01 exists. With the
 * M5 simulator wired in, the trucks now move: a client-side scenario clock replays the
 * deterministic runs in src/fixtures/replays.ts (PRD §18.2 steps 7–8).
 *
 * No database, no SSE, no server actions, no sending: everything on the page is Simulated by
 * construction (ADR-015 synthetic-only) and the notification list is *decisions* only.
 *
 * It is, however, behind staff sign-in. A deployed preview URL is guessable, and this page
 * draws a whole fleet, every stop's family label and every notification decision — so the
 * route is guarded exactly as the other protected pages are, and the role decides which of
 * those the viewer actually gets (src/domain/access/map-view.ts holds the matrix).
 *
 * The DEMO banner and the one NFR-09 source-mode chip come from the root layout
 * (src/app/layout.tsx), which renders them on every route — this page must not mount a
 * second pair.
 */

import { redirect } from "next/navigation";
import LiveFleetMap from "@/components/map/LiveFleetMap";
import { mapPreview } from "@/ui/copy";
import { canOpenMapPreview } from "@/domain/access/map-view";
import { mapPreviewViewer } from "./viewer";

export const metadata = { title: mapPreview.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function MapPreviewPage() {
  const viewer = await mapPreviewViewer();
  if (!canOpenMapPreview(viewer)) redirect("/login");

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
        {mapPreview.heading}
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
        {mapPreview.intro}
      </p>
      <p
        style={{
          margin: 0,
          maxWidth: "70ch",
          fontSize: "var(--body-console)",
          lineHeight: "var(--leading-normal)",
          color: "var(--color-ink-muted)",
        }}
      >
        {mapPreview.signedInOnly}
      </p>
      <LiveFleetMap viewer={viewer} />
    </main>
  );
}
