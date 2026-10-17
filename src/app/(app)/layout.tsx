import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { ConsoleShell } from "@/ui/ConsoleShell";

export const dynamic = "force-dynamic";

/**
 * The signed-in console shell. `requirePage` reads the session the way every surface does — the
 * token carries only a user id (ADR-004), that id must still be an active user in the database,
 * and the roles are re-read from the database per request — and this row asks only for a session:
 * sign-in is checked here, and **which** of the pages inside the shell a role may open is each
 * page's own guard. That split is deliberate: the refusal is then rendered by the page that was
 * asked for, so the no-access card can say who that page is for.
 *
 * The rail is filtered to the pages this role can actually open. That is a courtesy, not a
 * guard — every page inside checks the server again (guard-matrix.test.ts hits them without a
 * browser to prove it).
 *
 * This group is no longer the only place the shell is mounted: /plan-routes, /live-map and
 * /ramp-ipad are routes of their own outside it and each has a layout.tsx doing exactly what
 * this one does (src/ui/ConsoleShell.tsx is the shared half). They stayed where they are
 * deliberately — moving a built screen into this group is a rename of its files, and the menu
 * was the thing that was missing.
 *
 * The DEMO bar and the one source-mode chip are **not** here: they come from the root layout
 * (src/app/layout.tsx), which puts them above every route, signed in or not (§7, §7.1,
 * NFR-09). shell.test.ts holds that line.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.console);
  return <ConsoleShell caller={caller}>{children}</ConsoleShell>;
}
