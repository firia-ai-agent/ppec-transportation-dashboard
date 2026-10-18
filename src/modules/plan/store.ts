/**
 * The plan board's one way in: which store a request gets, and the day it reads out of it.
 *
 * Everything above this file — the board, the ramp iPad, the four endpoints — asks for a
 * `BoardView` and never for a row or a fixture, so the rules about *what the day is* are written
 * once here and once in the domain rather than in each screen:
 *
 *  - which vans are out, who is driving them and which children ride this leg — the one day-data
 *    port (src/domain/day/source.ts), whose only implementation today is the demo adapter;
 *  - what each van is planned on: today's `CHECKED` row, or the shared config's defaults
 *    (src/domain/plan/setup.ts; Firia/Veri 6:00 PM ET, no carry-over);
 *  - what the saved plan says, and the version a save has to name;
 *  - whether the demo day has been started at all — from the database's own scenario clock
 *    (src/modules/plan/sql.ts), never from a browser's storage (Vera's differences list, item 2).
 */
import { VANS } from "@/config/vans";
import { deriveReadiness, type DayReadiness } from "@/domain/day/readiness";
import { defaultLeg, type Direction } from "@/domain/day/leg";
import type { DayDataSource } from "@/domain/day/source";
import {
  emptyPlan,
  ridersInVan,
  stopNumbers,
  type BoardDay,
  type BoardPlan,
  type BoardVan,
  type Placement,
} from "@/domain/plan/board";
import { resolveSetup, type SetupSource } from "@/domain/plan/setup";
import { getNeonDb } from "@/db/exec";
import { demoDaySource } from "@/modules/demo/day-source";
import { sqlDaySource } from "@/modules/roster/sql";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { vanArrival } from "@/ui/copy";
import { MEMORY_STORE_REFUSED, memoryPlanStore } from "./memory";
import { sqlPlanStore } from "./sql";
import type { PlanStore, SavedPlacement } from "./types";

export type { PlanStore } from "./types";

/**
 * The store for this request: the three tables when a database is configured, and this process's
 * memory when there is none.
 *
 * The condition is `DATABASE_URL`, not a flag somebody can set: every deployment has one
 * (production and previews share the one Neon database, DECISION-LEDGER #43), so a deployment
 * always gets SQL. Asking for memory while a database is configured is refused outright rather
 * than honoured — see src/modules/plan/memory.ts for why that rule is a `throw` (Firia's rule 4).
 */
export function planStore(env: Record<string, string | undefined> = process.env): PlanStore {
  return env.DATABASE_URL ? sqlPlanStore(getNeonDb()) : memoryPlanStore(env);
}

/** True when this server has no database to read: the one case the memory store serves. */
export function hasNoDatabase(env: Record<string, string | undefined> = process.env): boolean {
  return !env.DATABASE_URL;
}

/**
 * The day's roster and fleet: the database when one is configured, the synthetic day when there
 * is none. Screens never see which — they call `loadBoard`.
 *
 * The condition is the same one the store uses, for the same reason: a deployment always has
 * `DATABASE_URL`, so a deployment always reads rows, and the child panel's Save therefore moves
 * the board (Firia's 7:18 PM ET correction and Veri's gate (c)).
 */
export function dayDataSource(
  siteId: string,
  env: Record<string, string | undefined> = process.env,
): DayDataSource {
  if (env.DATABASE_URL) return sqlDaySource(getNeonDb(), siteId);
  // A deployment that lost its database does not quietly fall back to fixtures either (Veri F6).
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") {
    throw new Error(MEMORY_STORE_REFUSED);
  }
  return demoDaySource();
}

export type BoardView = {
  day: BoardDay;
  plan: BoardPlan;
  /** The version a save must name. `0` when no plan has been saved for this date and leg. */
  version: number;
  /** When the plan on screen was saved, ISO, or null. */
  savedAt: string | null;
  /** Who saved it, in words, or null. */
  savedBy: string | null;
  /** Has the demo day been started for this date (§9.1)? */
  started: boolean;
  readiness: DayReadiness;
};

/**
 * The whole board for one date and one leg: the day, the plan, and how ready the day is.
 *
 * One pass over the store — the context, the setup rows and the saved plan — so a page render is
 * three queries and not three per van.
 */
export async function loadBoard(
  store: PlanStore,
  siteId: string,
  date: string,
  direction: Direction,
  source: DayDataSource = dayDataSource(siteId),
): Promise<BoardView> {
  const dayVans = await source.vans(date);
  const [context, rows, saved, riders, others] = await Promise.all([
    store.dayContext(siteId, date),
    store.setupRows(siteId, date, dayVans.map((van) => van.id)),
    store.loadPlan(siteId, date, direction),
    source.riders(date, direction),
    source.others(date, direction),
  ]);

  const vans: BoardVan[] = dayVans.map((van) => {
    const key = vehicleKeyOf(van.id);
    const resolved = resolveSetup(
      key,
      date,
      rows.filter((row) => row.vehicleId === van.id),
    );
    return {
      ...van,
      setup: resolved.setup,
      setupState: resolved.state,
      setupSource: resolved.source,
      // A browser-check row records no user, and the front desk is who counts a van: "Ramp staff"
      // is the honest attribution rather than an invented person.
      setupBy: resolved.source === "CHECKED" ? (resolved.setBy ?? vanArrival.observedBy) : null,
    };
  });

  const day: BoardDay = { date, direction, vans, riders, others };

  const plan = saved ? planFrom(day, saved.placements) : emptyPlan(day);
  const started = context.startedDate === date;

  return {
    day,
    plan,
    version: saved?.version ?? 0,
    savedAt: saved?.savedAt ?? null,
    savedBy: saved?.savedBy ?? null,
    started,
    readiness: readinessFrom({ day, plan, saved, context, started, date, direction }),
  };
}

/** The config key for a vehicle id, so the defaults come from the one shared van config. */
function vehicleKeyOf(vehicleId: string): string {
  const van = VANS.find((candidate) => vehicleIdOf(candidate.vehicleKey) === vehicleId);
  if (!van) throw new Error("unknown van");
  return van.vehicleKey;
}

/**
 * A saved plan, read onto today's roster.
 *
 * It starts from the empty board and applies only what still makes sense: a child the day no
 * longer has is dropped, and a child in a van the day no longer runs goes back to Unassigned
 * rather than into a van nobody can see. A plan is a record of a decision, and a decision about
 * somebody who is not here today is not a placement to honour.
 */
export function planFrom(
  day: BoardDay,
  placements: Readonly<Record<string, Placement>>,
): BoardPlan {
  const vans = new Set(day.vans.map((van) => van.id));
  const plan: Record<string, Placement> = { ...emptyPlan(day) };
  for (const [token, placement] of Object.entries(placements)) {
    if (!(token in plan)) continue;
    if (placement.bucket === "VAN" && (!placement.vanId || !vans.has(placement.vanId))) continue;
    plan[token] = placement;
  }
  return plan;
}

/** Every child's place on the board, with the stop number their van drives them at. */
export function placementsToSave(
  day: BoardDay,
  plan: BoardPlan,
): Record<string, SavedPlacement> {
  const stopSeq = new Map<string, number>();
  for (const van of day.vans) {
    for (const [token, seq] of stopNumbers(ridersInVan(day, plan, van.id))) {
      stopSeq.set(token, seq);
    }
  }
  return Object.fromEntries(
    Object.entries(plan).map(([token, placement]) => [
      token,
      { ...placement, stopSeq: stopSeq.get(token) ?? null },
    ]),
  );
}

function readinessFrom(input: {
  day: BoardDay;
  plan: BoardPlan;
  saved: { version: number; savedAt: string; savedBy: string | null } | null;
  context: { vansOut: number; approvalsWaiting: number };
  started: boolean;
  date: string;
  direction: Direction;
}): DayReadiness {
  const { day, plan, saved, context, started, date, direction } = input;
  const checked = day.vans.filter((van) => van.setupState === "CHECKED").length;
  // The day as a whole stands on the weakest rung any van is on: one van counted today does not
  // make the board's line go away while two others are on their defaults.
  const source: SetupSource = day.vans.every((van) => van.setupSource === "CHECKED")
    ? "CHECKED"
    : "DEFAULT";

  return deriveReadiness({
    date,
    leg: direction,
    started,
    vans: day.vans.length,
    vansCheckedToday: checked,
    setupSource: source,
    planSavedAt: saved?.savedAt ?? null,
    planSavedBy: saved?.savedBy ?? null,
    unassigned: day.riders.filter((rider) => plan[rider.token]?.bucket !== "VAN").length,
    vansOut: context.vansOut,
    approvalsWaiting: context.approvalsWaiting,
  });
}

/**
 * The shared readiness helper (§9.4): the three steps of the day, for every empty state and for
 * the server guards.
 */
export async function getDayReadiness(
  siteId: string,
  date: string,
  leg: Direction,
  store: PlanStore = planStore(),
): Promise<DayReadiness> {
  return (await loadBoard(store, siteId, date, leg)).readiness;
}

export { defaultLeg };
