/**
 * The four flags the board and the ramp fit a child by, read off that child's **approved** need
 * items.
 *
 * SOURCE: redesign spec §6.4 ("child needs become 4 flags … over APPROVED `transport_need_item`s"),
 * §0's equipment vocabulary, and DECISION-LEDGER row 1 / PRD VEH-01: **fulfilment counts approved
 * needs only**. A need a family has told us about but no director has signed is on the child's
 * record and is not planned against — it must not change where a child rides, and it must not
 * disappear either, which is why the derivation is written down here rather than inferred at a
 * call site.
 *
 * It takes **categories**, not a fixture (Firia, 2026-10-17 7:18 PM ET). Where those categories
 * come from is the roster's business: `ops.transport_need_item` through the SQL day source
 * (src/modules/roster/sql.ts) when there is a database, and the demo fixtures through the demo
 * adapter (src/modules/demo/day-source.ts) when there is not. This module cannot tell, which is
 * the point — it used to import `CHILDREN` and a Save on the panel could therefore change a row
 * and not the board.
 *
 * `transport_profile.mobility` is deliberately **not** read. A chair is the approved
 * `WHEELCHAIR_SECUREMENT` item and nothing else, so turning Wheelchair off on the panel really
 * does take the chair off the plan; mobility stays exactly as it was (every child in the
 * synthetic day whose mobility is `WC` also carries that item, so no rider changes by this).
 *
 * Deliberately *not* here: securement hardware and chair footprint (conflict C3), seating
 * separation and maximum ride time (C7). The founder deferred all four after the demo on
 * 2026-10-17 2:59 PM ET, so they stay on the profile and out of fit.
 *
 * Pure: categories in, flags out. No clock, no database, no network, no fixtures.
 */
import {
  CATEGORY_OF_PANEL_FLAG,
  FLAG_OF_CATEGORY,
  NO_NEEDS,
  PANEL_CATEGORIES,
  type NeedFlags,
} from "@/config/equipment";

/** The flags a set of **approved** categories adds up to. Anything unknown sets nothing. */
export function needsFromCategories(categories: Iterable<string>): NeedFlags {
  const flags: NeedFlags = { ...NO_NEEDS };
  for (const category of categories) {
    const flag = FLAG_OF_CATEGORY[category];
    if (flag) flags[flag] = true;
  }
  return flags;
}

/** The three the child panel shows, as the panel's own Yes/No values. */
export type PanelNeeds = { wheelchair: boolean; carSeat: boolean; oxygen: boolean };

/** What the panel opens on for a child: their three flags, in the panel's order. */
export function panelNeedsOf(needs: NeedFlags): PanelNeeds {
  return { wheelchair: needs.wheelchair, carSeat: needs.carSeat, oxygen: needs.oxygen };
}

/**
 * What a Save means in the profile's own vocabulary: the categories to have, and the categories
 * to stop having.
 *
 * The panel owns three categories and no others, so a Save never touches the nurse's item, the
 * lift's, the chair's measurements or anything else on the profile — it flips exactly what the
 * person in front of it was looking at.
 */
export function categoryChangesFor(panel: PanelNeeds): { on: string[]; off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const [flag, category] of Object.entries(CATEGORY_OF_PANEL_FLAG) as [
    keyof PanelNeeds,
    string,
  ][]) {
    (panel[flag] ? on : off).push(category);
  }
  return { on, off };
}

/** The categories the panel is allowed to write, for a route that will not take another. */
export function isPanelCategory(category: string): boolean {
  return (PANEL_CATEGORIES as readonly string[]).includes(category);
}
