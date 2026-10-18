import { requirePage } from "@/auth/page-guard";
import { buildBoard, CLOCK_PARAM, requestedBoardDay } from "@/domain/board/board";
import { getDayReadiness, serviceDateAt } from "@/domain/day/day-facts";
import { readRightNow } from "@/domain/health/right-now-facts";
import { rightNowTiles } from "@/domain/health/right-now";
import { savedPlacementsForBoard } from "@/modules/plan/store";
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
 * One fact on a row is not computed at all, because it is a person's decision: **which van a
 * child rides this leg**. That comes from the plan a coordinator saved for this date and leg,
 * read through the plan board's own `loadBoard` (`savedPlacementsForBoard`), so this screen and Plan
 * routes cannot disagree about who is on which van — which is what they were doing for five of
 * nine children (Veri's prod check, 2026-10-18). A leg nobody has saved a plan for is still the
 * seeded day's own runs, exactly as before.
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
  const caller = await requirePage("/today");

  const params = await searchParams;
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  // The shell's search box submits `?q=` here (src/ui/SearchField.tsx); this is the board it
  // was always meant to filter. The date is read through the gate, so unless this is a test
  // shell that asked for the override there is one day to be on: the demo day (PRD §6.1).
  const query = one(params.q) ?? "";

  /*
   * WHICH VAN EACH CHILD IS ON COMES FROM THE PLAN SOMEBODY SAVED (Firia, 2026-10-17 6:02 PM ET
   * and the S1 ruling of 2026-10-18 4:45 AM ET).
   *
   * Read for the date and the site the plan board *writes*: today at the centre
   * (src/modules/plan/when.ts `resolveDate`, which is `serviceDateAt` here) and this caller's own
   * membership — which is also the date and site the step strip below reads its three steps for,
   * so the two halves of this page cannot be about different days. The demo day the rows are
   * *computed* on is a fixture day of its own (src/domain/board/day.ts) and is nobody's service
   * date to save a plan for.
   *
   * A session with no site reads nothing, by the shape of the session rather than by a flag: that
   * is the browser check's synthetic caller, and it gets the seeded day exactly as before.
   */
  const siteId = caller.memberships[0]?.siteId ?? null;
  const saved = await savedPlacementsForBoard(siteId, serviceDateAt());
  const board = buildBoard(
    requestedBoardDay(one(params.date), one(params[CLOCK_PARAM]), process.env),
    saved,
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
  const readiness = await getDayReadiness({ siteId });
  const steps = stepsFor(caller.kind === "STAFF" ? caller.role : null, readiness);
  /*
   * The Health tab's four numbers, from the same centre and the same day as the strip above.
   * A session with no site — every browser check — reads nothing, and the tiles say so with
   * zeros rather than with a figure the day does not have.
   */
  const tiles = rightNowTiles(await readRightNow({ siteId }));

  // The strip belongs under the board's own header (REDESIGN-SPEC §9.2), so it is handed to
  // the board rather than rendered above everything: the board is what owns that header.
  return <TodayBoard board={board} query={query} steps={steps} tiles={tiles} />;
}
