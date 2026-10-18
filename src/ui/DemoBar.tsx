import { getCaller } from "@/auth/caller";
import { DAY_VANS } from "@/config/vans";
import { isSyntheticDemo } from "@/lib/env";
import { DemoBanner } from "./DemoBanner";

/**
 * The DEMO bar as the root layout mounts it: one place that reads who is asking, so the bar can
 * leave its one control out for a role the reset does not serve (REDESIGN-SPEC §0 — the front
 * desk never sees "Restart demo day", and `POST /api/demo/reset` refuses them besides).
 *
 * A file of its own, and this is the whole reason: `DemoBanner` is a component with no session
 * in it, so it can be rendered in a unit test (src/ui/shell.test.ts renders the bar for all
 * three roles). Reading the session inside it would pull Auth.js — and `next/server` — into
 * every test that imports it, and the bar's markup would stop being something a test can look
 * at. The session read is here, where nothing but the layout imports it.
 *
 * It is the only session read above the app shell. Every page under it guards itself again
 * (src/auth/page-guard.ts), exactly as before: this decides what the *bar* draws, and nothing
 * else. The environment gate is repeated here so that on a future LIVE build the bar is not
 * even a reason to look up a caller.
 *
 * It also reads the one other thing the bar's control needs: how many vans the day runs, because
 * the question in front of a reset says which vans lose their plan (`demoDay.confirm.body`, Veri's
 * S2 on #79). `DAY_VANS` is the vans-on-the-road list both day sources build a day's vans from
 * (src/modules/demo/day-source.ts, src/modules/roster/sql.ts), so this is the same count the
 * board's own `day.vans` has — read from the config, with no query of its own: the bar is on
 * every route, and a reset question is not worth a database read per page.
 */
export async function DemoBar() {
  if (!isSyntheticDemo()) return null;
  const caller = await getCaller();
  const role = caller.kind === "STAFF" ? caller.role : null;
  return <DemoBanner role={role} vanCount={DAY_VANS.length} />;
}
