/**
 * The day's roster, out of the database: which children the centre drives on a leg, what each of
 * them needs, where they are picked up and which vans are on the road.
 *
 * SOURCE: Firia's 2026-10-17 7:18 PM ET correction — `src/domain/plan/needs.ts` read the demo
 * `CHILDREN` fixture, so the board's child panel could write a row and change nothing on screen.
 * The flags are rows now: one **APPROVED** `ops.transport_profile` per child (schema.ts:207-217)
 * and its **APPROVED** `ops.transport_need_item`s (:218-223), which is exactly what the panel
 * writes (src/modules/plan/needs-write.ts).
 *
 * Three rules this file keeps:
 *
 *  - **Approved only, twice over.** A profile that is not `APPROVED` and an item that is not
 *    `APPROVED` are both ignored (DECISION-LEDGER row 1, PRD VEH-01). A family's report is on the
 *    record and is not planned against.
 *  - **Nothing is read from `ops.attendance_day`.** Being away on a given leg is a placement on
 *    that day's plan (`plan_assignment.bucket = 'ABSENT'`), per date and per leg, and the board
 *    is the only thing that writes it (founder 7:17 PM ET).
 *  - **The fleet is the one shared config.** `src/config/vans.ts` owns the slot, the colour and
 *    the default counts; this only confirms the vehicle rows exist and are the centre's, so two
 *    screens cannot name one van two different things (Vera's differences list, item 1).
 *
 * Site-scoped and parameterised, like every other statement in this app.
 */
import { DAY_VANS, defaultSetupOf, vanColourToken, vanNameOf } from "@/config/vans";
import type { Db } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import type { DayDataSource, DayRider, DayVan, OtherChild } from "@/domain/day/source";
import { needsFromCategories } from "@/domain/plan/needs";
import { driverFor } from "@/domain/plan/day";
import { demoDaySource } from "@/modules/demo/day-source";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";

type ChildRow = {
  child_token: string;
  display_name: string;
  am_mode: string | null;
  pm_mode: string | null;
  am_window_start: string | null;
  pm_window_start: string | null;
  stop_label: string | null;
};

type NeedRow = { child_token: string; category: string };

/** The vans the shared config runs today, by id, in slot order (the reserve is not one). */
function configuredVans(): { id: string; key: string; slot: number }[] {
  return DAY_VANS.map((van) => ({
    id: vehicleIdOf(van.vehicleKey),
    key: van.vehicleKey,
    slot: van.slot,
  })).sort((a, b) => a.slot - b.slot);
}

export function sqlDaySource(db: Db, siteId: string): DayDataSource {
  /** The roster, once per call: one query for the children and one for their approved needs. */
  async function roster(): Promise<{ children: ChildRow[]; needs: Map<string, Set<string>> }> {
    const children = await db.query<ChildRow>(
      `SELECT c.child_token::text AS child_token, c.display_name,
              p.am_mode::text AS am_mode, p.pm_mode::text AS pm_mode,
              p.am_window_start, p.pm_window_start,
              s.label AS stop_label
         FROM ops.child_profile c
         LEFT JOIN ops.attendance_plan p
           ON p.child_token = c.child_token AND p.site_id = c.site_id
         LEFT JOIN ops.stop_location s
           ON s.child_token = c.child_token AND s.site_id = c.site_id AND s.is_center = false
        WHERE c.site_id = $1
        ORDER BY c.display_name`,
      [siteId],
    );
    const items = await db.query<NeedRow>(
      `SELECT tp.child_token::text AS child_token, ni.category
         FROM ops.transport_profile tp
         JOIN ops.transport_need_item ni ON ni.profile_id = tp.id
        WHERE tp.site_id = $1 AND tp.status = 'APPROVED' AND ni.state = 'APPROVED'`,
      [siteId],
    );
    const needs = new Map<string, Set<string>>();
    for (const row of items.rows) {
      const set = needs.get(row.child_token) ?? new Set<string>();
      set.add(row.category);
      needs.set(row.child_token, set);
    }
    return { children: children.rows, needs };
  }

  /** Does the centre drive this child on this leg? A family's own ride is not ours to plan. */
  const drivenBy = (row: ChildRow, leg: Direction): boolean => {
    const mode = leg === "AM" ? row.am_mode : row.pm_mode;
    return mode !== null && mode !== "FAMILY" && row.stop_label !== null;
  };

  return {
    async vans(_date) {
      const configured = configuredVans();
      const found = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM ops.vehicle WHERE site_id = $1 AND id = ANY($2::uuid[])`,
        [siteId, configured.map((van) => van.id)],
      );
      const present = new Set(found.rows.map((row) => row.id));
      return configured
        .filter((van) => present.has(van.id))
        .map(
          (van): DayVan => ({
            id: van.id,
            slot: van.slot,
            name: vanNameOf(van.slot),
            colourToken: vanColourToken(van.slot),
            driverName: driverFor(van.key),
            defaultSetup: defaultSetupOf(van.key),
          }),
        );
    },

    /**
     * When this van leaves the centre. The survey's own geometry is the demo's
     * (src/domain/board/scenario.ts) and is not in the database at all, so this is the one answer
     * the SQL source borrows from the synthetic day — noted here rather than hidden, because a
     * real centre's departure time would come from its own schedule.
     */
    leavesAtMs(date, leg, vanId) {
      return demoDaySource().leavesAtMs(date, leg, vanId);
    },

    async riders(_date, leg) {
      const { children, needs } = await roster();
      return children
        .filter((row) => drivenBy(row, leg))
        .map(
          (row): DayRider => ({
            token: row.child_token,
            name: row.display_name,
            needs: needsFromCategories(needs.get(row.child_token) ?? []),
            stopLabel: row.stop_label ?? "",
            window: (leg === "AM" ? row.am_window_start : row.pm_window_start) ?? "",
          }),
        );
    },

    async others(_date, leg) {
      const { children } = await roster();
      return children
        .filter((row) => !drivenBy(row, leg))
        .map(
          (row): OtherChild => ({
            token: row.child_token,
            name: row.display_name,
            // Where a child starts when the plan says nothing. Away is a placement, never a
            // fact read off the roster.
            bucket: "FAMILY_DRIVES",
          }),
        );
    },
  };
}
