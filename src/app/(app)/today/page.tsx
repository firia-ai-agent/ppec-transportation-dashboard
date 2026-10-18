import { requirePage } from "@/auth/page-guard";
import { buildBoard, CLOCK_PARAM, requestedBoardDay } from "@/domain/board/board";
import { getDayReadiness } from "@/domain/day/day-facts";
import { stepsFor } from "@/ui/step-strip";
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
 * `dateOverrideAllowed`). It is how AT-13's browser check walks the demo day past Noah B.'s
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
  const caller = await requirePage("/today");

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
   * The day's three steps, as they actually stand (REDESIGN-SPEC §9.2, §9.4).
   *
   * The states come from today's own rows at this caller's centre — the vans with a `CHECKED`
   * setup row, the plan saved for this leg — read through one helper that never throws and
   * never says Done about a day it could not read (src/domain/day/day-facts.ts). A session with
   * no site behind it, which is every browser check, takes that unread path: Needed, Needed,
   * Locked, by the shape of the session rather than by a flag a deployment could set.
   *
   * Which card is a link is still the access table's answer, per role (`stepsFor`).
   */
  const readiness = await getDayReadiness({ siteId: caller.memberships[0]?.siteId ?? null });
  const steps = stepsFor(caller.kind === "STAFF" ? caller.role : null, readiness);

  // The strip belongs under the board's own header (REDESIGN-SPEC §9.2), so it is handed to
  // the board rather than rendered above everything: the board is what owns that header.
  return <TodayBoard board={board} query={query} steps={steps} />;
}
