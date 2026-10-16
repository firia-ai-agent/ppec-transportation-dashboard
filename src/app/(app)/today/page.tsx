import { requirePage } from "@/auth/page-guard";
import { buildBoard, serviceDayFor } from "@/domain/board/board";
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
 * One service date for the screen (PRD §6.1): `?date=` picks it, the header's switcher changes
 * it, and the board is about that day and no other. The day also decides *when* it is read —
 * the demo day live, a day before it after the last van is in, a day after it as the plan
 * (src/domain/board/day.ts).
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
  // was always meant to filter. `?date=` is the header's own switcher: one service date for the
  // screen, and the board is about that day and no other (PRD §6.1).
  const query = one(params.q) ?? "";
  const board = buildBoard(serviceDayFor(one(params.date)));

  return <TodayBoard board={board} query={query} />;
}
