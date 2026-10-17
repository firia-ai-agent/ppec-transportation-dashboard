/**
 * The plan board's one way in: which store a request gets, and the day it reads out of it.
 *
 * Everything above this file — the page, the four routes, the ramp iPad — asks for a `BoardView`
 * or a `DayReadiness` and never for a row, so the rules about *what the day is* are written once
 * here and once in the domain, rather than in each screen:
 *
 *  - which vans are out, and what each is planned against (the default ladder, §1.6);
 *  - which children ride this leg, and who is away (`ops.attendance_exception`, not a guess);
 *  - what the saved plan says, and the version a save has to name;
 *  - whether the demo day has been started at all (§9.1's first step).
 *
 * `getDayReadiness` is the helper Vera's §9 interim rules make binding: "One shared helper …
 * The step strip, the empty states and the server guards all read from it. Never write the check
 * twice." The arithmetic is pure and lives in src/domain/day/readiness.ts; this is the loader.
 */
import { VANS } from "@/config/vans";
import { deriveReadiness, defaultLeg, type DayReadiness } from "@/domain/day/readiness";
import {
  boardRiders,
  boardVans,
  emptyPlan,
  otherChildren,
  ridersInVan,
  stopNumbers,
  type BoardDay,
  type BoardPlan,
  type Placement,
} from "@/domain/plan/board";
import { resolveSetup, type SetupSource } from "@/domain/plan/setup";
import type { Direction } from "@/domain/solver";
import { getNeonDb } from "@/db/exec";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { vanArrival } from "@/ui/copy";
import { memoryPlanStore } from "./memory";
import { sqlPlanStore } from "./sql";
import type { PlanStore, SavedPlacement } from "./types";

export type { PlanStore } from "./types";

/**
 * The store for this request: the three tables when a database is configured, and this process's
 * memory when there is none.
 *
 * The condition is `DATABASE_URL`, not a flag somebody can set: every deployment has one
 * (production and previews share the one Neon database, DECISION-LEDGER #43), so a deployment
 * always gets SQL. The only servers without one are the browser check's and a local `next dev`
 * that has not been pointed at a database — see src/modules/plan/memory.ts for why that case
 * exists at all and what it is not allowed to prove.
 */
export function planStore(env: Record<string, string | undefined> = process.env): PlanStore {
  return env.DATABASE_URL ? sqlPlanStore(getNeonDb()) : memoryPlanStore();
}

/** True when this server has no database to read: the one case the memory store serves. */
export function hasNoDatabase(env: Record<string, string | undefined> = process.env): boolean {
  return !env.DATABASE_URL;
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

const vanIds = (): string[] => VANS.map((van) => vehicleIdOf(van.vehicleKey));

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
): Promise<BoardView> {
  const [context, rows, saved] = await Promise.all([
    store.dayContext(siteId, date),
    store.setupRows(siteId, date, vanIds()),
    store.loadPlan(siteId, date, direction),
  ]);

  const vans = boardVans((vehicleKey) => {
    const resolved = resolveSetup(
      vehicleKey,
      date,
      rows.filter((row) => row.vehicleId === vehicleIdOf(vehicleKey)),
    );
    return {
      setup: resolved.setup,
      setupState: resolved.state,
      setupSource: resolved.source,
      ...(resolved.fromDate ? { setupFromDate: resolved.fromDate } : {}),
      // A seeded or browser-check row records no user, and the front desk is who counts a van:
      // "Ramp staff" is the honest attribution rather than an invented person.
      setupBy: resolved.setBy ?? (resolved.source === "DEFAULT" ? null : vanArrival.observedBy),
    };
  });

  const day: BoardDay = {
    date,
    direction,
    vans,
    riders: boardRiders(direction, context.absentTokens),
    others: otherChildren(direction, context.absentTokens),
  };

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
  // make the board's banner go away while two others are on yesterday's numbers.
  const source: SetupSource = day.vans.some((van) => van.setupSource === "DEFAULT")
    ? "DEFAULT"
    : day.vans.some((van) => van.setupSource === "YESTERDAY")
      ? "YESTERDAY"
      : "TODAY";
  const fromDate = day.vans.find((van) => van.setupSource === "YESTERDAY")?.setupFromDate;

  return deriveReadiness({
    date,
    leg: direction,
    started,
    vans: day.vans.length,
    vansCheckedToday: checked,
    setupSource: source,
    ...(fromDate ? { setupFromDate: fromDate } : {}),
    planSavedAt: saved?.savedAt ?? null,
    planSavedBy: saved?.savedBy ?? null,
    unassigned: day.riders.filter((rider) => plan[rider.token]?.bucket !== "VAN").length,
    vansOut: context.vansOut,
    approvalsWaiting: context.approvalsWaiting,
  });
}

/**
 * The shared readiness helper (§9.4, Vera's interim rule): the three steps of the day, for the
 * Today strip, for every empty state and for the server guards.
 *
 * It loads the board because the steps *are* the board: how many vans are counted, whether a plan
 * is saved, whether anything has moved. One function, so the strip and the guard cannot disagree.
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
