/**
 * Which counts a van is planned on today.
 *
 * SOURCE: Firia/Veri's ruling of 2026-10-17 6:00 PM ET, which supersedes §1.6's "Default rule"
 * and conflict C5: an unconfirmed van — one with no `CHECKED` row for **this** date — is planned
 * on its DEFAULT counts from the shared config (src/config/vans.ts). There is **no carry-over**:
 * no "most recent CHECKED", no "yesterday", no "Tomorrow starts from this". #66's three-rung
 * ladder (`resolveSetup`, setup.ts:66-104) is deliberately not ported.
 *
 * So the whole rule is two lines, and the honesty is in saying which of them a plan stands on:
 * the column shows "Using default setup" until the front desk confirms the van at the ramp
 * (§9.1's soft prerequisite — planning is allowed, boarding still needs today's Confirm).
 *
 * `PLANNED` is **not** a state this code can produce. It stays in migration 0009's check
 * constraint, which is frozen, and nothing writes it: the board has no planned counts and the
 * endpoint refuses the value (src/modules/plan/api.ts, Firia's rule 1).
 *
 * Pure: no clock, no database, no network.
 */
import { defaultSetupOf } from "@/config/vans";
import type { VanSetup } from "./fit";

/** The two states the screens and the domain know (Vera's differences list, item 6). */
export const SETUP_STATES = ["DEFAULT", "CHECKED"] as const;
export type SetupState = (typeof SETUP_STATES)[number];

/** The only state a person can write. `DEFAULT` is what the absence of a row *means*. */
export const CONFIRMED_STATE: SetupState = "CHECKED";

/** One `ops.vehicle_setup_day` row, as the store hands it over. */
export type SetupRow = {
  vehicleId: string;
  /** "2026-10-17", the service date in centre time. */
  serviceDate: string;
  setup: VanSetup;
  state: SetupState;
  /**
   * Who set it, **in words** ("Ana P."), or null when nobody is recorded — which is the case for
   * the browser check's session, which has a role and no identity. The row itself holds a user
   * id; the store turns it into a name on the way out (src/modules/plan/staff.ts `staffLabel`),
   * because a screen may not print `display_name`: it carries the synthetic marker.
   */
  setBy: string | null;
  setAt: string | null;
};

/** Where today's counts came from. Two rungs, because there are two (6:00 PM ET ruling). */
export const SETUP_SOURCES = ["CHECKED", "DEFAULT"] as const;
export type SetupSource = (typeof SETUP_SOURCES)[number];

export type ResolvedSetup = {
  setup: VanSetup;
  state: SetupState;
  source: SetupSource;
  setBy?: string | null;
};

/**
 * Today's counts for one van: the row the front desk confirmed **today**, or the configured
 * defaults.
 *
 * `rows` is whatever the store found for this van; a row for another date is ignored rather than
 * carried forward, and a row that is not `CHECKED` is not a confirmation. Planning tomorrow is
 * not planning today, and yesterday's van is not today's van.
 */
export function resolveSetup(
  vehicleKey: string,
  date: string,
  rows: readonly SetupRow[],
): ResolvedSetup {
  const confirmed = rows.find((row) => row.serviceDate === date && row.state === "CHECKED");
  if (confirmed) {
    return {
      setup: confirmed.setup,
      state: "CHECKED",
      source: "CHECKED",
      setBy: confirmed.setBy,
    };
  }
  return { setup: defaultSetupOf(vehicleKey), state: "DEFAULT", source: "DEFAULT" };
}
