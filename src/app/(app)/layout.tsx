import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { AppShell } from "@/ui/AppShell";

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
 * The DEMO bar and the one source-mode chip are **not** here: they come from the root layout
 * (src/app/layout.tsx), which puts them above every route, signed in or not (§7, §7.1,
 * NFR-09). shell.test.ts holds that line.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.console);
  return (
    <AppShell displayName={caller.displayName ?? ""} role={caller.kind === "STAFF" ? caller.role : null}>
      {children}
    </AppShell>
  );
}
