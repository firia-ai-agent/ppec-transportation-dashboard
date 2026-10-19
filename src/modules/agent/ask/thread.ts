/**
 * WHAT THE BUBBLE'S THREAD IS READ FROM.
 *
 * Three reads, all of rows this app actually holds, and **nothing is invented**: a day with
 * nothing in it returns an empty list and the panel says so (src/ui/AgentThread.tsx).
 *
 *  1. **The staff asks** — `ops.task` rows of category STAFF_ASK, which is what `askAgent` writes
 *     before it drives anything (staff-ask.ts). These are the teal bubbles on the right: they are
 *     the person's own words, so they are the one half of the conversation this branch has.
 *  2. **The proposals waiting for a decision** — `ops.approval_request` with no `decided_at`, and
 *     `ops.change_request` still `NEEDS_HUMAN`. Pending is the absence of a decision, read off
 *     the row rather than computed, so nothing here can call a decided proposal pending.
 *  3. Nothing else. **There are no driver messages on this branch**: `ops.message` holds the
 *     family SMS threads (direction IN from a guardian's number, src/modules/messaging), and a
 *     driver saying "running 10 minutes behind" — the grey bubble in Vera's mockup — has no store
 *     yet. The component can draw one the moment there is one; until then the thread shows what
 *     exists, which is the honest answer and is what the PR body says.
 *
 * Read-only, and site-scoped on every statement: the caller's site is the fence, as everywhere
 * else (`requireSiteAccess` is the write-side half; this never writes).
 */
import type { Db } from "@/db/exec";
import type { AgentThreadItem } from "@/ui/AgentThread";
import { agentRetryConfig } from "@/config/live";
import { agentBubble, confirmCopy, fill } from "@/ui/copy";
import { STALE_PLAN_CARD_SQL } from "@/modules/actions/confirm-cards";
import { boardHref, PLAN_ROUTES_PATH } from "@/modules/plan/when";
import { ALERT_TRIGGER } from "@/modules/agent/alerts";
import { namedOrNull } from "@/modules/identity/names";
import { effectId } from "@/modules/agent/run/exec/effects";
import { ANSWER_TOOLS } from "./answer";

/**
 * How long an ask's run reads as "working": its whole busy-model retry window and one more try
 * (ledger #75), so a run that is waiting on a rate-limited vendor still says it is on it.
 */
const ASK_WORKING_FOR_SECONDS = agentRetryConfig.retryForSeconds["staff.ask"] + agentRetryConfig.retryAfterSeconds;
import { STAFF_ALERT_TASK_CATEGORY, STAFF_ASK_TASK_CATEGORY, askTextOf } from "./ask-text";

export type AgentThreadView = {
  readonly items: readonly AgentThreadItem[];
  /** How many proposals are waiting. The coral dot on the closed disc is drawn iff this is > 0. */
  readonly waiting: number;
};

const EMPTY: AgentThreadView = { items: [], waiting: 0 };

export async function readAgentThread(db: Db, siteId: string): Promise<AgentThreadView> {
  /*
   * The asks, and the alerts an ask raised when nobody could answer it (ledger #74). Both are read
   * so a question never stands alone after a reload: an ask the agent took is a STAFF_ASK row, and
   * if its run ended with nothing to say, `askAgent` raised NEEDS_PERSON under the derived id
   * `effectId(askId, "needs-person")`. An ask typed when no model could run at all *is* a
   * NEEDS_PERSON row, under the ask's own id. The derived id is what tells the two apart.
   */
  const rows = await db.query<{ id: string; category: string; summary: string; at: Date }>(
    `SELECT id, category, summary, created_at AS at FROM ops.task
     WHERE site_id = $1 AND category IN ($2, $3) ORDER BY created_at, id`,
    [siteId, STAFF_ASK_TASK_CATEGORY, STAFF_ALERT_TASK_CATEGORY],
  );
  const asked = rows.rows.filter((r) => r.category === STAFF_ASK_TASK_CATEGORY);
  const alertIds = new Set(rows.rows.filter((r) => r.category === STAFF_ALERT_TASK_CATEGORY).map((r) => r.id));
  const answeredByAlert = new Set(asked.filter((r) => alertIds.has(effectId(r.id, "needs-person"))).map((r) => r.id));
  const derivedAlertIds = new Set(asked.map((r) => effectId(r.id, "needs-person")));
  const unanswerable = rows.rows.filter((r) => r.category === STAFF_ALERT_TASK_CATEGORY && !derivedAlertIds.has(r.id));
  const asks = { rows: [...asked, ...unanswerable] };
  // Pending = nobody has decided. The approval's own words are the task it hangs on.
  const approvals = await db.query<{ id: string; summary: string; at: Date }>(
    `SELECT a.id, t.summary, a.created_at AS at
       FROM ops.approval_request a JOIN ops.task t ON t.id = a.task_id
      WHERE a.site_id = $1 AND a.decided_at IS NULL
        AND NOT (a.proposal->>'kind' = 'STAFF_ACTION' AND ${STALE_PLAN_CARD_SQL})
      ORDER BY a.created_at, a.id`,
    [siteId],
  );
  /*
   * HOW EACH CARD ENDED (ledger #75 c): the line a confirmed or declined card leaves where it was
   * (`actions/outcome.ts`), and "already handled" for a plan card the board was saved past.
   */
  const closed = await db.query<{ id: string; outcome: string | null; at: Date }>(
    `SELECT a.id, a.proposal->>'outcome' AS outcome, a.decided_at AS at FROM ops.approval_request a
      WHERE a.site_id = $1 AND a.proposal->>'kind' = 'STAFF_ACTION' AND a.decided_at IS NOT NULL AND a.proposal->>'outcome' IS NOT NULL
     UNION ALL
     SELECT a.id, NULL, a.created_at FROM ops.approval_request a
      WHERE a.site_id = $1 AND a.proposal->>'kind' = 'STAFF_ACTION' AND a.decided_at IS NULL AND ${STALE_PLAN_CARD_SQL}`,
    [siteId],
  );
  const endings = closed.rows.map((r) => ({
    at: r.at,
    item: { kind: "agent", id: `${r.id}:done`, text: r.outcome ?? confirmCopy.alreadyHandled } as AgentThreadItem,
  }));
  const changes = await db.query<{ id: string; summary: string | null; at: Date }>(
    `SELECT id, payload->>'claim_summary' AS summary, created_at AS at
       FROM ops.change_request WHERE site_id = $1 AND status = 'NEEDS_HUMAN' ORDER BY created_at, id`,
    [siteId],
  );

  /*
   * ONE THREAD, IN THE ORDER IT HAPPENED. The mockup's panel interleaves them — a message, the
   * proposal it produced, the next message (png/agent-bubble-open-1440.png) — so the two reads
   * are merged on `created_at` rather than concatenated. A conversation listed as "everything
   * said, then everything proposed" is not the conversation that happened.
   */
  const proposals = [...approvals.rows, ...changes.rows]
    .filter((r) => r.summary)
    .map((r) => ({ at: r.at, item: { kind: "proposal", id: r.id, question: String(r.summary) } as AgentThreadItem }));
  const notes = await db.query<{ ask_id: string; summary: string | null; at: Date }>(
    `SELECT r.trigger_id AS ask_id, c.args->>'summary' AS summary, c.created_at AS at
       FROM ops.agent_run r JOIN ops.agent_tool_call c ON c.run_id = r.id
      WHERE r.site_id = $1 AND r.trigger_type = ANY($3::text[]) AND c.tool = ANY($2::text[]) AND c.status = 'EXECUTED'
      ORDER BY c.created_at, c.id`,
    [siteId, ANSWER_TOOLS, ["staff.ask", ALERT_TRIGGER]],
  );
  /*
   * Asks still on the agent queue (ledger #74): the run is QUEUED, RUNNING or parked on a timer, so
   * the panel says it is working rather than leaving the question bare. The answer or the
   * "couldn't answer" line replaces it on the refresh after the run ends.
   */
  const pending = new Set(
    (
      await db.query<{ ask_id: string }>(
        `SELECT trigger_id AS ask_id FROM ops.agent_run
          WHERE site_id = $1 AND trigger_type = 'staff.ask' AND state IN ('QUEUED', 'RUNNING', 'WAITING_TOOL')
            AND created_at > now() - make_interval(secs => $2)`,
        // A run older than the bubble keeps refreshing for is not "working" any more: it was
        // abandoned (a request that timed out mid-drive) and its outcome line is what is true.
        [siteId, ASK_WORKING_FOR_SECONDS],
      )
    ).rows.map((r) => r.ask_id),
  );
  /*
   * THE MODEL'S ANSWERS, so a reload shows what it said and not only what was asked: each run's
   * `reply_to_staff` or `summarize_thread_for_staff` note, in names (`ask/answer.ts`), placed when
   * it was written. Keyed on what the run was about — the ask, or the alert it heard. A note this
   * roster cannot name in full is not an answer, so it does not hide the line that would say so.
   */
  const answers = notes.rows.flatMap((r) => {
    const text = namedOrNull(r.summary);
    return text === null ? [] : [{ at: r.at, item: { kind: "agent", id: `${r.ask_id}:answer`, text } as AgentThreadItem }];
  });
  const answeredIds = new Set(answers.map((a) => (a.item as { id: string }).id.replace(/:answer$/, "")));
  const said = asks.rows.flatMap((r) => {
    const ask = { at: r.at, item: { kind: "staff", id: r.id, text: askTextOf(r.summary) } as AgentThreadItem };
    // The outcome, when there is one, is what the person reads — never "working" over it.
    if (pending.has(r.id) && !answeredByAlert.has(r.id) && !answeredIds.has(r.id)) {
      return [ask, { at: r.at, item: { kind: "agent", id: `${r.id}:working`, text: agentBubble.working } as AgentThreadItem }];
    }
    // The same line, under the same id, the bubble shows live (`agent-ask-state.addNoAnswer`).
    const unanswered = answeredByAlert.has(r.id) || r.category === STAFF_ALERT_TASK_CATEGORY;
    return unanswered
      ? [ask, { at: r.at, item: { kind: "agent", id: `${r.id}:no-answer`, text: agentBubble.noAnswer } as AgentThreadItem }]
      : [ask];
  });
  const heard = await alertsHeard(db, siteId, answeredIds);

  const ordered = [...said, ...heard, ...answers, ...proposals, ...endings].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  if (ordered.length === 0) return EMPTY;
  return {
    items: [{ kind: "day", label: agentBubble.today }, ...ordered.map((r) => r.item)],
    waiting: proposals.length,
  };
}

/**
 * The same read, never allowed to take a screen down with it. Takes the handle lazily, so a
 * missing DATABASE_URL (getNeonDb throws) also lands in the catch — Veri #84 S1 at e06d88f:
 * resolving it outside the try made every staff page 500 on the e2e server.
 */
export async function readAgentThreadOrEmpty(
  db: Db | (() => Db),
  siteId: string,
): Promise<AgentThreadView> {
  try {
    return await readAgentThread(typeof db === "function" ? db() : db, siteId);
  } catch {
    // A panel that cannot list today's proposals is a smaller problem than a console that will
    // not render. The proposals are still on their own screen, which is this one's link target.
    return EMPTY;
  }
}

/** How long an alert's run reads as "working": its whole busy-model window and one more try. */
const ALERT_WORKING_FOR_SECONDS = agentRetryConfig.retryForSeconds[ALERT_TRIGGER] + agentRetryConfig.retryAfterSeconds;

/**
 * THE ALERTS THE AGENT HEARD (ledger #75 b), the way a colleague would bring one to you: what is
 * wrong, in the alert's own words (the rule that raised it wrote them — `plan/van-short.ts`), then
 * what the agent made of it.
 *
 *  - still on it: the alert, and "Working on it…";
 *  - it answered: only its answer — its own words about the same thing replace the alert's;
 *  - it drafted a change: the alert, and the card below it is the answer;
 *  - it ended with nothing, or could not reach a model in its window: the alert, that no fix came,
 *    and the board's Re-plan for that leg and van — the day, never the vendor.
 */
async function alertsHeard(
  db: Db,
  siteId: string,
  answered: ReadonlySet<string>,
): Promise<{ at: Date; item: AgentThreadItem }[]> {
  const runs = await db.query<{
    task_id: string;
    summary: string;
    at: Date;
    evidence: { locator?: { van_id?: string; date?: string; leg?: string } } | null;
    live: boolean;
    proposed: boolean;
  }>(
    `SELECT t.id::text AS task_id, t.summary, t.created_at AS at, t.completion_evidence AS evidence,
            (r.state IN ('QUEUED', 'RUNNING', 'WAITING_TOOL') AND r.created_at > now() - make_interval(secs => $3)) AS live,
            EXISTS (SELECT 1 FROM ops.agent_tool_call c WHERE c.run_id = r.id AND c.status = 'PROPOSED') AS proposed
       FROM ops.agent_run r JOIN ops.task t ON t.id::text = r.trigger_id AND t.site_id = r.site_id
      WHERE r.site_id = $1 AND r.trigger_type = $2
        -- A run stood down because the situation moved on (plan/van-short.ts) says nothing.
        AND (r.state <> 'ABORTED_SUPERSEDED_BY_HUMAN'
             OR EXISTS (SELECT 1 FROM ops.agent_tool_call c WHERE c.run_id = r.id AND c.status = 'PROPOSED'))
        -- An alert a newer one about the same thing replaced is not the situation any more.
        AND NOT EXISTS (
          SELECT 1 FROM ops.task n
           WHERE n.site_id = t.site_id AND n.category = t.category AND n.id <> t.id AND n.created_at > t.created_at
             AND n.completion_evidence->'locator' IS NOT NULL
             AND n.completion_evidence->'locator' = t.completion_evidence->'locator')
      ORDER BY t.created_at, t.id`,
    [siteId, ALERT_TRIGGER, ALERT_WORKING_FOR_SECONDS],
  );
  return runs.rows.flatMap((a) => {
    if (answered.has(a.task_id)) return [];
    const head = { at: a.at, item: { kind: "agent", id: `${a.task_id}:alert`, text: a.summary } as AgentThreadItem };
    if (a.live) return [head, { at: a.at, item: { kind: "agent", id: `${a.task_id}:working`, text: agentBubble.working } as AgentThreadItem }];
    if (a.proposed) return [head];
    const where = a.evidence?.locator;
    const leg = where?.leg === "AM" || where?.leg === "PM" ? where.leg : null;
    return [{
      at: a.at,
      item: {
        kind: "agent",
        id: `${a.task_id}:no-fix`,
        text: fill(agentBubble.couldNotFix, { situation: a.summary }),
        ...(where?.date && leg
          ? { link: { href: boardHref(PLAN_ROUTES_PATH, { date: where.date, leg, van: where.van_id }), label: agentBubble.replanLink } }
          : {}),
      } as AgentThreadItem,
    }];
  });
}
