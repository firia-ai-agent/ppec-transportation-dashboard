import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { ConsoleShell } from "@/ui/ConsoleShell";

export const dynamic = "force-dynamic";

/**
 * The console shell around the ramp iPad, from the same component as every other screen's
 * (src/ui/ConsoleShell.tsx).
 *
 * §2 calls this one "its own full-screen route", and that is the line the founder's 2026-10-17
 * walk of production disproved: the front desk has no console page, so this *is* where they land
 * (`homePathFor`, src/auth/access.ts) — a surface somebody starts their day on is the last one
 * that can afford to have no way off it. The checklist, the vehicle tiles and the sticky verdict
 * banner below are unchanged; the shell is above them.
 *
 * This row asks only for a session; /ramp-ipad's own row (every staff role — SURF-04 is the
 * front desk's surface) is checked by the page inside.
 *
 * The DEMO bar and the one source-mode chip come from the root layout, on every route — neither
 * this layout nor the page inside it may mount a second pair.
 */
export default async function RampIpadLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.rampIpad);
  // The screen is its own `<main>`, laid out edge to edge with its own padding (RampCheck.tsx).
  return (
    <ConsoleShell caller={caller} pageOwnsMain>
      {children}
    </ConsoleShell>
  );
}
