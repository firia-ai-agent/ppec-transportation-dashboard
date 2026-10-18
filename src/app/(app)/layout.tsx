import type { ReactNode } from "react";
import { LAYOUT } from "@/auth/access";
import { getExec } from "@/auth/exec";
import { requirePage } from "@/auth/page-guard";
import { assistantAlertCount } from "@/modules/agent/staff-alert";
import { canDecideApprovals } from "@/modules/approvals/decide";
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
 *
 * The one number the shell reads from the database is the Exceptions count — how many family
 * texts are waiting for a person because the assistant could not reach its model (founder,
 * 2026-10-17). It is read **here** rather than on the page because it is a rail badge and the
 * rail is on every console screen; it is read only for a role that may open `/exceptions`, so
 * the front desk's request does not even ask the question; and it fails soft to "no badge",
 * because a count nobody could read must not take the whole console down.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const caller = await requirePage(LAYOUT.console);
  const role = caller.kind === "STAFF" ? caller.role : null;
  return (
    <ConsoleShell caller={caller} alertCount={await alertCount(caller, role)}>
      {children}
    </ConsoleShell>
  );
}

/** The rail's count, or 0 — for a role that may not open the page, without asking the database. */
async function alertCount(
  caller: { memberships: readonly { siteId: string }[] },
  role: Parameters<typeof canDecideApprovals>[0],
): Promise<number> {
  if (!canDecideApprovals(role)) return 0;
  const siteIds = caller.memberships.map((m) => m.siteId);
  if (siteIds.length === 0) return 0;
  try {
    return await assistantAlertCount(getExec(), siteIds);
  } catch {
    return 0;
  }
}
