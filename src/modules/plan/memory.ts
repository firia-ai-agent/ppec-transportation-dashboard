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
 * So the store has a second implementation, and the honesty of it matters:
 *  - it is used **only** when no database is configured (src/modules/plan/store.ts), so no
 *    deployment ever takes this path — production has Neon, previews have Neon;
 *  - it starts from exactly the state the demo seed writes (src/modules/demo/seed.ts): one
 *    `CHECKED` setup per van for **yesterday**, nothing for today, and no plan for today. So the
 *    board opens on "Using yesterday's van setup", every van reads "Not checked", and the Live
 *    map is locked until a plan is saved — the §9 reset contract, same as on a real database;
 *  - what it cannot prove is that the SQL is right. That is proved directly instead, by running
 *    the real statements against the real migrations on PGlite (src/modules/plan/sql.test.ts).
 *
 * It is per process, so two serverless instances would disagree — which is exactly the fault
 * #58's in-memory plan store had, and exactly why the deployed path is SQL.
 */
import { VANS } from "@/config/vans";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { staffLabel } from "@/auth/demo-accounts";
import type { SetupRow } from "@/domain/plan/setup";
import type { Direction } from "@/domain/solver";
import type { PlanStore, SavedPlan, SavePlanInput, SavePlanOutcome } from "./types";

/** "2026-10-17" minus one day, in plain date arithmetic on the centre's own calendar date. */
export function dayBefore(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

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

/**
 * Yesterday's confirmed setup for every van, which is what the seed writes and what the default
 * ladder then carries into today (src/domain/plan/setup.ts).
 *
 * Additive, and only where a row is missing: a van somebody has already counted keeps the count
 * they gave it. Filling the day in wholesale would mean reading the board for another date threw
 * away a Confirm — which is exactly the shape of bug the SQL store cannot have, so the fallback
 * must not have it either.
 */
function seedYesterday(date: string): void {
  const yesterday = dayBefore(date);
  for (const van of VANS) {
    const vehicleId = vehicleIdOf(van.vehicleKey);
    const already = state().setups.some(
      (row) => row.vehicleId === vehicleId && row.serviceDate === yesterday,
    );
    if (already) continue;
    state().setups.push({
      vehicleId,
      serviceDate: yesterday,
      setup: van.defaultSetup,
      state: "CHECKED",
      setBy: null,
      setAt: `${yesterday}T12:00:00.000Z`,
    });
  }
}

/** Forget everything. Used by the demo reset and by tests that want a fresh process. */
export function clearMemoryPlanStore(): void {
  state().setups = [];
  state().plans.clear();
}

export function memoryPlanStore(): PlanStore {
  return {
    async setupRows(_siteId, date, vehicleIds) {
      seedYesterday(date);
      return state().setups
        .filter((row) => vehicleIds.includes(row.vehicleId) && row.serviceDate <= date)
        .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
    },

    async putSetup(_siteId, input) {
      seedYesterday(input.date);
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
      };
      state().plans.set(key, saved);
      return { ok: true, version: saved.version, savedAt: saved.savedAt };
    },

    async dayContext(_siteId, date) {
      // No database means no demo reset to press and no vans reporting positions: the day the
      // fixtures describe is the day, it is started, and nobody is away on it.
      return { startedDate: date, absentTokens: [], vansOut: 0, approvalsWaiting: 0 };
    },
  };
}
