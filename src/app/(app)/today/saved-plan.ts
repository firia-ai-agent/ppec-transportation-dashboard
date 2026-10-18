/**
 * TODAY READS THE SAVED PLAN — the read, and the one translation it needs.
 *
 * SOURCE: Firia's signed rule of 2026-10-17 6:02 PM ET ("Today, Live map and Health read the
 * saved plan") and the S1 ruling of 2026-10-18 4:45 AM ET. Veri's prod check found Today's
 * morning van column disagreeing with the board a director had just saved for five of nine
 * children: the board's rows are computed from the demo scenario (src/domain/board/board.ts),
 * and the scenario's own runs are not the plan anybody saved.
 *
 * **One read path.** The plan is read through `loadBoard` (src/modules/plan/store.ts) — the same
 * function the Plan routes page calls, with the same store, the same day-data source and the
 * same `siteOf` rule — so Today cannot see a different plan from the screen the plan was saved
 * on. There is no second store, no second statement and no copy of the live map's reader here;
 * when that reader is deleted (src/modules/live-map/plan-read.ts says so itself) this path is
 * unaffected.
 *
 * **One formula for the ids.** A saved plan is rows keyed by `ops.child_profile.child_token` and
 * `ops.vehicle.id`; the board is a projection over fixture keys. The two are joined by the
 * fixtures' own deterministic formula and its inverse (`childKeyOfToken`, `vehicleKeyOfId` in
 * src/modules/demo/fixtures/standard.ts, which is what src/modules/demo/seed.ts inserts those
 * ids with). A second, home-made formula is what showed every van the next van's children (Veri
 * S1, 2026-10-18 3:03 AM ET), so there is not one.
 *
 * **It never throws at the page.** A session with no site, a server with no database, a query
 * that raises — all three land on "nothing saved", which is the seeded day the board has always
 * shown. That is the same way the step strip above the board treats an unreadable day
 * (src/domain/day/day-facts.ts §9.4), and it is what keeps the browser checks deterministic:
 * the Playwright run has no database at all, so it takes that path every time.
 */
import type { SavedBoardPlan, SavedLegPlan, SavedSpot } from "@/domain/board/board";
import type { Direction } from "@/domain/day/leg";
import type { BoardPlan } from "@/domain/plan/board";
import { childKeyOfToken, vehicleKeyOfId } from "@/modules/demo/fixtures/standard";
import { dayDataSource, loadBoard, planStore, type PlanStore } from "@/modules/plan/store";
import type { DayDataSource } from "@/domain/day/source";

/** The two legs of a day, each saved on its own: a saved morning says nothing about the afternoon. */
const LEGS: readonly Direction[] = ["AM", "PM"];

/**
 * A saved plan, in the board's own vocabulary.
 *
 * `loadBoard` has already read the plan onto today's roster — a child the day no longer has is
 * dropped and a child in a van the day no longer runs is back in Unassigned (`planFrom`) — so
 * this is a translation and not a second set of rules. A token or a vehicle id this scenario
 * does not have is skipped and becomes no van rather than a guess: the board can only draw a
 * child and a van it has.
 */
export function savedSpotsFrom(plan: BoardPlan): SavedLegPlan {
  const spots: Record<string, SavedSpot> = {};
  for (const [token, placement] of Object.entries(plan)) {
    const childKey = childKeyOfToken(token);
    if (childKey === null) continue;
    if (placement.bucket !== "VAN") {
      spots[childKey] = { bucket: placement.bucket };
      continue;
    }
    const vehicleKey = placement.vanId === null ? null : vehicleKeyOfId(placement.vanId);
    spots[childKey] =
      vehicleKey === null ? { bucket: "UNASSIGNED" } : { bucket: "VAN", vehicleKey };
  }
  return spots;
}

/**
 * The plan saved for this site and date, leg by leg, as `buildBoard` takes it.
 *
 * A leg with no saved plan (`version === 0`) is left out, which is how the board goes on showing
 * the seeded runs for the half of the day nobody has planned yet. The store and the day source
 * are arguments so a test can hand this the memory store and the synthetic day, exactly as the
 * plan module's own writers take them (src/modules/plan/place.ts).
 */
export async function savedPlanFor(
  siteId: string | null,
  date: string,
  store?: PlanStore,
  source?: DayDataSource,
): Promise<SavedBoardPlan> {
  if (!siteId) return {};
  try {
    const reads = store ?? planStore();
    const day = source ?? dayDataSource(siteId);
    const saved: { -readonly [D in Direction]?: SavedLegPlan } = {};
    for (const leg of LEGS) {
      const view = await loadBoard(reads, siteId, date, leg, day);
      if (view.version === 0) continue;
      saved[leg] = savedSpotsFrom(view.plan);
    }
    return saved;
  } catch {
    // §9.4 again: a day this request cannot read is the day the scenario describes, not a 500.
    return {};
  }
}
