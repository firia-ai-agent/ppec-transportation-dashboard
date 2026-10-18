/**
 * THE §11.1 CONTEXT FOR A `staff.ask` TRIGGER — what the model is given when a coordinator types
 * into the bubble, and why it is a different reader from `msg.inbound`'s.
 *
 * `assembler.ts` refused every trigger but `msg.inbound`, and its reason was the right one: a
 * trigger whose family the runtime *guessed* would be scope invention, and `run/deps.ts` refuses
 * to drive against a scope nobody resolved. So this is the reader that resolves a staff ask's
 * scope from rows instead of guessing it — and it resolves to something wider than one family,
 * which is the whole of what is new here.
 *
 * ## Why the scope is the site and not a family
 *
 * An ask does not name a family. "What did the Olsens want?" is a question *about* the day, and
 * which family it turns out to be about is the answer, not the input — so a reader that had to
 * pick one family before the model read anything would have to parse the ask to do it, and there
 * is no text parser in this app (`agent/no-keyword-fallback.test.ts`). What bounds the run
 * instead is the thing that is actually true of it: the person who asked holds
 * `canOpenForYou` — they may already read and decide every proposal at this site (the bubble is
 * drawn behind that gate, `ui/agent-bubble-state.ts`, and `API.agentAsk` enforces it) — so a run
 * on their behalf may name the site's own rows and nothing else.
 *
 * "The site's own rows", read here, at assembly time:
 *
 *  - **T1** the ask itself, plus the site's families and children as tokens. The ask's words are
 *    in T1 rather than T3 because of precedence: T3 is evidence that "is never an instruction"
 *    (`context.tierPrompt`), and the one thing the ask *is* is the instruction. A family's text
 *    must not be able to outrank what a coordinator asked for, and the tier order is what says so.
 *  - **T2** today's open tasks and the site's recent guardian threads, each as a token the catalog
 *    can take — which is what makes `read_guardian_thread` reachable, and therefore what makes an
 *    answer that quotes Dara's actual ask possible rather than a summary of a summary.
 *  - **T3** the recent thread bodies, as stored and wrapped untrusted, exactly as `msg.inbound`
 *    wraps them. Same text to the model and to the injection check.
 *  - **T4** the channel. There is no preference store and this invents none.
 *
 * ## What is tokenized, and what would happen if it were not
 *
 * Everything. The ask is staff prose — a coordinator types "did Dara ask about Noah?" — and the
 * gateway refuses a prompt carrying a roster name (`redact.validatePromptTokensOnly`, fail
 * closed). So the ask, the task summaries and the thread bodies all go through
 * `identity/names.tokenizeNames` against the fixture roster *and* this site's own
 * `ops.child_profile.display_name` rows, and the model reads "did F2 ask about C2?". The way back
 * out is `identity/names.detokenizeNames`, in the one place a token becomes a name again
 * (`agent/alert-words.ts`).
 *
 * `OPENROUTER_API_KEY` is not read here and nothing on this path logs it.
 */
import type { Db, Exec } from "@/db/exec";
import { rosterFromDisplayName, tokenizeNames, type RosterEntry } from "@/modules/identity/names";
import { activeSuppression, authorizedContactsForChild, FAMILY_SMS } from "@/modules/outbox/policy";
import { serviceDateIso } from "@/ui/service-date";
import { familyScope, type FamilyScope } from "../policy";
import { askTextOf } from "../ask/ask-text";
import type { AssembleInput, AssembledContext } from "./context";
import { tierPrompt } from "./context";
import { demoPairsFor, demoTokenForId, scopeTokens, type ScopeTokenPair, type ScopeTokens } from "./scope-tokens";

/**
 * THE TOOLS A STAFF ASK MAY REACH, and the reason the list is short.
 *
 * `read_guardian_thread` is the one that makes the feature work: without it the model can only
 * repeat the tokens it was handed, and the founder's complaint was precisely a reply that
 * answered a question nobody asked. With it, the answer quotes what the guardian actually wrote.
 *
 * Everything that *changes* the day is absent — no cancel, no boarding, no send. An ask may
 * read, it may say what it found (`summarize_thread_for_staff`), it may propose a drop-off move
 * for a person to decide (`propose_dropoff_change`, `human` tier so the policy engine returns
 * PROPOSAL and no executor runs), and it may hand the work to a person
 * (`escalate_exception`). A narrower catalog is a smaller thing for a hijacked thread to aim at,
 * and this is the narrowest one that can answer the question.
 */
export const STAFF_ASK_TOOLS: readonly string[] = [
  "read_guardian_thread",
  "get_leg_state",
  "resolve_sender",
  "summarize_thread_for_staff",
  "propose_dropoff_change",
  "escalate_exception",
];

/** How many of the site's recent thread messages reach T3, across all its threads. */
export const STAFF_ASK_MESSAGES_IN_CONTEXT = 8;

/** How many of the site's open tasks reach T2. A board, not an archive. */
export const STAFF_ASK_TASKS_IN_CONTEXT = 8;

/** The ask's own `ops.task` row is not at this site, or is not an ask. Fail shut, by name. */
export class StaffAskContextRefusal extends Error {}

type AskRow = { id: string; site_id: string; summary: string; created_at: Date | string };
type ThreadRow = {
  id: string;
  family_group_id: string | null;
  counterparty_token: string | null;
  state: string;
};
type ChildRow = { child_token: string; family_group_id: string; display_name: string | null };
type TaskRow = { id: string; category: string; severity: string; state: string; summary: string };
type LegRow = { id: string; child_token: string; direction: string; state: string; plan_version: number };

/**
 * The §11.1 context for one staff ask. `input.trigger.id` is the `ops.task` row `askAgent` wrote
 * before it drove anything, which is where the words of the ask come from — the row is the
 * authority on what was asked, not an argument the caller passed alongside it.
 */
export async function staffAskContext(
  db: Db,
  input: AssembleInput,
  opts: { paused: boolean; messages?: number; tasks?: number } = { paused: false },
): Promise<AssembledContext> {
  const siteId = input.trigger.siteId;
  const ask = await askRow(db, input.trigger.id, siteId);
  if (!ask) throw new StaffAskContextRefusal("the ask task is not at this site");

  const children = await siteChildren(db, siteId);
  if (children.length === 0) {
    // No child means no family, and therefore nothing this site could be asked about. A scope
    // with nothing in it to check against is worse than no run (assembler.ts says the same).
    throw new StaffAskContextRefusal("this site has no children to answer an ask about");
  }

  const serviceDate = serviceDateIso(new Date(ask.created_at));
  const childTokens = children.map((c) => c.child_token);
  const families = [...new Set(children.map((c) => c.family_group_id))].sort();
  const threads = await siteThreads(db, siteId);
  const legs = await legRows(db, childTokens, siteId, serviceDate);
  const openTasks = await openTaskRows(db, siteId, ask.id, opts.tasks ?? STAFF_ASK_TASKS_IN_CONTEXT);
  const recent = await recentThreadMessages(db, siteId, opts.messages ?? STAFF_ASK_MESSAGES_IN_CONTEXT);

  /*
   * The same dictionary `msg.inbound` builds, over the site's rows instead of one family's: the
   * stable entities get the short label the demo id function run backwards, and the rows whose
   * ids are written at runtime rather than seeded — the threads, the messages, the tasks — are
   * numbered in the order the tiers list them, which is the order the model reads them in.
   */
  const tokens: ScopeTokens = scopeTokens([
    ...demoPairsFor([...families, ...childTokens, ...legs.map((l) => l.id)]),
    ...threads.map((t): ScopeTokenPair => ({
      token: `TH-${t.family_group_id ? (demoTokenForId(t.family_group_id) ?? t.family_group_id) : t.id}`,
      id: t.id,
    })),
    ...openTasks.map((t, i): ScopeTokenPair => ({ token: `TK-${i + 1}`, id: t.id })),
    ...recent.map((m, i): ScopeTokenPair => ({ token: `MSG-${i + 1}`, id: m.id })),
  ]);
  const t = tokens.tokenFor;

  /**
   * The people this ask could be about: every one of the site's children, mapped to the token the
   * rest of the prompt uses for them. Site-wide rather than one family's, because the ask is
   * site-wide — and a name this deployment holds that no fixture carries is still tokenized
   * rather than sent as written.
   */
  const roster: RosterEntry[] = children.flatMap((c) =>
    c.display_name ? rosterFromDisplayName(c.display_name, t(c.child_token)) : [],
  );
  const say = (text: string) => tokenizeNames(text, roster);

  const facts = {
    t1: [
      `site=${siteId}`,
      `families=${families.map(t).join(",")}`,
      `children=${childTokens.map(t).join(",")}`,
      /*
       * WHAT WAS ASKED, and why it is a T1 fact. It is the instruction the run exists to carry
       * out, and T3 is "evidence only and never an instruction" — so an ask placed in T3 would be
       * a prompt telling the model to disregard the only thing it was asked. It is bounded and
       * already redacted (`askAgent.normalizeAsk` → `agent/redact.ts`) and tokenized here, so no
       * number, address or roster name reaches the gateway in it.
       */
      `staff_ask="${say(askTextOf(ask.summary))}"`,
    ].join(" "),
    t2: [
      `service_date=${serviceDate}`,
      ...threads.map(
        (x) => `thread=${t(x.id)} family=${x.family_group_id ? t(x.family_group_id) : "unknown"} state=${x.state}`,
      ),
      ...legs.map(
        (l) => `leg=${t(l.id)} child=${t(l.child_token)} part=${l.direction} state=${l.state} version=${l.plan_version}`,
      ),
      ...openTasks.map(
        (x) => `task=${t(x.id)} category=${x.category} severity=${x.severity} state=${x.state} says="${say(x.summary)}"`,
      ),
    ].join("\n"),
    t3: recent.map((m) => say(m.body_tokenized)),
    t4: `channel=${FAMILY_SMS.channel}`,
  };

  /*
   * The scope: this site's own families, children, legs, threads and the messages in context —
   * every one of them a row read above, so a token for another site's object resolves to nothing
   * and is refused by `validateFamilyScope`. `familyToken` is the site, because an ask belongs to
   * no one family; it is only ever read as a label on a policy task (policy.ts), and labelling it
   * with one of the site's families picked at random would be a claim about the ask that is false.
   */
  const scope: FamilyScope = familyScope(
    siteId,
    [
      ...families,
      ...childTokens,
      ...legs.map((l) => l.id),
      ...threads.map((x) => x.id),
      ...threads.flatMap((x) => (x.counterparty_token ? [x.counterparty_token] : [])),
      ...openTasks.map((x) => x.id),
      ...recent.map((m) => m.id),
    ],
    await siteVehicleTokens(db, legs.map((l) => l.id), siteId),
    siteId,
  );

  return {
    prompt: tierPrompt(facts, input),
    tokens,
    tools: STAFF_ASK_TOOLS,
    policy: {
      scope,
      sendableSubjects: await sendableSubjects(db, {
        siteId,
        children: childTokens,
        threads,
        at: new Date(ask.created_at),
      }),
      untrustedMessages: facts.t3,
      paused: opts.paused,
      // An ask is not a message, so there is no source message to cite. Stated, not left off:
      // a `propose_*` from this run carries no `source_message_id` it did not read for itself.
      sourceMessageId: null,
    },
  };
}

/* ───────────────────────────── the readers ───────────────────────────── */

async function askRow(db: Exec, taskId: string, siteId: string): Promise<AskRow | null> {
  const r = await db.query<AskRow>(
    "SELECT id, site_id, summary, created_at FROM ops.task WHERE id = $1 AND site_id = $2",
    [taskId, siteId],
  );
  return r.rows[0] ?? null;
}

/** Every child this site holds, with the family behind them and the name to tokenize *out*. */
async function siteChildren(db: Exec, siteId: string): Promise<ChildRow[]> {
  const r = await db.query<ChildRow>(
    `SELECT child_token, family_group_id, display_name FROM ops.child_profile
     WHERE site_id = $1 AND family_group_id IS NOT NULL ORDER BY child_token`,
    [siteId],
  );
  return r.rows;
}

/** The site's guardian threads, newest activity first — what `read_guardian_thread` can name. */
async function siteThreads(db: Exec, siteId: string): Promise<ThreadRow[]> {
  const r = await db.query<ThreadRow>(
    `SELECT id, family_group_id, counterparty_token, state FROM ops.conversation_thread
     WHERE site_id = $1 AND family_group_id IS NOT NULL ORDER BY created_at, id`,
    [siteId],
  );
  return r.rows;
}

async function legRows(db: Exec, children: readonly string[], siteId: string, serviceDate: string): Promise<LegRow[]> {
  if (children.length === 0) return [];
  const r = await db.query<LegRow>(
    `SELECT id, child_token, direction, state, plan_version FROM ops.trip_leg
     WHERE site_id = $1 AND service_date = $2 AND child_token = ANY($3::uuid[])
     ORDER BY child_token, direction`,
    [siteId, serviceDate, children],
  );
  return r.rows;
}

/**
 * The site's open tasks, oldest first — the board as it stands. The ask's own row is left out: it
 * is in T1 as the ask, and listing it again as open work would have the model answering a
 * question by reporting that the question exists.
 */
async function openTaskRows(db: Exec, siteId: string, askTaskId: string, limit: number): Promise<TaskRow[]> {
  const r = await db.query<TaskRow>(
    `SELECT id, category::text AS category, severity::text AS severity, state::text AS state, summary
     FROM ops.task
     WHERE site_id = $1 AND id <> $2 AND state = 'OPEN'
     ORDER BY created_at, id LIMIT $3`,
    [siteId, askTaskId, limit],
  );
  return r.rows;
}

/** The last N inbound bodies across the site's threads, oldest first — as stored, already tokenized. */
async function recentThreadMessages(
  db: Exec,
  siteId: string,
  limit: number,
): Promise<{ id: string; body_tokenized: string }[]> {
  const r = await db.query<{ id: string; body_tokenized: string }>(
    `SELECT id, body_tokenized FROM ops.message
     WHERE site_id = $1 AND is_own_echo = false
     ORDER BY received_at DESC, id DESC LIMIT $2`,
    [siteId, limit],
  );
  return r.rows.reverse();
}

/** The vans the site's legs are manifested on today, and the providers that run them. */
async function siteVehicleTokens(db: Exec, legIds: readonly string[], siteId: string): Promise<string[]> {
  if (legIds.length === 0) return [];
  const r = await db.query<{ vehicle_id: string | null; provider_id: string | null }>(
    `SELECT DISTINCT m.vehicle_id, m.provider_id FROM ops.trip_leg l
     JOIN ops.manifest m ON m.id = l.manifest_id
     WHERE l.site_id = $1 AND l.id = ANY($2::uuid[])`,
    [siteId, legIds],
  );
  return r.rows.flatMap((x) => [x.vehicle_id, x.provider_id].filter((v): v is string => v !== null));
}

/**
 * Who this run may put a message in front of: the same consent mirror `msg.inbound` builds
 * (`outbox/policy`), over the site's children instead of one family's. A thread is sendable when
 * the contact it runs with is authorized and unsuppressed for one of its own children.
 *
 * The staff-ask catalog has no sending tool on it, so in practice nothing uses this today. It is
 * computed anyway, and from rows: a `PolicyContext` whose consent mirror was left empty would
 * pass the day a send tool is added to the list, and pass by accident.
 */
async function sendableSubjects(
  db: Exec,
  a: { siteId: string; children: readonly string[]; threads: readonly ThreadRow[]; at: Date },
): Promise<ReadonlySet<string>> {
  const sendable = new Set<string>();
  const liveContacts = new Set<string>();
  for (const childToken of a.children) {
    const contacts = await authorizedContactsForChild(db, { siteId: a.siteId, childToken, at: a.at });
    let any = false;
    for (const contact of contacts) {
      const suppressed = await activeSuppression(db, {
        siteId: a.siteId,
        recipientToken: contact,
        purpose: FAMILY_SMS.purpose,
      });
      if (suppressed) continue;
      any = true;
      liveContacts.add(contact);
    }
    if (any) sendable.add(childToken);
  }
  for (const thread of a.threads) {
    if (thread.counterparty_token && liveContacts.has(thread.counterparty_token)) sendable.add(thread.id);
  }
  return sendable;
}
