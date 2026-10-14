import { Activity, CalendarCheck, OctagonAlert, Settings, type LucideIcon } from "lucide-react";
import { nav } from "./copy";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/**
 * DESIGN-DIRECTION §2 / PRD §14: Today (board + drawer + inbox) · Exceptions & Approvals
 * (count badge once B-12 lands) · Setup · Health & ROI. The ramp iPad is its own full-screen
 * route and deliberately not in this rail.
 */
export const navItems: readonly NavItem[] = [
  { href: "/today", label: nav.today, icon: CalendarCheck },
  { href: "/exceptions", label: nav.exceptions, icon: OctagonAlert },
  { href: "/setup", label: nav.setup, icon: Settings },
  { href: "/health", label: nav.health, icon: Activity },
];

/** The rail highlights the section, so /today/<child> still marks "Today" as current. */
export function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
