/**
 * TRY IT, THEN TAKE IT BACK (ledger #80).
 *
 * Before the agent puts a change in front of a person it rehearses it: the very code Approve will
 * run, against the board as it stands, in a transaction that is always rolled back. Whatever the
 * board's writer would refuse — a van over its counts, a day not started, a van already gone, a
 * plan somebody just saved — it refuses now, in its own words, and no card is drafted on a promise
 * Approve cannot keep. Nothing here knows what those rules are; the writer does.
 *
 * Inside a transaction already open (a run's proposal writer) it is a savepoint; on a plain
 * connection it is a transaction of its own that never commits.
 */
import type { Db, Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import type { DayDataSource } from "@/domain/day/source";
import type { PlanStore } from "@/modules/plan/types";
import { applyPendingMoves } from "@/modules/plan/place";
import { loadBoard } from "@/modules/plan/store";
import type { WireMove } from "./plan-change";
import { refusalOf, type Refusal } from "./refusal";

class Rehearsed<T> {
  constructor(readonly value: T) {}
}

export async function rehearse<T>(exec: Exec | Db, work: (tx: Exec) => Promise<T>): Promise<T> {
  if ("tx" in exec && typeof exec.tx === "function") {
    try {
      await exec.tx(async (tx) => {
        throw new Rehearsed(await work(tx));
      });
    } catch (e) {
      if (e instanceof Rehearsed) return e.value as T;
      throw e;
    }
    throw new Error("rehearsal committed");
  }
  await exec.query("SAVEPOINT rehearsal", []);
  try {
    return await work(exec);
  } finally {
    await exec.query("ROLLBACK TO SAVEPOINT rehearsal", []);
    await exec.query("RELEASE SAVEPOINT rehearsal", []);
  }
}

/**
 * Would the board save this plan change now? The board's own Save (`applyPendingMoves`), rehearsed
 * on the rehearsal's own connection — never a store on another one, which would not roll back —
 * against the plan as it stands. `null` when it would; the writer's `Refusal` when it would not.
 */
export async function rehearsePlanSave(
  exec: Exec | Db,
  board: { readonly store: PlanStore; readonly source: DayDataSource },
  a: {
    readonly siteId: string;
    readonly date: string;
    readonly leg: Direction;
    readonly moves: readonly WireMove[];
    readonly departures?: Readonly<Record<string, string>>;
    readonly now: Date;
  },
): Promise<Refusal | null> {
  // The caller's own board, bound to the rehearsal: a store that cannot rehearse is not rehearsed.
  if (!board.store.within) return null;
  const within = board.store.within.bind(board.store);
  return rehearse(exec, async (tx) => {
    const store = within(tx);
    const source = board.source.within?.(tx) ?? board.source;
    const view = await loadBoard(store, a.siteId, a.date, a.leg, source);
    const saved = await applyPendingMoves(
      {
        siteId: a.siteId,
        serviceDate: a.date,
        direction: a.leg,
        moves: a.moves.map((m) => ({ childToken: m.child_token, bucket: m.bucket, vanId: m.van_id ?? null, ...(m.not_before ? { notBefore: m.not_before } : {}) })),
        departures: a.departures,
        expectedVersion: view.version,
        actor: null,
        now: a.now,
      },
      store,
      source,
    );
    return saved.ok ? null : refusalOf(saved, { date: a.date, leg: a.leg }, view);
  });
}
