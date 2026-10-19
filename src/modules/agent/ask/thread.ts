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
import { agentBubble } from "@/ui/copy";
import { namedOrNull } from "@/modules/identity/names";
import { effectId } from "@/modules/agent/run/exec/effects";
import { ANSWER_TOOLS } from "./answer";
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
      WHERE a.site_id = $1 AND a.decided_at IS NULL ORDER BY a.created_at, a.id`,
    [siteId],
  );
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
  const said = asks.rows.flatMap((r) => {
    const ask = { at: r.at, item: { kind: "staff", id: r.id, text: askTextOf(r.summary) } as AgentThreadItem };
    // The same line, under the same id, the bubble shows live (`agent-ask-state.addNoAnswer`).
    const unanswered = answeredByAlert.has(r.id) || r.category === STAFF_ALERT_TASK_CATEGORY;
    return unanswered
      ? [ask, { at: r.at, item: { kind: "agent", id: `${r.id}:no-answer`, text: agentBubble.noAnswer } as AgentThreadItem }]
      : [ask];
  });
  /*
   * THE MODEL'S ANSWERS, so a reload shows what it said and not only what was asked: each
   * `staff.ask` run's `summarize_thread_for_staff` note, in names (`ask/answer.ts`), placed when it
   * was written — after the ask it answers.
   */
  const notes = await db.query<{ ask_id: string; summary: string | null; at: Date }>(
    `SELECT r.trigger_id AS ask_id, c.args->>'summary' AS summary, c.created_at AS at
       FROM ops.agent_run r JOIN ops.agent_tool_call c ON c.run_id = r.id
      WHERE r.site_id = $1 AND r.trigger_type = 'staff.ask' AND c.tool = ANY($2::text[]) AND c.status = 'EXECUTED'
      ORDER BY c.created_at, c.id`,
    [siteId, ANSWER_TOOLS],
  );
  const answers = notes.rows.flatMap((r) => {
    const text = namedOrNull(r.summary);
    return text === null ? [] : [{ at: r.at, item: { kind: "agent", id: `${r.ask_id}:answer`, text } as AgentThreadItem }];
  });

  const ordered = [...said, ...answers, ...proposals].sort(
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
