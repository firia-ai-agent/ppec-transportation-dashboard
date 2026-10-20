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
/*
 * `DAY_VANS` is main's (#73: exactly three vans, declared rather than filtered), and `Exec` is
 * ours (S1-3: this file is all reads, so the approval transaction can use it as its own day
 * source — `boardPlacementPort({ source: (tx, siteId) => sqlDaySource(tx, siteId) })`). Taking
 * main's `Db` here would make the plan write inside the approval tx unwireable; the two changes
 * are independent and both are kept.
 */
import { ABOARD } from "@/domain/machines";
import { DAY_VANS, defaultSetupOf, vanColourToken, vanNameOf } from "@/config/vans";
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import type { DayDataSource, DayRider, DayVan, OtherChild } from "@/domain/day/source";
import { needsFromCategories } from "@/domain/plan/needs";
import { driverFor } from "@/domain/plan/day";
import { siteHhmm } from "@/modules/plan/leg-write";
import { approvedSlots } from "@/modules/availability/store";
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

/**
 * Takes an `Exec` and not a `Db`: every statement here is a read, so it works just as well inside
 * a transaction a caller has opened as on its own — which is what lets the approvals path read the
 * day and write the plan in one transaction (`modules/approvals/plan-placement-port.ts`).
 */
export function sqlDaySource(db: Exec, siteId: string): DayDataSource {
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

  /**
   * This day's own drop-off times, by child, where the leg carries one.
   *
   * Read through the plan module's own site-clock helper rather than `to_char(… AT TIME ZONE …)`:
   * the instant was written by `siteInstantOn` and is read back by `siteHhmm`, so the same `Intl`
   * zone data answers both and a DST hour cannot appear between the write and the read.
   */
  async function legsOf(date: string, leg: Direction): Promise<{ windows: Map<string, string>; aboard: Set<string> }> {
    const rows = await db.query<{ child_token: string; window_start: Date | string | null; state: string }>(
      `SELECT child_token::text AS child_token, window_start, state::text AS state
         FROM ops.trip_leg
        WHERE site_id = $1 AND service_date = $2 AND direction = $3`,
      [siteId, date, leg],
    );
    const windows = new Map<string, string>();
    const aboard = new Set<string>();
    for (const row of rows.rows) {
      if ((ABOARD as readonly string[]).includes(row.state)) aboard.add(row.child_token);
      if (row.window_start === null) continue;
      const at = new Date(row.window_start);
      if (!Number.isNaN(at.getTime())) windows.set(row.child_token, siteHhmm(at));
    }
    return { windows, aboard };
  }

  /** Does the centre drive this child on this leg? A family's own ride is not ours to plan. */
  const drivenBy = (row: ChildRow, leg: Direction): boolean => {
    const mode = leg === "AM" ? row.am_mode : row.pm_mode;
    return mode !== null && mode !== "FAMILY" && row.stop_label !== null;
  };

  return {
    within: (tx) => sqlDaySource(tx, siteId),

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

    async riders(date, leg) {
      const { children, needs } = await roster();
      const { windows: legWindows, aboard } = await legsOf(date, leg);
      const slots = await approvedSlots(db, { siteId, serviceDate: date, direction: leg });
      return children
        .filter((row) => drivenBy(row, leg))
        .map(
          (row): DayRider => ({
            token: row.child_token,
            name: row.display_name,
            needs: needsFromCategories(needs.get(row.child_token) ?? []),
            stopLabel: row.stop_label ?? "",
            /*
             * THE LEG'S OWN TIME FIRST, then the schedule's (Firia, 11:11 AM ET 2026-10-18).
             *
             * `attendance_plan.am_window_start` / `pm_window_start` are the *schedule*: the time
             * this child is usually driven, Mon–Fri. `ops.trip_leg.window_start` is this day's,
             * and it is what an approved drop-off change writes (`modules/plan/leg-write.ts`), so
             * a rider card that read only the schedule would show the old time on the one screen
             * a coordinator opens next. The seed writes both from the same fixture window, so for
             * a day nobody has changed the two agree and this prefers an identical value.
             */
            window:
              legWindows.get(row.child_token) ??
              (leg === "AM" ? row.am_window_start : row.pm_window_start) ??
              "",
            ...(aboard.has(row.child_token) ? { aboard: true } : {}),
            ...(slots.has(row.child_token) ? { slots: slots.get(row.child_token) } : {}),
          }),
        );
    },

    async others(_date, leg) {
      const { children, needs } = await roster();
      return children
        .filter((row) => !drivenBy(row, leg))
        .map(
          (row): OtherChild => ({
            token: row.child_token,
            name: row.display_name,
            // The same approved-needs read a rider gets, because the board asks the same fit
            // question of them: the Family drives lane is full cards and one of them can be
            // put in a van (Firia, 2026-10-18).
            needs: needsFromCategories(needs.get(row.child_token) ?? []),
            // No kerb of ours on this leg, which is what made them an "other".
            stopLabel: "",
            window: "",
            // Where a child starts when the plan says nothing. Away is a placement, never a
            // fact read off the roster.
            bucket: "FAMILY_DRIVES",
          }),
        );
    },
  };
}
