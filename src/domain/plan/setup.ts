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
  return defaultResolved(vehicleKey);
}

/** The second rung, written once: no row for today means this van's configured defaults. */
function defaultResolved(vehicleKey: string): ResolvedSetup {
  return { setup: defaultSetupOf(vehicleKey), state: "DEFAULT", source: "DEFAULT" };
}

/* ─────────────── the whole day's vans, which is what a screen actually asks for ─────────────── */

/** Every van's counts for one date, by vehicle key. The shape both views are handed. */
export type VanSetups = Readonly<Record<string, ResolvedSetup>>;

/** A van as this resolution identifies it: the config's key, and the row's own id. */
export type SetupVan = { vehicleKey: string; vehicleId: string };

/**
 * **THE SINGLE SOURCE OF EACH VAN'S SETUP FOR A DATE** — the one function both screens read.
 *
 * SOURCE: Firia's S1 of 2026-10-18 — the board let a coordinator put six children and a
 * wheelchair in a van while Today, checking the same van against the seeded seating layouts in
 * src/modules/demo/fixtures/standard.ts, said that van holds one chair and three seats. Two
 * screens, two capacity sources, two answers about one van.
 *
 * So there is one: today's `CHECKED` row for that van, else its configured default, per van, for
 * every van of the day at once. The plan board reads it through `loadBoard`
 * (src/modules/plan/store.ts) and Today reads it through `savedSetupsForBoard` into `buildBoard`
 * (src/domain/board/board.ts) — the same two rungs, the same rows, the same arithmetic in
 * src/domain/plan/fit.ts. **Neither screen reads a layout for capacity.**
 *
 * `rows` is whatever the store found for these vans on any date; each van takes its own, and the
 * date and state rules are `resolveSetup`'s, so there is still exactly one place that decides
 * what a confirmation is and what its absence means.
 *
 * Pure: the rows come from the server page or the loader (src/modules/plan/store.ts).
 */
export function resolveSetups(
  vans: readonly SetupVan[],
  date: string,
  rows: readonly SetupRow[],
): VanSetups {
  return Object.fromEntries(
    vans.map((van) => [
      van.vehicleKey,
      resolveSetup(
        van.vehicleKey,
        date,
        rows.filter((row) => row.vehicleId === van.vehicleId),
      ),
    ]),
  );
}

/**
 * One van out of that answer — and the configured default for a van the caller was handed nothing
 * about, which is the same rung `resolveSetup` lands on when there is no row.
 *
 * That case is a real one and not a defence: a page with no centre behind the session reads no
 * rows at all (every browser check), and a van nobody has counted is on its defaults whether the
 * day was read or not.
 */
export function setupFor(setups: VanSetups, vehicleKey: string): ResolvedSetup {
  return setups[vehicleKey] ?? defaultResolved(vehicleKey);
}
