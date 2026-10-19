/**
 * The same store over this process's memory, for the one case that has no database: the browser
 * check.
 *
 * `pnpm e2e` builds the app and starts it with no `DATABASE_URL` at all (playwright.config.ts:
 * "The run touches no database"), and a local `next dev` can be in the same position. The plan
 * board is a screen about rows, so on that server it would have nothing to read and nothing to
 * save — and the clickable path the demo is gated on (drag, Auto-plan, Save, reload) could not be
 * walked at all.
 *
 * **It fails closed** (Firia's rule 4, 2026-10-17 5:48 PM ET). Asking for this store while a
 * database URL is configured throws, rather than quietly serving a plan out of one serverless
 * instance's memory: that is the exact fault #58's `modules/demo/plan-store.ts` had, and on
 * production or a preview — which share one Neon database — a plan kept here would be invisible
 * to the next request and lost on redeploy. There is no flag that overrides this; the check is
 * the presence of the URL.
 *
 * It starts empty: no setup row for today, so every van reads its shared-config defaults and the
 * board says "Using default setup" until the front desk confirms one (the §9 reset contract and
 * the 6:00 PM ET ruling, same as on a real database). What it cannot prove is that the SQL is
 * right. That is proved directly instead, by running the real statements against the real
 * migrations (src/modules/plan/sql.test.ts).
 */
import { staffLabel } from "./staff";
import type { SetupRow } from "@/domain/plan/setup";
import type { Direction } from "@/domain/day/leg";
import type { PlanStore, SavedPlan, SavePlanInput, SavePlanOutcome } from "./types";

type Key = string;
const planKey = (date: string, direction: Direction): Key => `${date}/${direction}`;

type State = { setups: SetupRow[]; plans: Map<Key, SavedPlan> };

/**
 * The state hangs off `globalThis`, and that is not a shortcut.
 *
 * Next bundles a server component and a route handler separately, so a module-level `const` is
 * **not** one object between them: the board's page would read its own copy and the save endpoint
 * would write another, and a save would vanish on the next render — which is exactly the fault
 * this fallback is standing in for. One well-known key, so both bundles reach the same object.
 *
 * It is still one process's memory, which is why no deployment uses this path (store.ts).
 */
const KEY = "__ppecPlanBoardMemoryStore";
type Holder = typeof globalThis & { [KEY]?: State };

function state(): State {
  const holder = globalThis as Holder;
  holder[KEY] ??= { setups: [], plans: new Map() };
  return holder[KEY];
}

/** Forget everything. Used by the demo reset and by tests that want a fresh process. */
export function clearMemoryPlanStore(): void {
  state().setups = [];
  state().plans.clear();
}

/** The refusal, in the words a developer reads in a log and never a user. */
export const MEMORY_STORE_REFUSED =
  "the in-memory plan store cannot be used when a database is configured";

/**
 * The memory store, or a throw.
 *
 * `env` is passed in so the rule is testable without touching the process's own environment; the
 * default is the process's, which is what every caller actually uses.
 */
export function memoryPlanStore(env: Record<string, string | undefined> = process.env): PlanStore {
  if (env.DATABASE_URL) throw new Error(MEMORY_STORE_REFUSED);
  // …and on a deployment that has *lost* its URL, which is the other half of "fails closed in
  // prod and previews" (signed data model, edit 4; Veri F6): a production or preview server
  // serving a plan out of one instance's memory would look like it was working.
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") {
    throw new Error(MEMORY_STORE_REFUSED);
  }
  return {
    async setupRows(_siteId, date, vehicleIds) {
      return state().setups
        .filter((row) => vehicleIds.includes(row.vehicleId) && row.serviceDate <= date)
        .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
    },

    async putSetup(_siteId, input) {
      const row: SetupRow = {
        vehicleId: input.vehicleId,
        serviceDate: input.date,
        setup: input.setup,
        state: input.state,
        // The words, like the SQL store's read does: `SetupRow.setBy` is a name, not an id.
        setBy: staffLabel(input.setBy),
        setAt: input.now.toISOString(),
      };
      state().setups = [
        ...state().setups.filter(
          (r) => !(r.vehicleId === row.vehicleId && r.serviceDate === row.serviceDate),
        ),
        row,
      ];
    },

    async loadPlan(_siteId, date, direction) {
      return state().plans.get(planKey(date, direction)) ?? null;
    },

    async savePlan(_siteId, input: SavePlanInput): Promise<SavePlanOutcome> {
      const key = planKey(input.date, input.direction);
      const existing = state().plans.get(key);
      if (existing && existing.version !== input.version) {
        return {
          ok: false,
          conflict: true,
          changedBy: existing.savedBy,
          version: existing.version,
        };
      }
      const saved: SavedPlan = {
        version: (existing?.version ?? 0) + 1,
        savedAt: input.now.toISOString(),
        savedBy: staffLabel(input.savedBy),
        // Only the three columns a read returns, exactly like the SQL store's own read: the stop
        // number is written down for other readers and is derived again from the day's windows
        // when this board is drawn, so handing it back here would be the one difference between
        // the two stores a screen could notice.
        placements: Object.fromEntries(
          Object.entries(input.placements).map(([token, { bucket, vanId, pinned }]) => [
            token,
            { bucket, vanId, pinned },
          ]),
        ),
        departures: { ...(existing?.departures ?? {}), ...(input.departures ?? {}) },
      };
      state().plans.set(key, saved);
      return { ok: true, version: saved.version, savedAt: saved.savedAt };
    },

    async dayContext(_siteId, date) {
      // No database means no demo reset to press and no vans reporting positions: the day the
      // fixtures describe is the day, it is started, and nobody is away on it.
      return { startedDate: date, vansOut: 0, approvalsWaiting: 0 };
    },
  };
}
