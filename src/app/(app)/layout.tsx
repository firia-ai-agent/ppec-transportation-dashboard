import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { accountFirstName } from "@/auth/demo-accounts";
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
 *
 * The name in the header is the person's first name. The session carries the account's stored
 * name, which for the demo accounts is "SYN Dana Director" — a marker, a first name and a role,
 * and all three were in the header of every console page (Vera's prod walk, 2026-10-17 2:48 PM
 * ET). `accountFirstName` is the display helper; the stored name, the seed and /login are
 * untouched, and this is the one place the session's name becomes words on a screen.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.console);
  return (
    <AppShell
      displayName={accountFirstName(caller.displayName ?? "")}
      role={caller.kind === "STAFF" ? caller.role : null}
    >
      {children}
    </AppShell>
  );
}
