/**
 * THE PLAN-PLACEMENT PORT — the one way an approval is allowed to change the plan.
 *
 * Firia's gap-5 ruling (2026-10-17): an approved drop-off **change** or **cancel** has to save a
 * new plan version, and a cancel has to put the child in the `ABSENT` bucket *through the same
 * exported function the board uses*. That function is `setChildPlacement`
 * (`@/modules/plan/place.ts`), and since the board branch was merged here (`4c9f0f1`) it is
 * wired: this file binds to it and there is no second writer of `plan_run` / `plan_assignment`
 * anywhere in the approval path. The port stays a named seam, not a copy — a test can hand
 * `decideApproval` a store-backed board or a recording fake without the production call site
 * growing a parameter nobody passes.
 *
 * ## Two calls, because a change has to know where the child already is
 *
 * `setChildPlacement` names a bucket, and an approved *change* does not move anybody: the
 * drop-off time or stop moves and the child rides the same van they already rode ("Same van" is
 * one of the card's own check chips). So the port reads the plan first — the board's own
 * `loadBoard`, no second query of `plan_assignment` — and writes the child back into the bucket
 * and van they are already in, at the version that read returned. That is a real new plan version
 * with nothing silently re-seated. A *cancel* is the one placement that does move: `ABSENT`, for
 * that leg (founder 7:17 PM ET — a leg at a time, because a plan is per date *and* per leg).
 *
 * ## Where absence is read
 *
 * From `plan_assignment`, and from nowhere else. `attendance_day` keeps its own record — the
 * front desk's actual-attendance row is a different fact, recorded by a different person — but no
 * screen reads absence from it (`plan-placement.test.ts` holds that line with a grep).
 */
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import type { DayDataSource } from "@/domain/day/source";
import {
  applyPendingMoves,
  setChildPlacement as boardSetChildPlacement,
  type PlacementBucket,
  type SetChildPlacementInput,
  type SetChildPlacementOutcome,
} from "@/modules/plan/place";
import { hasNoDatabase, loadBoard, planStoreIn, type BoardView } from "@/modules/plan/store";
import type { PendingMove } from "@/domain/plan/pending";
import { vanHasLeft } from "@/modules/changes/plan-change";
import {
  recordLegReceiver,
  setLegDropoffWindow,
  type LegReceiverInput,
  type LegWindowInput,
} from "@/modules/plan/leg-write";
import { demoDaySource } from "@/modules/demo/day-source";
import { sqlDaySource } from "@/modules/roster/sql";
import type { PlanStore } from "@/modules/plan/types";

export type { PlacementBucket, SetChildPlacementInput, SetChildPlacementOutcome };
export type { LegReceiverInput, LegWindowInput };

/**
 * What an approval needs back from a placement write: whether the plan took it.
 *
 * Narrower than the board's own `SetChildPlacementOutcome`, which also carries the whole board
 * back for a screen to re-render. An approval has no board on screen — it has a decision to
 * commit or roll back — so this is `ok`, the version the plan now holds, and, when it did not
 * land, the board's own reason (`NOT_STARTED`, `CHANGED`, a fit rule). Mapping the two
 * vocabularies in one place is what keeps the rest of this path from growing a view it never
 * reads.
 */
export type PlacementSaved =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: string };

/** The board's placement writer, as an approval sees it. */
export type SetChildPlacement = (input: SetChildPlacementInput) => Promise<PlacementSaved>;

/** One leg of one day for one child: everything needed to find them on the board. */
export type PlacementQuery = {
  readonly siteId: string;
  readonly serviceDate: string;
  readonly direction: Direction;
  readonly childToken: string;
};

/** Where a child is on the plan now, and the version a write has to name. */
export type CurrentPlacement = {
  readonly bucket: PlacementBucket;
  /** The van they ride, or null in every bucket but `VAN`. */
  readonly vehicleId: string | null;
  /** `plan_run.version` for this date and leg. `0` when no plan has been saved. */
  readonly version: number;
};

/**
 * What an approval may do to the plan: read one child's place, and write it.
 *
 * Nothing wider. An approval is not allowed to re-seat a van, start a day or save a board, and a
 * port with two functions on it is how that stays true of the code rather than of a comment.
 */
export type PlanPlacementPort = {
  /** The child's bucket, van and plan version, or `null` when this day's plan has no such child. */
  readonly currentPlacement: (query: PlacementQuery) => Promise<CurrentPlacement | null>;
  readonly setChildPlacement: SetChildPlacement;
  /**
   * The agreed drop-off, onto the leg it is about (`plan/leg-write.ts` `setLegDropoffWindow`).
   *
   * Firia's 11:11 AM ET ruling of 2026-10-18 put this on the port rather than leaving it a query
   * in `decide.ts`: a time is a fact about the plan, the plan module owns the one writer of it,
   * and an approval is allowed to ask for it and nothing wider. `plan_run` has no time column —
   * `window_start` on the leg is where this schema keeps an arrival — so the placement write
   * above and this one are the two halves of "the plan really changed".
   */
  readonly setDropoffWindow: (input: LegWindowInput) => Promise<PlanWriteDone>;
  /**
   * The adult who will receive the child, onto the child's file and the leg
   * (`plan/leg-write.ts` `recordLegReceiver`) — what clears an AT-13 hold.
   */
  readonly recordReceiver: (input: LegReceiverInput) => Promise<PlanWriteDone>;
  /**
   * The route the approved change agreed (ledger #79): moves and an agreed time, through the
   * board's own Save (`applyPendingMoves`) — the plan the card showed, nothing wider. Answers with
   * the board before and after, which is what the families it makes late are told from.
   */
  readonly saveRoute: (input: RouteSaveInput) => Promise<RouteSaved>;
};

export type RouteSaveInput = {
  readonly siteId: string;
  readonly serviceDate: string;
  readonly direction: Direction;
  readonly moves: readonly PendingMove[];
  readonly departures?: Readonly<Record<string, string>>;
  readonly expectedVersion: number;
  readonly actor: string | null;
  readonly now: Date;
};

export type RouteSaved =
  | { readonly ok: true; readonly before: BoardView; readonly after: BoardView }
  | { readonly ok: false; readonly reason: string };

/** Whether the plan took a write, and the module's own reason when it did not. */
export type PlanWriteDone =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The port, for one transaction.
 *
 * A decision is one transaction — the approval claimed, the ride moved, the plan saved — and the
 * plan write is a step inside it, not a second connection racing it. So what `decideApproval`
 * takes is this: something that, handed the transaction it is already running in, answers with a
 * port that writes there. A plan saved while the rest of the decision rolled back would be a plan
 * nobody asked for, and a decision committed while the plan write failed would be a family told
 * about a change the board does not have.
 */
export type PlanPlacementPortFor = (tx: Exec) => PlanPlacementPort;

/**
 * The board, bound for real.
 *
 * Both halves read through `@/modules/plan`: `loadBoard` for the plan and `setChildPlacement` for
 * the write, both over the transaction they are handed. The store and the day source are
 * injectable for one reason — a test that wants the real writer against PGlite passes
 * `sqlPlanStoreIn(tx)` and `sqlDaySource(tx, site)`, which is how `plan-placement.test.ts` proves
 * the rows rather than a fake's call log. Production passes nothing and gets the same
 * `DATABASE_URL` decision `store.ts` makes for every other caller.
 */
export function boardPlacementPort(deps: {
  readonly store?: (tx: Exec) => PlanStore;
  readonly source?: (tx: Exec, siteId: string) => DayDataSource;
} = {}): PlanPlacementPortFor {
  return (tx) => {
    // Resolved per call, not once: `planStoreIn` reads the environment and refuses a deployment
    // with no database, and that refusal belongs to the request that needs it.
    const storeOf = () => (deps.store ? deps.store(tx) : planStoreIn(tx));
    const sourceOf = (siteId: string) =>
      deps.source ? deps.source(tx, siteId) : defaultSource(tx, siteId);

    return {
      async currentPlacement(query) {
        const view = await loadBoard(
          storeOf(),
          query.siteId,
          query.serviceDate,
          query.direction,
          sourceOf(query.siteId),
        );
        const placement = view.plan[query.childToken];
        if (!placement) return null;
        return { bucket: placement.bucket, vehicleId: placement.vanId, version: view.version };
      },
      async setDropoffWindow(input) {
        const written = await setLegDropoffWindow(tx, input);
        return written.ok ? { ok: true } : { ok: false, reason: written.reason };
      },
      async recordReceiver(input) {
        const written = await recordLegReceiver(tx, input);
        return written.ok ? { ok: true } : { ok: false, reason: written.reason };
      },
      async saveRoute(input) {
        // A van on the road keeps who is aboard: nobody out of it, nobody into it (ledger #79).
        const view = await loadBoard(storeOf(), input.siteId, input.serviceDate, input.direction, sourceOf(input.siteId));
        const left = (vanId: string | null | undefined) => vanHasLeft(view, vanId, input.now);
        const crosses = input.moves.some((m) => {
          const was = view.plan[m.childToken]?.vanId;
          const to = m.bucket === "VAN" ? m.vanId : null;
          return was !== to && (left(was) || left(to));
        });
        if (crosses) return { ok: false, reason: "VAN_LEFT" };
        const outcome = await applyPendingMoves(
          {
            siteId: input.siteId,
            serviceDate: input.serviceDate,
            direction: input.direction,
            moves: input.moves,
            departures: input.departures,
            expectedVersion: input.expectedVersion,
            actor: input.actor,
            now: input.now,
          },
          storeOf(),
          sourceOf(input.siteId),
        );
        return outcome.ok ? { ok: true, before: outcome.before, after: outcome.view } : { ok: false, reason: outcome.reason };
      },
      async setChildPlacement(input) {
        const outcome: SetChildPlacementOutcome = await boardSetChildPlacement(
          input,
          storeOf(),
          sourceOf(input.siteId),
        );
        return outcome.ok ? { ok: true, version: outcome.version } : { ok: false, reason: outcome.reason };
      },
    };
  };
}

/**
 * The day's roster, read inside the same transaction — so the plan that is written is the plan
 * that was read. `store.ts`'s own `dayDataSource` reads through a second connection, which is
 * right for a page render and wrong here. Same `DATABASE_URL` decision, so a server with no
 * database still answers from the synthetic day.
 */
function defaultSource(tx: Exec, siteId: string): DayDataSource {
  return hasNoDatabase() ? demoDaySource() : sqlDaySource(tx, siteId);
}
