/**
 * The plan board's three tables, read and written (migration 0009; redesign spec §1.6).
 *
 * This is what replaced #58's `modules/demo/plan-store.ts`, a `Map` in one serverless instance's
 * memory: a plan saved on one instance could not be read from another and a redeploy forgot
 * every plan, so "Save, then reload in another browser" — §1.7 #3, the acceptance that proves a
 * plan is really kept — could not pass. Now a save is a row, and the reload reads it back.
 *
 * Three decisions worth knowing:
 *
 *  - **One transaction per save, with the version in the WHERE clause.** `plan_run.version` is the
 *    ops audit version and the optimistic lock: the update only lands if the board was showing
 *    the version it is overwriting, so a second coordinator saving over the first gets a conflict
 *    naming them rather than silently winning. The assignments are deleted and re-inserted inside
 *    the same transaction, so a board is never half one plan and half another.
 *  - **Ids at the boundary.** The domain speaks `ops.child_profile.child_token` and
 *    `ops.vehicle.id` (src/domain/plan/board.ts), which is exactly what these rows hold, so there
 *    is no translation in here to get wrong.
 *  - **Who did it is a user id, not a name.** The rows store `set_by` / `saved_by`, and the words
 *    a screen shows come from `staffLabel` (src/modules/plan/staff.ts, over the frame's one name helper). A session with no user —
 *    the browser check's synthetic role — writes null and the screen says "Ramp staff", which is
 *    true, rather than inventing a person.
 *
 * Every statement is parameterised and site-scoped. Nothing here decides *whether* a caller may
 * write: that is the access table's answer, taken by the route before it gets this far.
 */
import { uuidv7 } from "uuidv7";
import { staffLabel } from "./staff";
import type { Db, Exec } from "@/db/exec";
import type { Placement } from "@/domain/plan/board";
import type { SetupRow, SetupState } from "@/domain/plan/setup";
import type { Direction } from "@/domain/day/leg";
import type {
  DayContext,
  PlanStore,
  PutSetupInput,
  SavePlanInput,
  SavePlanOutcome,
  SavedPlan,
} from "./types";

/** Written to `created_by` / `updated_by`: the surface that wrote the row, never a person's name. */
const BY = "plan-board";

type SetupDbRow = {
  vehicle_id: string;
  service_date: string;
  seats: number;
  wheelchair_spots: number;
  car_seats: number;
  oxygen_mounts: number;
  has_lift: boolean;
  state: SetupState;
  set_by: string | null;
  set_at: string | null;
};

function toSetupRow(row: SetupDbRow): SetupRow {
  return {
    vehicleId: row.vehicle_id,
    serviceDate: row.service_date,
    setup: {
      // `smallint` comes back as a number from both drivers; `Number` keeps a string-typed
      // driver (PGlite's numeric handling) from making "4" a count that fails every comparison.
      seats: Number(row.seats),
      wheelchairSpots: Number(row.wheelchair_spots),
      carSeats: Number(row.car_seats),
      oxygenMounts: Number(row.oxygen_mounts),
      hasLift: row.has_lift,
    },
    state: row.state,
    setBy: staffLabel(row.set_by),
    setAt: row.set_at,
  };
}

export function sqlPlanStore(db: Db): PlanStore {
  return {
    async setupRows(siteId, date, vehicleIds) {
      if (vehicleIds.length === 0) return [];
      const r = await db.query<SetupDbRow>(
        `SELECT vehicle_id, service_date::text AS service_date, seats, wheelchair_spots, car_seats,
                oxygen_mounts, has_lift, state, set_by::text AS set_by, set_at::text AS set_at
           FROM ops.vehicle_setup_day
          WHERE site_id = $1 AND service_date <= $2::date AND vehicle_id = ANY($3::uuid[])
          ORDER BY service_date DESC`,
        [siteId, date, vehicleIds],
      );
      return r.rows.map(toSetupRow);
    },

    async putSetup(siteId, input: PutSetupInput) {
      await db.query(
        `INSERT INTO ops.vehicle_setup_day
           (id, site_id, vehicle_id, service_date, seats, wheelchair_spots, car_seats, oxygen_mounts,
            has_lift, state, set_by, set_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         ON CONFLICT (vehicle_id, service_date) DO UPDATE SET
           seats = EXCLUDED.seats, wheelchair_spots = EXCLUDED.wheelchair_spots,
           car_seats = EXCLUDED.car_seats, oxygen_mounts = EXCLUDED.oxygen_mounts,
           has_lift = EXCLUDED.has_lift, state = EXCLUDED.state,
           set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at,
           updated_at = now(), updated_by = EXCLUDED.updated_by,
           version = ops.vehicle_setup_day.version + 1`,
        [
          uuidv7(), siteId, input.vehicleId, input.date,
          input.setup.seats, input.setup.wheelchairSpots, input.setup.carSeats,
          input.setup.oxygenMounts, input.setup.hasLift, input.state,
          input.setBy, input.now.toISOString(), BY,
        ],
      );
    },

    async loadPlan(siteId, date, direction) {
      return loadPlanWith(db, siteId, date, direction);
    },

    async savePlan(siteId, input) {
      return db.tx(async (tx) => savePlanIn(tx, siteId, input));
    },

    async dayContext(siteId, date) {
      const started = await db.query<{ d: string | null }>(
        `SELECT ((c.anchor_scenario AT TIME ZONE s.timezone)::date)::text AS d
           FROM ops.scenario_clock c JOIN ops.site s ON s.id = c.site_id
          WHERE c.site_id = $1`,
        [siteId],
      );
      // A van is "out" once it has reported a position on this service date. The live map owns
      // what that position means; this only counts how many vans have sent one (§9.4's `vansOut`).
      const out = await db.query<{ n: number }>(
        `SELECT count(DISTINCT t.vehicle_id)::int AS n
           FROM ops.telemetry_point t JOIN ops.site s ON s.id = t.site_id
          WHERE t.site_id = $1 AND t.vehicle_id IS NOT NULL
            AND (t.recorded_at AT TIME ZONE s.timezone)::date = $2::date`,
        [siteId, date],
      );
      const waiting = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ops.approval_request
          WHERE site_id = $1 AND decided_at IS NULL`,
        [siteId],
      );
      return {
        // Nothing reads `ops.attendance_exception` here any more (Veri F5, 2026-10-17): being
        // away on a leg is a placement on that leg's plan (`plan_assignment.bucket = 'ABSENT'`)
        // and the board is the only thing that writes it. A second source of "who is away" is
        // a second answer, and the one in the plan is the one every screen shows.
        startedDate: started.rows[0]?.d ?? null,
        vansOut: Number(out.rows[0]?.n ?? 0),
        approvalsWaiting: Number(waiting.rows[0]?.n ?? 0),
      } satisfies DayContext;
    },
  };
}

type RunRow = { id: string; version: number; saved_at: string; saved_by: string | null };

async function loadPlanWith(
  exec: Exec,
  siteId: string,
  date: string,
  direction: Direction,
): Promise<SavedPlan | null> {
  const run = await exec.query<RunRow>(
    `SELECT id::text AS id, version, saved_at::text AS saved_at, saved_by::text AS saved_by
       FROM ops.plan_run
      WHERE site_id = $1 AND service_date = $2::date AND direction = $3`,
    [siteId, date, direction],
  );
  const row = run.rows[0];
  if (!row) return null;
  const rows = await exec.query<{
    child_token: string;
    vehicle_id: string | null;
    bucket: Placement["bucket"];
    pinned: boolean;
  }>(
    `SELECT child_token::text AS child_token, vehicle_id::text AS vehicle_id, bucket, pinned
       FROM ops.plan_assignment WHERE plan_run_id = $1 ORDER BY stop_seq NULLS LAST`,
    [row.id],
  );
  const placements: Record<string, Placement> = {};
  for (const r of rows.rows) {
    placements[r.child_token] = { bucket: r.bucket, vanId: r.vehicle_id, pinned: r.pinned };
  }
  return {
    version: Number(row.version),
    savedAt: new Date(row.saved_at).toISOString(),
    savedBy: staffLabel(row.saved_by),
    placements,
  };
}

/**
 * One save, inside one transaction.
 *
 * The three cases are the three answers §1.6 asks for, and the order matters: the row is locked
 * first, so two saves arriving together are serialised by the database rather than by luck.
 *  - no row yet → insert at version 1, which is also what a board that started empty asks for;
 *  - a row at the version the board was showing → update to version + 1 and rewrite the children;
 *  - a row at any other version → conflict, with whoever saved it named.
 */
async function savePlanIn(
  tx: Exec,
  siteId: string,
  input: SavePlanInput,
): Promise<SavePlanOutcome> {
  const existing = await tx.query<RunRow>(
    `SELECT id::text AS id, version, saved_at::text AS saved_at, saved_by::text AS saved_by
       FROM ops.plan_run
      WHERE site_id = $1 AND service_date = $2::date AND direction = $3
      FOR UPDATE`,
    [siteId, input.date, input.direction],
  );
  const row = existing.rows[0];
  const savedAt = input.now.toISOString();

  if (row && Number(row.version) !== input.version) {
    return {
      ok: false,
      conflict: true,
      changedBy: staffLabel(row.saved_by),
      version: Number(row.version),
    };
  }

  let runId: string;
  let version: number;
  if (row) {
    runId = row.id;
    version = Number(row.version) + 1;
    await tx.query(
      `UPDATE ops.plan_run
          SET version = $2, saved_at = $3, saved_by = $4, updated_at = now(), updated_by = $5
        WHERE id = $1`,
      [runId, version, savedAt, input.savedBy, BY],
    );
    await tx.query(`DELETE FROM ops.plan_assignment WHERE plan_run_id = $1`, [runId]);
  } else {
    runId = uuidv7();
    version = 1;
    await tx.query(
      `INSERT INTO ops.plan_run
         (id, site_id, service_date, direction, saved_by, saved_at, version, created_by, updated_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $8)`,
      [runId, siteId, input.date, input.direction, input.savedBy, savedAt, version, BY],
    );
  }

  const entries = Object.entries(input.placements);
  if (entries.length > 0) {
    // One statement for the whole board: 28 children is one round trip, and a plan is one write.
    const values: unknown[] = [];
    const tuples = entries.map(([token, placement], i) => {
      values.push(
        runId, siteId, token, placement.vanId, placement.bucket,
        placement.stopSeq ?? null, placement.pinned, BY,
      );
      const at = i * 8;
      return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7}, $${at + 8}, $${at + 8})`;
    });
    await tx.query(
      `INSERT INTO ops.plan_assignment
         (plan_run_id, site_id, child_token, vehicle_id, bucket, stop_seq, pinned, created_by, updated_by)
       VALUES ${tuples.join(",")}`,
      values,
    );
  }
  return { ok: true, version, savedAt };
}
