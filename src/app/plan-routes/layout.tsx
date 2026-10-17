import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { ConsoleShell } from "@/ui/ConsoleShell";

export const dynamic = "force-dynamic";

/**
 * The console shell around Plan routes — the same header, nav, identity and scenario clock the
 * four routes inside src/app/(app) get, from the same component (src/ui/ConsoleShell.tsx).
 *
 * Why a layout here rather than a move into that group: this route's address is read out loud in
 * a demo, and a layout is the one way to put the menu on a screen without renaming anything on
 * it. The screen inside is the rebuilt board (redesign spec §1, Rework 2).
 *
 * The split is the group's: this row asks only for a session, and the page inside it checks the
 * role against its own row (/plan-routes is the two console roles), so a refusal is still
 * rendered by the page that was asked for and the no-access card can say who it is for.
 *
 * The DEMO bar and the one source-mode chip come from the root layout, on every route — neither
 * this layout nor the page inside it may mount a second pair.
 */
export default async function PlanRoutesLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.planRoutes);
  // The screen is its own `<main>` with its own padding (board/PlanBoard.tsx).
  return (
    <ConsoleShell caller={caller} pageOwnsMain>
      {children}
    </ConsoleShell>
  );
}
