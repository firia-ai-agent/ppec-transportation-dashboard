import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { ConsoleShell } from "@/ui/ConsoleShell";

export const dynamic = "force-dynamic";

/**
 * The console shell around the live map, from the same component as every other screen's
 * (src/ui/ConsoleShell.tsx). Before this the map was a route with no menu on it: the founder's
 * 2026-10-17 walk of production got here from the board and the browser's Back button was the
 * only way back.
 *
 * This row asks only for a session; /live-map's own row (all staff, because a person at the door
 * needs to see where the vans are) is checked by the page, and which *data* the role then gets
 * is src/domain/access/map-view.ts.
 *
 * The DEMO bar and the one source-mode chip come from the root layout, on every route — neither
 * this layout nor the page inside it may mount a second pair.
 */
export default async function LiveMapLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.liveMap);
  // The screen is its own `<main>` with its own padding (live-map/page.tsx).
  return (
    <ConsoleShell caller={caller} pageOwnsMain>
      {children}
    </ConsoleShell>
  );
}
