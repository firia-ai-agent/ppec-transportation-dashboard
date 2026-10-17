import { mapViewerOf } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import {
  buildBoard,
  CLOCK_PARAM,
  requestedBoardDay,
  requestedClockSpeed,
  requestedScenarioTick,
} from "@/domain/board/board";
import { snapshotFor } from "@/domain/board/live";
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
 * it, the shell names none, and there is no switcher — Vera's final call. Nothing a request
 * carries changes that day either (Veri #49): the date override is a test path, gated on a
 * local synthetic shell that asked for it by name, so on a deployment `?date=` is a parameter
 * nothing reads rather than the switcher the control was taken away from. The day it reaches is
 * the day the board is read at — a day before the demo day after the last van is in, so every
 * ride on it has an outcome (AT-13's held ride, AT-10's arrival that is not a handoff), which is
 * what the browser checks walk (`dateOverrideAllowed` in src/domain/board/day.ts).
 *
 * `?tick=` is the same test path for the *instant* the demo day is read at, and it is read
 * through the same gate and the same function (`requestedBoardDay`, which calls
 * `dateOverrideAllowed`). It is how AT-13's browser check walks the demo day past Noah O.'s
 * 4:20 PM drop-off and watches the afternoon that had nothing to say at 07:42 become the ride
 * that ends holding him. No deployment has a clock control either, production included: there
 * is no control on this screen and no parameter behind it on anything the platform runs.
 *
 * Live updates and the map pane are here now (slice 3), and they are rendered at the **same
 * instant** the rows are — the one tick this request resolved to, so a board walked to the
 * afternoon by `?tick=` has a map pane in the afternoon too. The first live snapshot is computed
 * on the server beside the board and handed to the client, so the first paint is the whole
 * surface and a stream that never connects leaves a board that is still true, with the §2 amber
 * bar above it saying the updates have stopped. The stream itself is `/api/stream` (ADR-002),
 * opened once per tab by the console shell.
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
  // was always meant to filter. The date is read through the gate, so unless this is a test
  // shell that asked for the override there is one day to be on: the demo day (PRD §6.1).
  const query = one(params.q) ?? "";
  const tickRaw = one(params[CLOCK_PARAM]);
  const board = buildBoard(requestedBoardDay(one(params.date), tickRaw, process.env));

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
  const tick = requestedScenarioTick(tickRaw, process.env);
  const initialSnapshot = live ? snapshotFor(mapViewerOf(caller), tick) : null;
  // §6.2's clock speeds, the review and test path — and read through the *same gate* as the
  // date and the tick above, not a third one of its own (Veri): off a test shell, and on every
  // deployment, the clock is the console's own ×1 whatever `?speed=` says.
  const speed = requestedClockSpeed(one(params.speed), process.env);

  return (
    <TodayBoard
      board={board}
      query={query}
      initialSnapshot={initialSnapshot}
      speed={speed}
    />
  );
}
