/**
 * HAS ANYTHING CHANGED IN THE AGENT'S THREAD? (ledger #75 b)
 *
 * A colleague taps you on the shoulder; a screen has to be told. The bubble's thread is read on the
 * server when a page renders (`thread.ts`), and nothing used to tell an open page that the agent had
 * since heard an alert, answered, or drafted a card — so the ramp could confirm a van short and the
 * coordinator on Today saw nothing until they navigated. This is the cheap question every staff page
 * asks every few seconds: one stamp that moves whenever the thread could have, and whether a run is
 * still on its way. When the stamp moves, the page re-renders and the thread is read again.
 *
 * What moves it: any agent run at the site (started, retried, finished), any approval (drafted,
 * decided), and an ask that no model could take (its row is the only trace it leaves).
 */
import { agentRetryConfig } from "@/config/live";
import type { Exec } from "@/db/exec";
import { STAFF_ALERT_TASK_CATEGORY, STAFF_ASK_TASK_CATEGORY } from "./ask-text";
import { MODEL_UNAVAILABLE_CATEGORY } from "../alert-task";

export type ThreadPulse = { readonly stamp: string; readonly working: boolean };

/** A run older than every trigger's busy-model window and one more try is not on its way any more. */
const WORKING_FOR_SECONDS =
  Math.max(...Object.values(agentRetryConfig.retryForSeconds)) + agentRetryConfig.retryAfterSeconds;

export async function threadPulse(db: Exec, siteId: string): Promise<ThreadPulse> {
  const r = await db.query<{ stamp: string | null; working: boolean }>(
    `SELECT greatest(
              (SELECT max(updated_at) FROM ops.agent_run WHERE site_id = $1),
              (SELECT max(updated_at) FROM ops.approval_request WHERE site_id = $1),
              (SELECT max(created_at) FROM ops.task WHERE site_id = $1 AND category IN ($2, $3, $5))
            )::text AS stamp,
            EXISTS (SELECT 1 FROM ops.agent_run WHERE site_id = $1 AND state IN ('QUEUED', 'RUNNING', 'WAITING_TOOL')
                      AND created_at > now() - make_interval(secs => $4)) AS working`,
    // …and a "needs a person" card (ledger #80): what the agent could not finish moves the dot too.
    [siteId, STAFF_ASK_TASK_CATEGORY, STAFF_ALERT_TASK_CATEGORY, WORKING_FOR_SECONDS, MODEL_UNAVAILABLE_CATEGORY],
  );
  return { stamp: r.rows[0]?.stamp ?? "", working: r.rows[0]?.working ?? false };
}

/** The shell's read: a pulse that cannot be read is "nothing new", never a broken page. */
export async function threadPulseOrQuiet(db: () => Exec, siteId: string): Promise<ThreadPulse> {
  try {
    return await threadPulse(db(), siteId);
  } catch {
    return { stamp: "", working: false };
  }
}
