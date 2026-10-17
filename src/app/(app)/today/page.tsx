import { requirePage } from "@/auth/page-guard";
import { buildBoard, requestedServiceDay } from "@/domain/board/board";
import { ARRIVAL_PARAM, decodeFinding, replanForArrival } from "@/domain/plan/arrival";
import { screenArrival } from "@/ui/arrival-lines";
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
 * The other parameter a request may carry is a ramp check (`?arrival=`), which is how the ramp
 * iPad hands this board a van it has just looked at: the board does not re-plan — it shows a
 * day — so what reaches it is the *outcome* the solver produced and not the planner, as a note
 * on each ride the check was about. It is read through the module that wrote it, which answers
 * null for anything this day cannot be about, so an unreadable one is a parameter nothing reads.
 *
 * A note is all it is. PRD §9 l.865 gives the decision after a ramp check to a coordinator, so
 * the ride's own state is still the leg machine's over the day's recorded facts — a proposal
 * never overwrites what the day observed.
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
  const board = buildBoard(requestedServiceDay(one(params.date), process.env));

  // The ramp check, if the link carried a readable one. Re-planned here, on the server, because
  // the same finding always produces the same re-plan and the board's rows are computed here too.
  const finding = decodeFinding(one(params[ARRIVAL_PARAM]));
  const arrival = finding ? screenArrival(replanForArrival(finding)) : null;

  return <TodayBoard board={board} query={query} arrival={arrival} />;
}
