import { requirePage } from "@/auth/page-guard";
import { buildBoard, CLOCK_PARAM, requestedBoardDay } from "@/domain/board/board";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
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
 * What is not here yet, and is not faked in its absence: live updates, the map pane beside the
 * rows, the inbox and the exceptions table. Each lands in its own change.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage("/today");

  const params = await searchParams;
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  // The shell's search box submits `?q=` here (src/ui/SearchField.tsx); this is the board it
  // was always meant to filter. The date is read through the gate, so unless this is a test
  // shell that asked for the override there is one day to be on: the demo day (PRD §6.1).
  const query = one(params.q) ?? "";
  const board = buildBoard(
    requestedBoardDay(one(params.date), one(params[CLOCK_PARAM]), process.env),
  );
  /*
   * Which children's families this day texted (PRD §18.2 step 7 / AT-03), from the same
   * projection the phone panel renders. Computed here, on the server, so the drawer can offer the
   * thread for a child that has one and say plainly that there is none for a child that does not.
   */
  const textedChildKeys = demoLateDropoffs(board.day).map((text) => text.childKey);

  return <TodayBoard board={board} query={query} textedChildKeys={textedChildKeys} />;
}
