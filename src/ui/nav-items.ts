import { Activity, Inbox, LayoutDashboard, Settings, type LucideIcon } from "lucide-react";
import { nav } from "./copy";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/**
 * DESIGN-DIRECTION §2 / PRD §14: Today (board + drawer + inbox) · Exceptions & Approvals
 * (count badge once the live board lands) · Setup · Health & ROI. The ramp iPad is its own
 * full-screen route and deliberately not in this rail.
 *
 * Icon rule (Vera's review): a nav icon must never be an icon §3 uses to mark a *state*, or
 * §7.1 uses for a source mode — otherwise "Exceptions" in the rail reads as a live alert and
 * the board's `octagon-alert` chip stops meaning "needs action". So:
 *  - Today uses `layout-dashboard` (the board), not `calendar-check`, which sits too close to
 *    the `calendar-clock` / `calendar-x` state family.
 *  - Exceptions & Approvals uses `inbox` (a queue of work), not `octagon-alert`, which is the
 *    EXCEPTION and severity-RED state icon.
 *  - Setup uses `settings`, Health & ROI uses `activity`; neither appears in §3 or §7.1.
 * nav-items.test.ts fails if any nav icon collides with a state or source-mode icon.
 */
export const navItems: readonly NavItem[] = [
  { href: "/today", label: nav.today, icon: LayoutDashboard },
  { href: "/exceptions", label: nav.exceptions, icon: Inbox },
  { href: "/setup", label: nav.setup, icon: Settings },
  { href: "/health", label: nav.health, icon: Activity },
];

/** The rail highlights the section, so /today/<child> still marks "Today" as current. */
export function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
