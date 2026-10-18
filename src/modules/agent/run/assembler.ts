/**
 * The §11.1 context assembler, over the operational tables (PRD l.924–929).
 *
 * `run/context.ts` already owns the *shape* — the four tiers, their order, the untrusted wrapper
 * around T3, and the "fresh each run" rule. What it says it does not own is the readers, and
 * `run/deps.ts` has refused to drive any run at all for want of them: a run must not be driven
 * against a scope the runtime invented. This module is those readers, and with it the queue route
 * stops refusing.
 *
 * ## What it reads, and what it refuses to read
 *
 * Every query here is an **ops** read. Nothing in this file touches the identity schema — no
 * name, no phone number, no address, no legal identity reaches a prompt by any path (ADR-011,
 * PRD §12 minimum-necessary, TEST-SEC-01 "token-only prompts"). What the model gets is the tokens
 * and codes the tool catalog already speaks:
 *
 *  - **T1** (approved facts + authorization, immutable for the run): the family, its children,
 *    each child's approved transport profile version and the *categories* of their approved
 *    needs, and the scopes §6.4 gives the contact who texted. Codes, versions and tokens.
 *  - **T2** (current state with versions): this family's legs on the service date, each with its
 *    state and the `plan_version` a write will be guarded on — which is what makes the §11.2
 *    "version check at send" possible at all.
 *  - **T3** (evidence, never instructions): the last N messages on this thread, as stored. They
 *    are already tokenized for contact details by the ingest (`tokenizeBody`) and are tokenized
 *    for *people* here (`identity/names.tokenizeNames`), because the gateway refuses a prompt
 *    carrying a roster name and is right to. The mapping is this family's own
 *    `ops.child_profile.display_name` rows plus the P1 fixture roster, so a child this deployment
 *    knows by a name no fixture carries is still tokenized rather than sent as written. `tierPrompt` wraps each one in
 *    `<untrusted_user_message>`, and the same list is handed to the policy engine, so the model
 *    and the injection check see exactly the same text.
 *  - **T4** (preferences that cannot override T1/T2): the channel this thread runs on. There is no
 *    preference store yet and this does not invent one.
 *
 * ## The scope, which is the part that matters
 *
 * `PolicyContext.scope` decides which family's and which site's objects a call may name. It is
 * built here from **the thread the trigger's message arrived on** — the site off the message row,
 * the family off the thread, the children off the family, the legs off the children — and never
 * from a tool argument (`tools.FORBIDDEN_ARG_TOKENS.tenant`). A message whose sender resolved to
 * nobody has no family and therefore no scope, and that is a refusal, not an empty scope: an
 * unknown sender is AT-09, and the one thing that must not happen is a run driving against a
 * scope with nothing in it to check against.
 *
 * `sendableSubjects` is the consent mirror: a child is sendable when §6.4 authorizes somebody for
 * them on this channel *and* that contact is not suppressed (`outbox/policy`). The outbox
 * re-checks per contact at send time; this is the earlier, cheaper refusal, so a suppressed
 * family never even gets a queued message (demo step 10).
 *
 * `paused` is the ops kill switch, read from the deployment's own environment
 * (`AGENT_PAUSED`). A switch, not a guess: the thing it must never be is a value this process
 * decided for itself.
 */
import type { Db, Exec } from "@/db/exec";
import { rosterFromDisplayName, tokenizeNames, type RosterEntry } from "@/modules/identity/names";
import { activeSuppression, authorizedContactsForChild, FAMILY_SMS } from "@/modules/outbox/policy";
import { serviceDateIso } from "@/ui/service-date";
import { familyScope, type FamilyScope } from "../policy";
import type { AssembleInput, AssembledContext, ContextAssembler, TierFacts } from "./context";
import { tierPrompt } from "./context";
import { demoPairsFor, demoTokenForId, scopeTokens, type ScopeTokenPair, type ScopeTokens } from "./scope-tokens";

/** How many thread messages reach T3. §11.1 says "last N"; this is N. */
export const THREAD_MESSAGES_IN_CONTEXT = 5;

/** The ops kill switch (§11.2 "paused"): set by an operator, never inferred. */
export const AGENT_PAUSED_ENV_VAR = "AGENT_PAUSED";

export function agentPaused(env: Record<string, string | undefined> = process.env): boolean {
  return env[AGENT_PAUSED_ENV_VAR] === "1";
}

/** No context could be assembled for this trigger. Fail shut, by name, with nothing executed. */
export class AssemblerRefusal extends Error {}

type MessageRow = {
  id: string;
  site_id: string;
  thread_id: string;
  received_at: Date | string;
  is_own_echo: boolean;
};

type ThreadRow = { id: string; family_group_id: string | null; counterparty_token: string | null; state: string };

/**
 * The §11.1 assembler for an inbound family message.
 *
 * Only `msg.inbound` for now, and the refusal for every other trigger type is deliberate: a timer,
 * a sweeper and a reconciliation each resolve their family from a different row, and an assembler
 * that guessed would be the scope-invention `deps.ts` refuses to allow. Each one is a reader to
 * add here when its trigger is wired.
 */
export function dbContextAssembler(
  db: Db,
  opts: { env?: Record<string, string | undefined>; messages?: number } = {},
): ContextAssembler {
  const env = opts.env ?? process.env;
  const limit = opts.messages ?? THREAD_MESSAGES_IN_CONTEXT;

  return async (input: AssembleInput): Promise<AssembledContext> => {
    if (input.trigger.type !== "msg.inbound") {
      throw new AssemblerRefusal(`no context reader for trigger type ${input.trigger.type}`);
    }
    const message = await messageRow(db, input.trigger.id, input.trigger.siteId);
    if (!message) throw new AssemblerRefusal("the trigger message is not at this site");
    if (message.is_own_echo) throw new AssemblerRefusal("the trigger message is our own echo (MSG-03)");

    const thread = await threadRow(db, message.thread_id, message.site_id);
    if (!thread?.family_group_id || !thread.counterparty_token) {
      // AT-09: an unknown sender has no family, so there is no scope to act inside.
      throw new AssemblerRefusal("the trigger message is from a sender this site does not know");
    }

    const serviceDate = serviceDateIso(new Date(message.received_at));
    const childRows = await childProfiles(db, thread.family_group_id, message.site_id);
    const children = childRows.map((c) => c.child_token);
    const legs = await legRows(db, children, message.site_id, serviceDate);
    const scopes = await authorizationScopes(db, thread.counterparty_token, message.site_id);
    const bodies = await threadBodies(db, thread.id, message.site_id, limit);
    const messageIds = await threadMessageIds(db, thread.id, message.site_id, limit);
    const vehicles = await runVehicleTokens(db, legs.map((l) => l.id), message.site_id);

    /**
     * The one dictionary this run reads both ways (`run/scope-tokens.ts`): every id below gets the
     * short label the model already sees in T3, and a tool call naming one of those labels is
     * resolved back to the id before the policy engine judges it (`run/loop.ts`). Built from this
     * run's own rows, so a token for another family's child resolves to nothing and is refused.
     *
     * The stable entities — family, children, legs, vehicles, providers — come from the demo id
     * function run backwards. The thread and the messages cannot: their ids are written at ingest
     * rather than seeded, so they are numbered here, in the order the tiers list them, which is
     * the order the model reads them in.
     */
    const familyToken = demoTokenForId(thread.family_group_id) ?? thread.family_group_id;
    const tokens: ScopeTokens = scopeTokens([
      ...demoPairsFor([thread.family_group_id, ...children, ...legs.map((l) => l.id), ...vehicles]),
      { token: `TH-${familyToken}`, id: thread.id },
      ...messageIds.map((id, i): ScopeTokenPair => ({ token: `MSG-${i + 1}`, id })),
    ]);
    const t = tokens.tokenFor;

    /**
     * The §11.1 token mapping for the people this thread can be about: the operational display
     * name of each of this family's children, mapped to **the same token the rest of the prompt
     * uses for that child** (B-07's vault is not wired, so `ops.child_profile.display_name` is
     * where a demo deployment's names live). Only this family's, because a thread naming another
     * family's child is AT-09 evidence and must reach the policy engine as written rather than be
     * quietly resolved to a token.
     */
    const familyNames: RosterEntry[] = childRows.flatMap((c) =>
      c.display_name ? rosterFromDisplayName(c.display_name, t(c.child_token)) : [],
    );
    const profiles = await profileFacts(db, children, message.site_id);

    const facts: TierFacts = {
      t1: [
        `site=${message.site_id}`,
        `family=${t(thread.family_group_id)}`,
        `children=${children.map(t).join(",") || "none"}`,
        ...profiles.map((fact) => fact.replace(/child=(\S+)/, (_, id: string) => `child=${t(id)}`)),
        `contact_scopes=${scopes.join(",") || "none"}`,
      ].join(" "),
      t2: [
        `service_date=${serviceDate}`,
        `thread=${t(thread.id)} state=${thread.state}`,
        ...legs.map(
          (l) => `leg=${t(l.id)} child=${t(l.child_token)} part=${l.direction} state=${l.state} version=${l.plan_version}`,
        ),
      ].join(" "),
      t3: bodies.map((body) => tokenizeNames(body, familyNames)),
      t4: `channel=${FAMILY_SMS.channel}`,
    };

    const scope: FamilyScope = familyScope(
      thread.family_group_id,
      [...children, ...legs.map((l) => l.id), thread.id, ...messageIds, thread.counterparty_token],
      // `shared` is the site's own non-family objects this run could legitimately name: the vans
      // its legs are manifested on. Minimum necessary — not the whole fleet.
      vehicles,
      message.site_id,
    );

    return {
      prompt: tierPrompt(facts, input),
      tokens,
      policy: {
        scope,
        sendableSubjects: await sendableSubjects(db, {
          siteId: message.site_id,
          children,
          threadId: thread.id,
          contactToken: thread.counterparty_token,
          at: new Date(message.received_at),
        }),
        untrustedMessages: facts.t3,
        paused: agentPaused(env),
        sourceMessageId: message.id,
      },
    };
  };
}

/* ───────────────────────────── the readers ───────────────────────────── */

async function messageRow(db: Exec, messageId: string, siteId: string): Promise<MessageRow | null> {
  const r = await db.query<MessageRow>(
    `SELECT id, site_id, thread_id, received_at, is_own_echo FROM ops.message
     WHERE id = $1 AND site_id = $2 AND direction = 'IN'`,
    [messageId, siteId],
  );
  return r.rows[0] ?? null;
}

async function threadRow(db: Exec, threadId: string, siteId: string): Promise<ThreadRow | null> {
  const r = await db.query<ThreadRow>(
    "SELECT id, family_group_id, counterparty_token, state FROM ops.conversation_thread WHERE id = $1 AND site_id = $2",
    [threadId, siteId],
  );
  return r.rows[0] ?? null;
}

/**
 * This family's children: the token the prompt and the tool schemas use, and the display name the
 * *staff* screens use — read here only to be tokenized *out* of T3 (`rosterFromDisplayName`). It
 * never reaches a tier: `facts.t1` carries `children=<tokens>` and nothing else.
 */
async function childProfiles(
  db: Exec,
  familyGroupId: string,
  siteId: string,
): Promise<{ child_token: string; display_name: string | null }[]> {
  const r = await db.query<{ child_token: string; display_name: string | null }>(
    `SELECT child_token, display_name FROM ops.child_profile
     WHERE family_group_id = $1 AND site_id = $2 ORDER BY child_token`,
    [familyGroupId, siteId],
  );
  return r.rows;
}

type LegFact = { id: string; child_token: string; direction: string; state: string; plan_version: number };

async function legRows(db: Exec, children: readonly string[], siteId: string, serviceDate: string): Promise<LegFact[]> {
  if (children.length === 0) return [];
  const r = await db.query<LegFact>(
    `SELECT id, child_token, direction, state, plan_version FROM ops.trip_leg
     WHERE site_id = $1 AND service_date = $2 AND child_token = ANY($3::uuid[])
     ORDER BY child_token, direction`,
    [siteId, serviceDate, children],
  );
  return r.rows;
}

/** The scopes §6.4 gives this contact, as codes. Which child each is for stays in T1's child list. */
async function authorizationScopes(db: Exec, contactToken: string, siteId: string): Promise<string[]> {
  const r = await db.query<{ scope: string }>(
    `SELECT DISTINCT scope::text AS scope FROM ops.contact_authorization
     WHERE site_id = $1 AND contact_token = $2 ORDER BY scope`,
    [siteId, contactToken],
  );
  return r.rows.map((x) => x.scope);
}

/** The approved profile version and approved need categories per child — codes, never values. */
async function profileFacts(db: Exec, children: readonly string[], siteId: string): Promise<string[]> {
  if (children.length === 0) return [];
  const r = await db.query<{ child_token: string; profile_version: number; categories: string[] | null }>(
    `SELECT p.child_token, p.profile_version,
            array_remove(array_agg(n.category::text ORDER BY n.category::text) FILTER (WHERE n.state = 'APPROVED'), NULL) AS categories
     FROM ops.transport_profile p
     LEFT JOIN ops.transport_need_item n ON n.profile_id = p.id
     WHERE p.site_id = $1 AND p.child_token = ANY($2::uuid[]) AND p.status = 'APPROVED'
     GROUP BY p.child_token, p.profile_version
     ORDER BY p.child_token`,
    [siteId, children],
  );
  return r.rows.map(
    (x) => `profile child=${x.child_token} version=${x.profile_version} needs=${(x.categories ?? []).join("|") || "none"}`,
  );
}

/** The last N bodies on this thread, oldest first — as stored, which is already tokenized. */
async function threadBodies(db: Exec, threadId: string, siteId: string, limit: number): Promise<string[]> {
  const r = await db.query<{ body_tokenized: string }>(
    `SELECT body_tokenized FROM ops.message WHERE thread_id = $1 AND site_id = $2 AND is_own_echo = false
     ORDER BY received_at DESC, id DESC LIMIT $3`,
    [threadId, siteId, limit],
  );
  return r.rows.map((x) => x.body_tokenized).reverse();
}

/** The ids of those same messages: a tool may cite one as its source, so they are in scope. */
async function threadMessageIds(db: Exec, threadId: string, siteId: string, limit: number): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM ops.message WHERE thread_id = $1 AND site_id = $2
     ORDER BY received_at DESC, id DESC LIMIT $3`,
    [threadId, siteId, limit],
  );
  return r.rows.map((x) => x.id);
}

/** The vehicles this family's legs are manifested on today, and the providers that run them. */
async function runVehicleTokens(db: Exec, legIds: readonly string[], siteId: string): Promise<string[]> {
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
 * Who this run may put a message in front of: a child with an authorized, unsuppressed contact,
 * and the thread itself when the contact who texted is one of them (`request_clarification`
 * answers into the thread, so the thread is its consent subject).
 */
async function sendableSubjects(
  db: Exec,
  a: { siteId: string; children: readonly string[]; threadId: string; contactToken: string; at: Date },
): Promise<ReadonlySet<string>> {
  const sendable = new Set<string>();
  let contactIsSendable = false;
  for (const childToken of a.children) {
    const contacts = await authorizedContactsForChild(db, { siteId: a.siteId, childToken, at: a.at });
    const live: string[] = [];
    for (const contact of contacts) {
      const suppressed = await activeSuppression(db, {
        siteId: a.siteId,
        recipientToken: contact,
        purpose: FAMILY_SMS.purpose,
      });
      if (!suppressed) live.push(contact);
    }
    if (live.length > 0) sendable.add(childToken);
    if (live.includes(a.contactToken)) contactIsSendable = true;
  }
  if (contactIsSendable) sendable.add(a.threadId);
  return sendable;
}
