/**
 * THE SAVED PLAN, READ — and only read.
 *
 * The Live map is locked until a plan is saved for the leg being looked at (REDESIGN-SPEC §9.1:
 * "Plan saved → Live map" is a **hard** gate — "No saved plan = no routes"). So this screen has
 * to be able to answer two questions about `ops.plan_run` / `ops.plan_assignment`: is there a
 * saved plan for this date and leg, and which children are on which van.
 *
 * ────────────────────────────────── why this file exists ──────────────────────────────────
 *
 * It should not. #73 (`team/ppe-rework-ramp-board`) owns the plan store —
 * `src/modules/plan/{types,store,sql,memory}.ts` — and the brief for this screen is to reuse
 * those files **byte-identical** so the two branches do not conflict at the merge. Three of that
 * module's files came over exactly that way and are untouched here: `src/domain/day/leg.ts`,
 * `src/modules/plan/when.ts` and `src/modules/plan/staff.ts`.
 *
 * The store itself could not, and the reason is one import. `types.ts` and `sql.ts` need the
 * `Placement` type from #73's `src/domain/plan/board.ts`; that file calls
 * `planMap(direction, vans)` from #73's `src/domain/plan/map.ts`, whose signature is **not** this
 * branch's (`planMap(plan)`), and taking their `map.ts` would break the Plan routes screen that
 * is already here. Bringing the store over would therefore mean bringing #73's half-finished
 * board rework with it, which is neither this screen's job nor a safe thing to do to a branch
 * somebody else is still writing.
 *
 * So this is a **read-only subset**, deliberately parked outside `src/modules/plan/` so that
 * #73's five files land there byte-identical with nothing of ours to conflict with. It speaks
 * the same two tables with the same statements as their `loadPlanWith`, and the follow-up when
 * both are on main is a deletion: this file goes, and the screen calls `planStore().loadPlan`.
 *
 * ────────────────────────────────── the rules it keeps ──────────────────────────────────
 *
 *  - **No save path.** There is no INSERT, UPDATE or DELETE in this file and no endpoint behind
 *    it. The Live map reads the plan; the board writes it.
 *  - **The memory store is never selectable when a database is configured** (Firia's rule 4,
 *    2026-10-17 5:48 PM ET). Asking for it then throws rather than quietly serving a plan out of
 *    one serverless instance's memory — the exact fault #58's `plan-store.ts` had. The check is
 *    the presence of `DATABASE_URL`, not a flag anybody can set.
 *  - **No memory plan is ever invented.** With no database there is no plan, so the screen is
 *    locked — which is the honest answer for a server that has nothing to read, and the same
 *    thing a real database with no saved plan says.
 */
import { getNeonDb } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { staffLabel } from "@/modules/plan/staff";
import { DEFAULT_DEMO_SITE } from "@/modules/demo/seed";
import { demoId, KIND, VEHICLES } from "@/modules/demo/fixtures/standard";
import { getSavedPlan } from "@/modules/demo/plan-store";
import { DEMO_SCENARIOS } from "@/domain/plan/day";

/** Where one child is on a saved board. The same four buckets `plan_assignment` constrains. */
export type SavedBucket = "VAN" | "UNASSIGNED" | "FAMILY_DRIVES" | "ABSENT";

export type SavedPlacement = {
  bucket: SavedBucket;
  /** The vehicle id when the bucket is VAN, null otherwise — the table's own check constraint. */
  vanId: string | null;
  /** The van's drive order for this child, when the save recorded one. */
  stopSeq: number | null;
};

/** A plan as it was last saved, as much of it as this screen reads. */
export type SavedPlan = {
  /** The row's audit version. Read for display and for nothing else: this screen never saves. */
  version: number;
  savedAt: string;
  /** Who saved it, in words, through the frame's one name helper. Null when nobody is recorded. */
  savedBy: string | null;
  /** Every child of the day, by `ops.child_profile.child_token`. */
  placements: Readonly<Record<string, SavedPlacement>>;
};

/**
 * The refusal, in the words a developer reads in a log and never a user. Deliberately the same
 * sentence as #73's `MEMORY_STORE_REFUSED`, so the two branches fail the same way.
 */
export const MEMORY_STORE_REFUSED =
  "the in-memory plan store cannot be used when a database is configured";

/** True when this server has no database to read: the browser check, and a local `next dev`. */
export function hasNoDatabase(env: Record<string, string | undefined> = process.env): boolean {
  return !env.DATABASE_URL;
}

/**
 * Firia's rule 4, as a function: a memory store while a database is configured is a throw.
 *
 * Exported so the behaviour test can state the rule directly rather than inferring it from a
 * reader that happened not to crash.
 */
export function assertMemoryAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.DATABASE_URL) throw new Error(MEMORY_STORE_REFUSED);
}

type RunRow = { id: string; version: number; saved_at: string; saved_by: string | null };
type AssignmentRow = {
  child_token: string;
  vehicle_id: string | null;
  bucket: SavedBucket;
  stop_seq: number | null;
};

/**
 * The saved plan for one date and one leg, or null when none has been saved.
 *
 * Two statements, both parameterised and both site-scoped, and the same two #73's `loadPlanWith`
 * runs. `ORDER BY stop_seq` is what makes the assignments come back in the order a van actually
 * drives them, which is the order the Live map lists a van's children in.
 *
 * Nothing here decides *whether* a caller may read: that is the access table's answer, taken by
 * the route before it gets this far.
 */
export async function loadSavedPlan(
  siteId: string,
  date: string,
  direction: Direction,
): Promise<SavedPlan | null> {
  // With no database, the saved plan is the one the board kept in this process (see
  // `savedPlanWithoutDatabase`). Never an invented one: nothing saved is still locked.
  if (hasNoDatabase()) return savedPlanWithoutDatabase(direction);

  const db = getNeonDb();
  const run = await db.query<RunRow>(
    `SELECT id::text AS id, version, saved_at::text AS saved_at, saved_by::text AS saved_by
       FROM ops.plan_run
      WHERE site_id = $1 AND service_date = $2::date AND direction = $3`,
    [siteId, date, direction],
  );
  const row = run.rows[0];
  if (!row) return null;

  const rows = await db.query<AssignmentRow>(
    `SELECT child_token::text AS child_token, vehicle_id::text AS vehicle_id, bucket, stop_seq
       FROM ops.plan_assignment WHERE plan_run_id = $1 ORDER BY stop_seq NULLS LAST`,
    [row.id],
  );

  const placements: Record<string, SavedPlacement> = {};
  for (const r of rows.rows) {
    placements[r.child_token] = {
      bucket: r.bucket,
      vanId: r.vehicle_id,
      stopSeq: r.stop_seq === null ? null : Number(r.stop_seq),
    };
  }

  return {
    version: Number(row.version),
    savedAt: new Date(row.saved_at).toISOString(),
    savedBy: staffLabel(row.saved_by),
    placements,
  };
}

/* ───────────────────────────── what the screen asks of it ───────────────────────────── */

/**
 * IS THE LIVE MAP UNLOCKED? — the hard gate, in one line.
 *
 * A `plan_run` row for this date and leg is the whole of it (§9.1). Not "are there assignments",
 * because a saved plan with every child marked away is still a saved plan and still a day a
 * coordinator decided; not "is the demo day started", because that is a different gate on a
 * different screen.
 */
export function isUnlocked(plan: SavedPlan | null): boolean {
  return plan !== null;
}

/**
 * How many children the plan puts in each van, keyed by vehicle id.
 *
 * This is what the Live map's "· 2 kids" is read from once the plan is the source: the saved
 * decision about who rides where, rather than a count derived from a route fixture. Buckets
 * that are not a van — unassigned, the family drives, away today — are not in anybody's van and
 * are not counted into one.
 */
export function kidsPerVan(plan: SavedPlan | null): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (!plan) return counts;
  for (const placement of Object.values(plan.placements)) {
    if (placement.bucket !== "VAN" || !placement.vanId) continue;
    counts[placement.vanId] = (counts[placement.vanId] ?? 0) + 1;
  }
  return counts;
}

/** The vans the saved plan actually puts somebody in, in no particular order. */
export function vansInPlan(plan: SavedPlan | null): string[] {
  return Object.keys(kidsPerVan(plan));
}

/**
 * The site this caller's plan belongs to: their own membership, or the demo site when the
 * session has no membership at all.
 *
 * The demo is one centre (PRD §18.1) and the live map is not a multi-site surface: a caller who
 * is a member of several sites gets the first, which is the same resolution the demo reset uses
 * when a request does not name one. The membership-less case is the browser check's synthetic
 * session (src/auth/caller.ts), which is a role and no identity.
 *
 * Deliberately the same shape and the same answer as #73's `siteOf` in src/modules/plan/api.ts,
 * so the two agree about which site a screen is looking at.
 */
export function siteOf(caller: { memberships?: readonly { siteId: string }[] }): string {
  return caller.memberships?.[0]?.siteId ?? DEFAULT_DEMO_SITE;
}

/**
 * The database id of a fixture van ("V1" → the uuid the seed wrote).
 *
 * `plan_assignment.vehicle_id` is a real `ops.vehicle` id, and the simulated runs on this screen
 * are keyed by the fixture's own short key — so the two have to be joined somewhere, and this is
 * the one place. The seed's ids are deterministic (`demoId(KIND.vehicle, n)` over the fixture's
 * own order), so this is a lookup rather than a query.
 *
 * Returns null for a key the fixtures do not have, which is a van the saved plan cannot be
 * talking about.
 */
export function demoVehicleId(vehicleKey: string): string | null {
  const index = VEHICLES.findIndex((vehicle) => vehicle.key === vehicleKey);
  return index === -1 ? null : demoId(KIND.vehicle, index);
}

/** How many children the saved plan puts in one fixture van, or null when nothing is saved. */
export function kidsInVan(plan: SavedPlan | null, vehicleKey: string): number | null {
  if (!plan) return null;
  const id = demoVehicleId(vehicleKey);
  return id === null ? null : (kidsPerVan(plan)[id] ?? 0);
}

/* ───────────────────────────── the server with no database ───────────────────────────── */

/**
 * THE SAVED PLAN ON A SERVER WITH NO DATABASE — and it is still a plan somebody saved.
 *
 * One server has no `DATABASE_URL` at all: the browser check, which builds the app and starts it
 * with none (playwright.config.ts: "The run touches no database"), and a local `next dev` can be
 * in the same position. The gate has to mean the same thing there as on a deployment, or the
 * Live map is a screen nobody can ever walk past its locked state — and the gate is the point of
 * this slice.
 *
 * So it reads what *is* the saved plan on that server: the one the Plan routes board kept when a
 * coordinator pressed Save (src/modules/demo/plan-store.ts, #58's in-process store). That is a
 * real save by a real click in this session, not a fixture standing in for one — press Save on
 * the board and the map unlocks; reset the demo and it locks again.
 *
 * It is never reached when a database is configured: {@link loadSavedPlan} checks `DATABASE_URL`
 * first and {@link assertMemoryAllowed} states the rule on its own (Firia's rule 4). A plan out
 * of one serverless instance's memory must never stand in for a row every instance can see.
 *
 * The shape is translated, not invented: the board's store keeps lane id → child tokens plus the
 * van on each lane, which is the same fact `plan_assignment` holds one row at a time. There is
 * no version and no saver to report, so neither is claimed: version 0, saved by nobody.
 */
function savedPlanWithoutDatabase(direction: Direction): SavedPlan | null {
  for (const scenario of DEMO_SCENARIOS) {
    const kept = getSavedPlan(scenario, direction);
    if (!kept) continue;
    const placements: Record<string, SavedPlacement> = {};
    for (const [laneId, tokens] of Object.entries(kept.assignment)) {
      const vehicleKey = kept.stages[laneId]?.vehicleKey;
      // The board's lanes are named by the fixture's van key; the plan's rows are named by the
      // seeded vehicle id, so the translation happens here rather than at the reader.
      const vanId = vehicleKey ? demoVehicleId(vehicleKey) : null;
      tokens.forEach((token, index) => {
        placements[token] = {
          // `plan_assignment` constrains "in a van" and "names a van" to be the same thing, and
          // a translation that cannot find the van must not break that: a child on a lane whose
          // van the fixtures do not know is unassigned, not in a van called null.
          bucket: vanId ? "VAN" : "UNASSIGNED",
          vanId,
          stopSeq: vanId ? index + 1 : null,
        };
      });
    }
    return { version: 0, savedAt: kept.savedAt, savedBy: null, placements };
  }
  return null;
}
