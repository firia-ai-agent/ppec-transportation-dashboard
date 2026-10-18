import {
  Activity,
  Flag,
  LayoutDashboard,
  Map as MapIcon,
  MessageSquareText,
  Route,
  Settings,
  Tablet,
  type LucideIcon,
} from "lucide-react";
import { canOpenPage } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { liveMap, nav, planRoutes, rampIpad } from "./copy";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Is this destination **on the menu**?
   *
   * Firia's ruling, 2026-10-17 2:48 PM ET: "the menu lists only screens that work." A menu item
   * that opens a page saying it is not built yet is a founder clicking into a dead end during a
   * demo, so each row carries its own answer here and the two rails render the same filtered
   * list. This is a flag per row, not a rule about a page: no rail, no layout and no screen
   * contains a condition about `/health` or `/exceptions` — they read this field.
   *
   * `false` does **not** change access, and deletes nothing: the route still exists, its row in
   * the access table is untouched, and a person who types the URL is answered exactly as before
   * (src/auth/page-guard.ts). It is off the *menu*, and `nav-items.test.ts` holds that no item
   * left on it opens a page that renders the `unbuilt` copy.
   */
  inMenu: boolean;
};

/**
 * THE RAIL — every destination this app has, and nothing a role cannot open.
 *
 * **Five of these are the menu** (`menuItems`), and that is Firia's 8:36 PM ET ruling of
 * 2026-10-17: Today · Plan routes · Live map · Ramp iPad · Family texts, the same five at every
 * width. Exceptions & Approvals and Health & ROI came off it — the rail on production carried
 * seven and the audit's §2 item 2 is exactly that count — and Approvals was never on it (§9.2:
 * it is the "For you" tab inside Family texts).
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
 *    "Ramp iPad" in both the §14 navigation line and the §14 SURF-04 entry (l.1055, l.1061). The
 *    front desk cannot open a console page, so this is their surface and where they land.
 *
 * Every label is the heading of its own screen, read from src/ui/copy.ts — never a second
 * string in `nav` — so the rail and the page cannot drift apart. nav-items.test.ts holds that.
 *
 * This list is every destination; the **menu** is the rows whose `inMenu` is true (`menuItems`
 * below). Firia's 2:48 PM ET ruling on 2026-10-17 took three screens off the menu because each
 * opened a page that said it was not built; the founder's 6:19 PM ET redesign put two of them
 * back, with a rule that supersedes it — **nothing on the menu may 404 or dead-end** — and the
 * screens behind them are a title and a line rather than an apology (src/ui/StubPage.tsx). The
 * flag is still where this lives: a route, its row and its answer to a typed URL are unchanged
 * either way.
 *
 * All seven render this list, and that is new as of 2026-10-17. The three screens above are
 * routes outside src/app/(app) and used to render no menu at all — §2 even says the ramp iPad is
 * "its own full-screen route" — so a founder who clicked Plan routes on production had the
 * browser's Back button and nothing else. Each of the three has a layout.tsx mounting the same
 * shell now (src/ui/ConsoleShell.tsx), so this is the menu on every destination in it, and
 * src/ui/one-menu.test.ts fails if a destination ever drops out of that set again.
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
 *  - Family texts uses `message-square-text`, which is §0's own choice. §3 gives a meaning to
 *    no icon in the message family and §7.1 to none at all, so a thread icon on the rail cannot
 *    be read as a state of a ride.
 * nav-items.test.ts fails if any nav icon collides with a state or source-mode icon, or if two
 * destinations share one.
 *
 * Order, and it is REDESIGN-SPEC §0's: Today · Plan routes · Live map · Ramp iPad · Family
 * texts, which is the order of the day (plan it, watch it move, meet it at the door, answer the
 * family), then the two surfaces that are about the day rather than in it. The ramp iPad moved
 * up from last, where PRD §14 lists it: below 768 the bar carries one tab per menu item in this
 * order (src/ui/TabBar.tsx), so the order is what a thumb reaches — and the ramp iPad is one of
 * the front desk's two destinations.
 *
 * Addresses: each one is the screen's own name, `/plan-routes`, `/live-map`, `/ramp-ipad`. The
 * three used to be `/plan-preview`, `/map-preview` and `/ramp-preview` — a word about how
 * finished the build is, in a URL a founder reads out loud. Those three still answer, as
 * permanent redirects behind the same rows of the access table (src/app/plan-preview/page.tsx
 * and its two siblings), so a bookmark or a link in an old PR still lands on the screen.
 */
export const navItems: readonly NavItem[] = [
  { href: "/today", label: nav.today, icon: LayoutDashboard, inMenu: true },
  { href: "/plan-routes", label: planRoutes.heading, icon: Route, inMenu: true },
  { href: "/live-map", label: liveMap.heading, icon: MapIcon, inMenu: true },
  { href: "/ramp-ipad", label: rampIpad.heading, icon: Tablet, inMenu: true },
  /*
   * REDESIGN-SPEC §0's fifth menu item, and the one that was a 404 on production during the
   * founder's walk. `message-square-text` is §0's own choice for it, and §3 and §7.1 claim no
   * icon in that family.
   */
  { href: "/family-texts", label: nav.familyTexts, icon: MessageSquareText, inMenu: true },
  /*
   * OFF the menu — Firia's ruling of 2026-10-17 8:36 PM ET, over the 6:19 PM one that had put
   * them on it: **the menu is five items, the same five at every width** (REDESIGN-SPEC §9.2,
   * audit §2 item 2 — the rail on production carried seven). Neither of these is a destination
   * of the day: Exceptions & Approvals is the "For you" tab inside Family texts (§9.2), and
   * Health & ROI is a tab inside Today once #60 lands.
   *
   * `false` changes no access and deletes nothing: both routes still answer, both rows in the
   * access table are untouched, and `/exceptions` is a permanent redirect to Today now
   * (src/app/(app)/exceptions/page.tsx) so the address a founder has in a tab still lands on a
   * screen. Health is deliberately *not* redirected in this PR (Firia, 8:37 PM ET): it stays
   * exactly as it is.
   */
  { href: "/exceptions", label: nav.exceptions, icon: Flag, inMenu: false },
  { href: "/health", label: nav.health, icon: Activity, inMenu: false },
  /*
   * Setup is the one destination still off the menu, and §0 is why rather than the build: "van
   * counts are set only on the Ramp iPad; Plan routes shows them read-only", so the screen this
   * item opens is being taken apart rather than finished. The route, its row and its answer to
   * a typed URL are untouched.
   */
  { href: "/setup", label: nav.setup, icon: Settings, inMenu: false },
];

/**
 * THE MENU: five items, the same five in the same order at every width (REDESIGN-SPEC §9.2).
 * Both rails render this list — the 232 px rail, the 64 px icon rail and the phone tab bar — so
 * there is one answer to "what is on the menu" at every width, and the bar has one tab per item
 * rather than four and an overflow (`navItemsFor` narrows it to one role).
 */
export const menuItems: readonly NavItem[] = navItems.filter((item) => item.inMenu);

/** §9.2 and the mockup: five equal tabs below 768, which is this menu and no sixth slot. */
export const MENU_SIZE = 5;

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
  const caller = role ? ({ kind: "STAFF", role } as const) : ({ kind: "ANONYMOUS" } as const);
  return menuItems.filter((item) => canOpenPage(caller, item.href));
}
