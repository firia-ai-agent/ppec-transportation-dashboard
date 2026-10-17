import { mapViewerOf } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { BOARD_SCENARIO_TICK, buildBoard, serviceDayFor } from "@/domain/board/board";
import { snapshotFor } from "@/domain/board/live";
import { normalizeSpeed } from "@/domain/eta/scenario-clock";
import { TodayBoard } from "./TodayBoard";
import { streamsLiveUpdates } from "./live-view";

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
 * One date on screen (PRD §6.1), and it is the demo day the scenario replays: the board names
 * it, the shell names none, and there is no switcher — Vera's final call. The day also decides
 * *when* it is read, which is what `?date=` is still for: a day before the demo day is read
 * after the last van is in, so every ride on it has an outcome (AT-13's held ride, AT-10's
 * arrival that is not a handoff). That is a review and test path — the console offers no control
 * that reaches it, and what a coordinator sees is the demo day (src/domain/board/day.ts).
 *
 * Live updates and the map pane are here now (slice 3). Both are rendered at the **same
 * instant** the rows are: the first live snapshot is computed on the server beside the board
 * and handed to the client, so the first paint is the whole surface and a stream that never
 * connects leaves a board that is still true — with the §2 amber bar above it saying the
 * updates have stopped. The stream itself is `/api/stream` (ADR-002), opened once per tab by
 * the console shell.
 *
 * What is not here yet, and is not faked in its absence: the inbox, the exceptions table and
 * every write (confirm handoff, override, snooze, approve). Each lands in its own change.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/today");

  const params = await searchParams;
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  // The shell's search box submits `?q=` here (src/ui/SearchField.tsx); this is the board it
  // was always meant to filter. No `?date=`, or one that is not a day in range, is the demo day
  // — the only day the console itself ever asks for (PRD §6.1).
  const query = one(params.q) ?? "";
  const board = buildBoard(serviceDayFor(one(params.date)));

  /*
   * The fleet at the board's own tick, computed here so the rows and the map are one instant
   * and the page needs no connection to be complete. Only on the day the scenario replays: a
   * finished day has no van on the road and a day that has not started has none yet.
   */
  const live = streamsLiveUpdates(board.day);
  /*
   * Filtered by role, exactly as the stream filters it (src/domain/board/live.ts `forViewer`):
   * the first paint and the first event have to be the same board, and the rule about what a
   * role may hold is the map-view matrix's, in one place, applied before the payload is built.
   */
  const initialSnapshot = live ? snapshotFor(mapViewerOf(caller), BOARD_SCENARIO_TICK) : null;
  // §6.2's clock speeds, the review and test path — the same shape as `?date=`: anything that
  // is not one of the three offered speeds is the console's own (`normalizeSpeed`).
  const speed = normalizeSpeed(one(params.speed));

  return (
    <TodayBoard
      board={board}
      query={query}
      initialSnapshot={initialSnapshot}
      speed={speed}
    />
  );
}
