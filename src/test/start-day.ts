import type { Exec } from "@/db/exec";

/**
 * Start a site's day the way Restart does (`ops.scenario_clock`), for a test whose scenario is not
 * the standard seed — so a change it proposes is one the board would take (ledger #80: the agent
 * rehearses before it proposes, and an unstarted day refuses every plan write).
 */
export async function startDay(db: Exec, siteId: string, serviceDate: string): Promise<void> {
  await db.query(
    `INSERT INTO ops.scenario_clock (site_id, scenario, anchor_real, anchor_scenario)
     VALUES ($1, 'test', now(), ($2::date + time '06:00') AT TIME ZONE 'America/New_York')
     ON CONFLICT (site_id) DO UPDATE SET anchor_real = EXCLUDED.anchor_real, anchor_scenario = EXCLUDED.anchor_scenario`,
    [siteId, serviceDate],
  );
}
