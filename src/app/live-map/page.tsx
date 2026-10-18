/**
 * /live-map — where every van is now: the M5 map pane on its own route until the map lands
 * inside SURF-01 (BUILD-PLAN-M2 P-03). Vera and Veri also walk the §10 map checklist lines here
 * (attribution always visible, no violet on the map, positron with the §5.1 water override,
 * reduced-motion camera). With the M5 simulator wired in the trucks move: a client-side
 * scenario clock replays the deterministic runs in src/fixtures/replays.ts (PRD §18.2 steps
 * 7–8), and the vans carry the labels the board carries — V1, V2, V3 (src/fixtures/fleet.ts,
 * MOCKS §2), so the van a coordinator reads on the board is the van they find on the map.
 *
 * It was `/map-preview` and is a permanent redirect there still (src/app/map-preview/page.tsx);
 * "preview" is out of every menu label and address (Vera's review, 2026-10-17).
 *
 * No database, no SSE, no server actions, no sending: everything on the page is Simulated by
 * construction (ADR-015 synthetic-only) and the notification list is *decisions* only.
 *
 * It is behind staff sign-in. A deployed URL is guessable, and this page draws a whole fleet,
 * every stop's family label and every notification decision — so the route is guarded exactly
 * as the other protected pages are, by the one access table (src/auth/access.ts), and the role
 * decides which of those the viewer actually gets (src/domain/access/map-view.ts holds that
 * matrix).
 *
 * The DEMO banner and the one NFR-09 source-mode chip come from the root layout
 * (src/app/layout.tsx), which renders them on every route — this page must not mount a second
 * pair. That chip is also what the screen's name leans on: it says "Simulated" here as it does
 * everywhere, which is why the heading can be the screen's job ("Live map") rather than a note
 * about how finished the build is.
 */

import Link from "next/link";
import LiveFleetMap from "@/components/map/LiveFleetMap";
import { fill, liveMap, planRoutes, rampIpad } from "@/ui/copy";
import { canOpenPage, mapViewerOf } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";

export const metadata = { title: liveMap.documentTitle };

/** The row a screen link sits in, and the ≥44 px target inside it (§9). */
const LINK_ROW = { margin: 0, fontSize: "var(--body-console)" } as const;
const TAP_TARGET = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "var(--target-console)",
} as const;

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function LiveMapPage() {
  // Signed out is a redirect to sign-in; a role the table does not list is a 403 and the
  // no-access page (forbidden.tsx beside this file). Which *data* the role then sees is
  // src/domain/access/map-view.ts.
  const caller = await requirePage("/live-map");
  const viewer = mapViewerOf(caller);

  return (
    <main style={{ padding: "var(--space-5)", display: "grid", gap: "var(--space-4)" }}>
      {/*
        No title and no helper lines here. The title is the frame's page header bar
        (src/ui/PageHeader.tsx, audit §2 item 1), and the two sentences that used to open this
        screen — what the map is, and that it is signed-in only — are deleted: audit §3 and §4
        item 9 allow one title and at most one helper line per screen, and where the positions
        come from is already said by the one Simulated chip in the DEMO bar (§7.1).
      */}
      {/*
        The ramp iPad is a sibling surface behind the same guard, and the two are walked in one
        sitting, so each one says where the other is. They are both in the nav rail as well; this
        is the in-page shortcut between the pair.

        §9: ≥44 px of tappable height. These two were the line-height of their own text — 18 px,
        which on a phone is a link you aim at and miss (the founder's 2026-10-17 walk).
      */}
      <p style={LINK_ROW}>
        <Link href="/ramp-ipad" style={TAP_TARGET}>
          {fill(liveMap.openScreen, { page: rampIpad.heading })}
        </Link>
      </p>
      {/*
        Plan routes is the third screen behind the same door, and it is the coordinator's and
        the director's (src/auth/access.ts). The link is offered only to a role whose own row
        opens that page — hiding it is a courtesy, not the guard: /plan-routes checks the table
        again on the server, like every other page.
      */}
      {canOpenPage(caller, "/plan-routes") ? (
        <p style={LINK_ROW}>
          <Link href="/plan-routes" style={TAP_TARGET}>
            {fill(liveMap.openScreen, { page: planRoutes.heading })}
          </Link>
        </p>
      ) : null}
      <LiveFleetMap viewer={viewer} />
    </main>
  );
}
