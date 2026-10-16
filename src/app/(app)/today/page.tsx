import { requirePage } from "@/auth/page-guard";
import { buildBoard, boardInstantMs } from "@/domain/board/board";
import { serviceDateIso, serviceDateLabel } from "@/ui/service-date";
import { TodayBoard } from "./TodayBoard";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * The board (PRD §14 SURF-01, DESIGN-DIRECTION §4.1) and the child drawer beside it (SURF-02).
 *
 * Server-side role guard first, before anything is rendered: /today is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 *
 * Every row is computed here, on the server, by src/domain/board — the leg machine for the
 * ride's state, the capacity solver for whether the van fits its riders, the ETA engine over
 * the committed routes for the arrival window and the van's location — from the synthetic day
 * `demo reset` seeds. There is no mock row anywhere in this path: a fact on this screen is a
 * fact one of those modules produced, which is what makes a screenshot of it worth anything.
 *
 * What is not here yet, and is not faked in its absence: live updates, the map pane beside the
 * rows, the inbox and the exceptions table. Each lands in its own change.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage("/today");

  // The shell's search box submits `?q=` here (src/ui/SearchField.tsx); this is the board it
  // was always meant to filter.
  const raw = (await searchParams).q;
  const query = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  const board = buildBoard();
  const instant = new Date(boardInstantMs());

  return (
    <TodayBoard
      board={board}
      query={query}
      serviceDateLabel={serviceDateLabel(instant)}
      serviceDateIso={serviceDateIso(instant)}
    />
  );
}
