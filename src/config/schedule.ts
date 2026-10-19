/**
 * WHEN THE VANS LEAVE (ledger #76).
 *
 * One default per leg: the time every van pulls away from the centre unless a planner changed it
 * for today on the board (saved with that day's plan, `plan_run.departures`). Every child's
 * estimated pickup and drop-off is computed forward from it (`domain/plan/arrivals.ts`), so this is
 * the one number to change when a centre's day starts or ends at a different time.
 *
 * Site-local wall clock, 24-hour "HH:MM".
 */
export const serviceSchedule = {
  departs: { AM: "06:20", PM: "15:15" },
} as const;
