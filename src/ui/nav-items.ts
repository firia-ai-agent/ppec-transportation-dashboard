import {
  Activity,
  Flag,
  LayoutDashboard,
  Map as MapIcon,
  Route,
  Settings,
  Tablet,
  type LucideIcon,
} from "lucide-react";
import { canOpenPage } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { liveMap, nav, planRoutes, rampIpad } from "./copy";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/**
 * THE RAIL — every destination this app has, and nothing a role cannot open.
 *
 * DESIGN-DIRECTION §2 / PRD §14 (l.1055) name four console destinations: Today (board + drawer
 * + inbox) · Exceptions & Approvals (count badge once the live board lands) · Setup · Health &
 * ROI. Three more screens are built and were reachable only by typing their URL, which is not a
 * way anybody finds a screen, so they are in the rail too:
 *
 *  - **Plan routes** (`/plan-routes`) — the planning surface staff reach before the board has
 *    anything on it (B-09 VEH-01…05, B-13). PRD §14 names no planning surface, so the label is
 *    the heading of the screen itself.
 *  - **Live map** (`/live-map`) — the fleet pane (DESIGN-DIRECTION §5). PRD §14 names no
 *    map surface either: the map lands *inside* SURF-01 at BUILD-PLAN-M2 P-03, and this route is
 *    where it is walked until then. The label is the screen's own heading. It was "Map preview",
 *    which named the build rather than the screen, and Vera's review (2026-10-17) rules out
 *    "preview" in any menu label or address; where the positions come from is said by the §7.1
 *    "Simulated" chip in the DEMO bar, which the root layout renders on this route as on every
 *    other, and by the screen's own `signedInOnly` line (COPY-GUIDE §1, honest about certainty).
 *  - **Ramp iPad** (`/ramp-ipad`) — SURF-04, and the one of the three the PRD does name:
 *    "Ramp iPad" in both the §14 navigation line and the §14 SURF-04 entry (l.1055, l.1061). It
 *    is its own full-screen route (§2) and so renders no rail of its own; the rail still links
 *    to it, because the front desk cannot open a console page and this is their surface.
 *
 * Every label is the heading of its own screen, read from src/ui/copy.ts — never a second
 * string in `nav` — so the rail and the page cannot drift apart. nav-items.test.ts holds that.
 *
 * Icon rule (Vera's review): a nav icon must never be an icon §3 uses to mark a *state*, or
 * §7.1 uses for a source mode — otherwise "Exceptions" in the rail reads as a live alert and
 * the board's `octagon-alert` chip stops meaning "needs action". So:
 *  - Today uses `layout-dashboard` (the board), not `calendar-check`, which sits too close to
 *    the `calendar-clock` / `calendar-x` state family.
 *  - Exceptions & Approvals uses `flag` (Vera's answer, 2026-10-14: something flagged for a
 *    person to pick up), not `octagon-alert`, which is the EXCEPTION and severity-RED state
 *    icon. `flag` carries no §3 or §7.1 meaning, so the rail cannot read as a live alert.
 *  - Setup uses `settings`, Health & ROI uses `activity`; neither appears in §3 or §7.1.
 *  - Plan routes uses `route`. Not `map-pin` or `navigation`: §3 gives both a meaning about
 *    *where a van is now*, and planning is about which van a child rides in.
 *  - Live map uses `map`. §3 claims `map-pin` (At pickup) and `map-pin-check` (Arrived), and
 *    §7.1 claims none of the family — but `map` itself is claimed by neither, and on the one
 *    destination that *is* a map it cannot be mistaken for a van's state.
 *  - Ramp iPad uses `tablet`, the surface the PRD names it after. No §3 or §7.1 meaning, and
 *    nothing else in the rail is a device.
 * nav-items.test.ts fails if any nav icon collides with a state or source-mode icon, or if two
 * destinations share one.
 *
 * Order: §2's four destinations keep their document order, Plan routes and the live map sit
 * between the board and the exceptions it raises (plan the day, then watch it move), and the
 * ramp iPad is last — PRD §14 lists it last, after the console destinations, because it is not
 * one.
 *
 * Addresses: each one is the screen's own name, `/plan-routes`, `/live-map`, `/ramp-ipad`. The
 * three used to be `/plan-preview`, `/map-preview` and `/ramp-preview` — a word about how
 * finished the build is, in a URL a founder reads out loud. Those three still answer, as
 * permanent redirects behind the same rows of the access table (src/app/plan-preview/page.tsx
 * and its two siblings), so a bookmark or a link in an old PR still lands on the screen.
 */
export const navItems: readonly NavItem[] = [
  { href: "/today", label: nav.today, icon: LayoutDashboard },
  { href: "/plan-routes", label: planRoutes.heading, icon: Route },
  { href: "/live-map", label: liveMap.heading, icon: MapIcon },
  { href: "/exceptions", label: nav.exceptions, icon: Flag },
  { href: "/setup", label: nav.setup, icon: Settings },
  { href: "/health", label: nav.health, icon: Activity },
  { href: "/ramp-ipad", label: rampIpad.heading, icon: Tablet },
];

/** The rail highlights the section, so /today/<child> still marks "Today" as current. */
export function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The rail as one role sees it: the destinations that role's row in the access table opens, and
 * never one more. The filter *is* `canOpenPage`, so the rail cannot be wider than the table —
 * there is no second list of roles here to fall out of step with it.
 *
 * What each role gets, and where the docs put them:
 *  - DIRECTOR and COORDINATOR — the whole rail. ARCHITECTURE §1 gives the web console to the
 *    coordinator and the director, PRD §6.2 gives them the attendance plan and the legs, and
 *    both walk the ramp iPad too.
 *  - FRONT_DESK — the ramp iPad (PRD §6.2, ARCHITECTURE §1: their own surface) and the live
 *    map, whose row is all staff because a person at the door needs to see where the vans
 *    are; the per-key matrix in src/domain/access/map-view.ts then withholds the family labels
 *    and the notification queue from them. No console destination, which is correct.
 *  - `null` (signed in, no membership anywhere) — nothing.
 *
 * This is a courtesy, not a guard. Every page checks the server again, and guard-matrix.test.ts
 * asks the server directly, with no browser involved, exactly because a hidden link is not a
 * closed door (the ID-swap skill, rule 6: hiding ≠ denying).
 */
export function navItemsFor(role: StaffRole | null): readonly NavItem[] {
  return navItems.filter((item) => canRoleOpen(role, item.href));
}

/**
 * Would this role's row in the access table open this screen?
 *
 * The rail's own filter, pulled out so that a link *outside* the rail can ask the same question
 * of the same table. The ramp iPad needs it: its re-plan panel offers to carry the check on to
 * Plan routes and to the Today board, and the front desk — whose surface the ramp iPad is — can
 * open neither (Vera's prod walk, 2026-10-17: both links were on the front desk's screen, and
 * both answered 403). A link that refuses is worse than no link, because the person tapping it
 * has to work out whether the check was lost.
 *
 * `role` is the caller's role as a page already read it off the guard, and `null` is a visitor
 * with a session and no membership anywhere — which opens nothing, here as in the rail.
 *
 * Still a courtesy and not a guard: every page checks the server again, and guard-matrix.test.ts
 * asks the server with no browser involved, exactly because a hidden link is not a closed door
 * (the ID-swap skill, rule 6: hiding ≠ denying).
 */
export function canRoleOpen(role: StaffRole | null, href: string): boolean {
  const caller = role ? ({ kind: "STAFF", role } as const) : ({ kind: "ANONYMOUS" } as const);
  return canOpenPage(caller, href);
}
