/**
 * The action layer over one database (ledger #74): its plan store and its roster, read through the
 * same SQL adapters the screens' defaults use on a deployment. The agent's executors and the confirm
 * card pass this, so an action taken for a run is read and written on the run's own connection.
 */
import type { Db } from "@/db/exec";
import { sqlPlanStore } from "@/modules/plan/sql";
import { sqlDaySource } from "@/modules/roster/sql";
import type { ActionDeps } from "./types";

export function actionDepsFor(db: Db, siteId: string): ActionDeps {
  return { db, store: sqlPlanStore(db), source: sqlDaySource(db, siteId) };
}
