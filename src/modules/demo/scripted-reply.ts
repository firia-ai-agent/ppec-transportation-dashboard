/**
 * THE PARENT ANSWERS THE LATE TEXT — the demo day's one inbound, sent when it has something to
 * answer (user ruling 2026-10-18: "Dara's reply comes automatically after the late text").
 *
 * It used to be sent at Restart, before the day had told the family anything, so the parent was
 * answering a text nobody had sent. Now the order is the real one: a saved re-plan texts the family
 * that their van is late (`plan/replan-notices.ts`); when the simulated carrier reports that text
 * **delivered**, the scenario's parent replies a few seconds later, through the same inbound path a
 * real text takes (`demo/inbound-script.ts` → `ingestInbound` → the agent run).
 *
 * Which parent, and what they say, is scenario data, not code: the child is `DEMO_INBOUND`'s and
 * the words are `familyTexts.demoReply`. This module only decides *when*.
 *
 * ## Guards, and why each is where it is
 *
 *  - **Demo and synthetic, checked when scheduling and again when the job fires.** A job row
 *    outlives the deployment setting that wrote it, and the thing this job does — put a scripted
 *    message into a family's thread — must never happen on a deployment holding real data.
 *  - **Only the simulated carrier, only the re-plan's late text, only the scenario's child.** The
 *    stall-replay notice (`dropoff.late`) and every other family's text answer nothing.
 *  - **Once per service day.** The job key is the date and the family, and a key already used —
 *    in any state — schedules nothing, so a second delivery (two contacts, a later re-plan) is a
 *    no-op rather than an insert that would fail inside the carrier's status transaction. The
 *    inbound itself is idempotent on its `MessageSid` as well (`inbound-script.ts`).
 */
import type { Db, Exec } from "@/db/exec";
import { isDemoMode, isSyntheticDemo } from "@/lib/env";
import type { AgentWakeTransport } from "@/modules/agent/run/wake";
import type { JobScheduler } from "@/modules/jobs/scheduler";
import type { Handler } from "@/modules/jobs/runner";
import { REPLAN_LATE_TEMPLATE } from "@/modules/messaging/replan-late-template";
import type { OutboxTransport } from "@/modules/outbox/outbox";
import { DEMO_INBOUND, childByKey, childTokenOf } from "./fixtures/standard";
import { sendDemoInbound } from "./inbound-script";

export const SCRIPTED_REPLY_JOB_KIND = "demo.scripted.reply";

/** How long after the late text lands the parent answers: a person reading it, not an instant. */
export const SCRIPTED_REPLY_DELAY_MS = 4_000;

type Env = Record<string, string | undefined>;

const demoOn = (env: Env) => isDemoMode(env) && isSyntheticDemo(env);

/**
 * After a delivery status is applied: schedule the scripted reply if this was the scenario
 * family's re-plan late text. Runs inside the status job's own transaction.
 */
export async function scheduleScriptedReply(
  tx: Exec,
  afterCommit: (hook: () => Promise<void>) => void,
  scheduler: Pick<JobScheduler, "schedule">,
  a: { readonly outboundMessageId: string; readonly status: string; readonly now: Date; readonly env: Env },
): Promise<"scheduled" | "not-this-text" | "already" | "off"> {
  if (!demoOn(a.env)) return "off";
  if (a.status !== "DELIVERED") return "not-this-text";
  const row = (
    await tx.query<{ site_id: string; template_id: string; child_token: string | null; service_date: string | null }>(
      `SELECT o.site_id, o.template_id, o.child_token::text AS child_token, l.service_date::text AS service_date
         FROM ops.outbound_message o LEFT JOIN ops.trip_leg l ON l.id = o.trip_leg_id
        WHERE o.id = $1`,
      [a.outboundMessageId],
    )
  ).rows[0];
  const scenarioChild = childTokenOf(DEMO_INBOUND.childKey);
  if (!row || row.template_id !== REPLAN_LATE_TEMPLATE || row.child_token !== scenarioChild || !row.service_date) {
    return "not-this-text";
  }
  const key = `${SCRIPTED_REPLY_JOB_KIND}:${row.service_date}:${childByKey(DEMO_INBOUND.childKey).familyKey}`;
  const used = await tx.query("SELECT 1 FROM ops.job WHERE key = $1 LIMIT 1", [key]);
  if (used.rows.length > 0) return "already";
  await scheduler.schedule(tx, afterCommit, {
    siteId: row.site_id,
    key,
    kind: SCRIPTED_REPLY_JOB_KIND,
    payload: { serviceDate: row.service_date },
    dueAt: new Date(a.now.getTime() + SCRIPTED_REPLY_DELAY_MS),
    by: "system:demo-scripted-reply",
  });
  return "scheduled";
}

/**
 * The job: the scenario parent's text, through the real inbound path, in the job's own
 * transaction — and with the job's own `afterCommit`, so the agent run it starts is woken.
 */
export function scriptedReplyHandler(deps: {
  readonly agentTransport: AgentWakeTransport;
  readonly outboxTransport: OutboxTransport;
  readonly env?: Env;
  readonly now?: () => Date;
}): Handler {
  return async (tx, job, afterCommit) => {
    const env = deps.env ?? process.env;
    if (!demoOn(env)) return;
    const serviceDate = String((job.payload as { serviceDate?: unknown })?.serviceDate ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return;
    const inTx: Db = { query: (sql, params) => tx.query(sql, params), tx: (fn) => fn(tx, afterCommit) };
    const sent = await sendDemoInbound(inTx, {
      env,
      now: deps.now?.() ?? new Date(),
      serviceDate,
      agentTransport: deps.agentTransport,
      outboxTransport: deps.outboxTransport,
    });
    if (!sent.sent) console.log(`[demo:scripted-reply] not sent (${sent.reason})`);
  };
}
