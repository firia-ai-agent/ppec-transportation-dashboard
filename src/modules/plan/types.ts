/**
 * What the plan board asks of storage, in one interface — so the screens never know which side of
 * it they are on.
 *
 * There are two implementations and the difference between them is honest rather than hidden:
 *
 *  - **src/modules/plan/sql.ts** — the three tables migration 0009 adds (`vehicle_setup_day`,
 *    `plan_run`, `plan_assignment`). This is the real one, and the only one any deployment uses:
 *    it is what replaces #58's in-memory `plan-store.ts`, whose plan was lost on redeploy and
 *    different per serverless instance.
 *  - **src/modules/plan/memory.ts** — the same contract over one process's memory, used only
 *    where there is no database to talk to at all, and which throws if it is asked for while one
 *    is configured (Firia's rule 4): the browser check (`pnpm e2e` starts the app
 *    with no `DATABASE_URL`, playwright.config.ts) and a local `next dev` without one. It starts
 *    from the same yesterday's-setup-and-no-plan state the demo seed writes, so the screen's
 *    behaviour is the same; what it cannot prove is that the SQL is right, which is why the SQL
 *    is tested directly against the migrations on PGlite (sql.test.ts).
 *
 * Which one a request gets is decided once, in store.ts, by whether a database is configured.
 */
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import type { Placement } from "@/domain/plan/board";
import type { SetupRow, SetupState } from "@/domain/plan/setup";
import type { VanSetup } from "@/domain/plan/fit";

/** A plan as it was last saved. */
export type SavedPlan = {
  /** The row's audit version, which the next save has to name (§1.6's optimistic lock). */
  version: number;
  /** ISO instant the server wrote it. */
  savedAt: string;
  /** Who saved it, in words, or null when nobody is recorded. */
  savedBy: string | null;
  /** Every child of the day, by child token. */
  placements: Readonly<Record<string, Placement>>;
  /** Today's departure per van where a planner set one, `{ vanId: "HH:MM" }` (ledger #76). */
  departures: Readonly<Record<string, string>>;
};

/**
 * One child's place on a board being saved: where they are, and their stop number inside the van.
 *
 * The number is derivable — a van drives its riders in window order (src/domain/plan/board.ts
 * `stopNumbers`) — and is written anyway, because the row is read by things that are not this
 * board: a manifest, the live map's stop list, a person looking at the table. A row that says
 * "Van 2, stop 3" describes itself; one that says "Van 2" needs the whole day to be re-derived
 * before it means anything.
 */
export type SavedPlacement = Placement & { stopSeq?: number | null };

export type SavePlanInput = {
  date: string;
  direction: Direction;
  /** The version the board was showing. `0` means "there was no plan when I started". */
  version: number;
  placements: Readonly<Record<string, SavedPlacement>>;
  /** Departures this save sets, `{ vanId: "HH:MM" }`; merged over the ones already saved. */
  departures?: Readonly<Record<string, string>>;
  /** The staff user saving it, when the session has one. */
  savedBy: string | null;
  now: Date;
};

export type SavePlanOutcome =
  | { ok: true; version: number; savedAt: string }
  /** Somebody else saved first: the board reloads rather than writing over them (§1.3). */
  | { ok: false; conflict: true; changedBy: string | null; version: number };

export type PutSetupInput = {
  vehicleId: string;
  date: string;
  setup: VanSetup;
  state: SetupState;
  /** The staff user who set it, when the session has one. */
  setBy: string | null;
  now: Date;
};

/** The day's other facts the readiness helper needs, read in one go. */
export type DayContext = {
  /** The service date the demo day is currently started on, or null when none is. */
  startedDate: string | null;
  /** Vans that have reported a position today. */
  vansOut: number;
  /** Approvals waiting for a person. */
  approvalsWaiting: number;
};

export interface PlanStore {
  /**
   * Every setup row for these vans on or before `date`, newest first — which is the order the
   * default ladder reads them in (src/domain/plan/setup.ts `resolveSetup`).
   */
  setupRows(siteId: string, date: string, vehicleIds: readonly string[]): Promise<SetupRow[]>;
  /** Write one van's setup for one day, replacing that day's row if there is one. */
  putSetup(siteId: string, input: PutSetupInput): Promise<void>;
  loadPlan(siteId: string, date: string, direction: Direction): Promise<SavedPlan | null>;
  savePlan(siteId: string, input: SavePlanInput): Promise<SavePlanOutcome>;
  dayContext(siteId: string, date: string): Promise<DayContext>;
  /**
   * The same store, writing inside `tx` — for a rehearsal that is always rolled back (ledger #80):
   * the database's store joins the transaction, the memory store writes to a scratch copy. Absent
   * on a store that cannot rehearse; a change against it is not rehearsed.
   */
  within?(tx: Exec): PlanStore;
}
