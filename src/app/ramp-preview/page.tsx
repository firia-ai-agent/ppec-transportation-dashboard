/**
 * /ramp-preview — the SURF-04 ramp iPad on its own route, so the §4.4 checklist can be walked
 * on a tablet before the real surface exists. The screen itself is RampCheck.tsx; this file is
 * only its guard.
 *
 * Behind staff sign-in, for the same reason /map-preview is: a deployed preview URL is
 * guessable, and this page lists children by first name and last initial, the transport needs
 * derived from their intake, and which seat each of them is in. src/auth/preview-viewer.ts
 * answers who is asking and src/domain/access/map-view.ts decides whether they may look.
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route —
 * this page must not mount a second pair.
 */
import { redirect } from "next/navigation";
import { previewViewer } from "@/auth/preview-viewer";
import { canOpenRampPreview } from "@/domain/access/map-view";
import RampCheck from "./RampCheck";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function RampPreviewPage() {
  if (!canOpenRampPreview(await previewViewer())) redirect("/login");
  return <RampCheck />;
}
