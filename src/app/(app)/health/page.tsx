import { requirePage } from "@/auth/page-guard";
import { buildBoard } from "@/domain/board/board";
import { adapterHealth } from "@/domain/health/adapters";
import { dayCounts } from "@/domain/health/metrics";
import { health } from "@/ui/copy";
import { HealthScreen } from "./HealthScreen";

export const metadata = { title: health.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Health & ROI (PRD §14 SURF-06/07, DESIGN-DIRECTION §4.6).
 *
 * Server-side role guard first, before anything is rendered: /health is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 *
 * Everything on the screen is computed here, on the server, from **the same board `/today`
 * renders** — `buildBoard()` over the demo day, which is the leg machine for each ride's state,
 * the capacity solver for whether a van fits its riders, and the ETA engine over the committed
 * routes for the arrival windows. The four numbers are counts over those rows
 * (src/domain/health/metrics) and the adapter rows are this deployment's own configuration read
 * back (src/domain/health/adapters). Nothing is a figure typed into a template: no baseline, no
 * rate, no saving in dollars, because §17.3's formulas take a four-week measured baseline
 * (§17.4) that this deployment does not have.
 *
 * One day, and it is the demo day: this screen takes no `?date=`, because the numbers are about
 * the day the board is on and a second way to choose a day is a second day on screen (PRD §6.1,
 * Vera's final call). `buildBoard()`'s own default is that day.
 *
 * The DEMO banner and the one source chip come from the root layout, on every route — this page
 * must not mount a second pair.
 */
export default async function Page() {
  await requirePage("/health");
  const board = buildBoard();
  return (
    <HealthScreen
      board={board}
      counts={dayCounts(board)}
      adapters={adapterHealth(board, process.env)}
    />
  );
}
