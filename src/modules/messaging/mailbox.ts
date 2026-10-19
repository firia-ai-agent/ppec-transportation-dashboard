/**
 * Persona-phone read model for the demo panel (MOCKS §3, DESIGN-DIRECTION §6.3: "status ticks
 * Queued -> Sent -> Delivered under bubbles"). B-04 owns the data; the UI track owns the screens.
 *
 * A phone shows two things merged in time order: the inbound messages the persona sent (ops.message,
 * direction IN) and the outbound messages addressed to that contact (ops.outbound_message, so a bubble
 * exists from QUEUED, before the provider has it). Outbound bodies are rendered from the template here,
 * never stored twice. `reachedPhone` tells the UI which rows actually left the center, so a blocked or
 * stale message can never be drawn as if the family received it (demo step 10).
 */
import { API, endpointRow } from "@/auth/access";
import { Forbidden, SiteNotFound, Unauthenticated, getActiveUser, requireSiteAccess, type StaffRole } from "@/auth/core";
import type { Exec } from "@/db/exec";
import type { IdentityGateway } from "@/modules/identity/gateway";
import type { OutboxState } from "@/modules/outbox/outbox";
import { isSimPersonaNumber, parseSimNumber, simPersonaLabel } from "./sim-numbers";
import { renderTemplate } from "./templates";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

/**
 * A `?limit=` as a page size. Whatever a caller sends, SQL is handed an integer in [1, MAX_LIMIT]:
 * absent or empty is the default, anything unreadable (`abc`, `NaN`) is the default, negative and
 * zero and `-Infinity` clamp up to 1, and huge values and `Infinity` clamp down to the cap. So an
 * abusive limit is a page of a different size, never an error and never an unbounded read.
 */
export function clampLimit(limit: unknown): number {
  if (limit === null || limit === undefined || limit === "") return DEFAULT_LIMIT;
  const n = Math.trunc(Number(limit));
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, n), MAX_LIMIT);
}

/** States that mean the provider accepted the message, so the phone really has it. */
const ON_PHONE: ReadonlySet<string> = new Set<OutboxState>(["SENT", "DELIVERED", "UNDELIVERED", "UNKNOWN", "REDACTED"]);

export type Persona = { number: string; label: string | null; contactToken: string; familyGroupId: string | null; siteId: string };

export type PersonaMessage = {
  id: string;
  direction: "IN" | "OUT";
  at: string;
  /** Tokenized inbound text, or the rendered outbound body; null if a template no longer renders. */
  body: string | null;
  /** Outbound only: the state the UI maps to Queued / Sent / Delivered / … (DESIGN-DIRECTION §3). */
  state: string | null;
  /**
   * Outbound only: which template the body was rendered from, so a reader can tell a text the day
   * sent by itself from one a person signed (`auto-sends.ts`, Firia's gate 4). Null inbound.
   */
  templateId: string | null;
  reachedPhone: boolean;
  blockReason: string | null;
  providerMessageId: string | null;
  providerIndex: number | null;
  sourceMode: string;
};

/**
 * Resolve the phone to its contact before any message is read, so authorization can run on the
 * site first.
 *
 * THE LOOKUP IS THE GATEWAY'S, NOT THIS MODULE'S. A phone number lives in
 * `identity.guardian_contact`, and `app_rw` — the role every `Exec` here runs as — has no
 * SELECT on that schema (src/db/schema.ts:104, 0001_roles.sql, migrations.test.ts:108). This
 * function used to send that query down `db` itself, which is why Family texts answered
 * "the message log could not be read" on the preview: `permission denied for schema identity`.
 * `db` is still needed, and only for `ops` rows; whoever the number belongs to is asked of
 * `IdentityGateway` (src/modules/identity/gateway.ts).
 */
export async function resolvePersona(
  db: Exec, a: { number: string; pepper: string; gateway: IdentityGateway },
): Promise<Persona | null> {
  const number = parseSimNumber(a.number);
  if (!number || !isSimPersonaNumber(number)) return null;
  const contact = await a.gateway.contactForPhone(number);
  return contact
    ? {
        number,
        label: simPersonaLabel(number),
        contactToken: contact.contactToken,
        familyGroupId: contact.familyGroupId,
        siteId: contact.siteId,
      }
    : null;
}

export async function personaMessages(db: Exec, p: Persona, limit: number = DEFAULT_LIMIT): Promise<PersonaMessage[]> {
  const n = clampLimit(limit);
  const inbound = await db.query<{ id: string; body_tokenized: string; received_at: Date; provider_index: string | null; source_mode: string; external_id: string }>(
    `SELECT m.id, m.body_tokenized, m.received_at, m.provider_index, m.source_mode, m.external_id
     FROM ops.message m JOIN ops.conversation_thread t ON t.id = m.thread_id
     WHERE m.site_id = $1 AND t.counterparty_token = $2 AND m.direction = 'IN' AND m.is_own_echo = false
     ORDER BY m.received_at DESC, m.id DESC LIMIT $3`, [p.siteId, p.contactToken, n]);
  // The child's own row, as the sender renders with it (`sim-provider.childName`): the thread shows
  // the words that reached the phone, "Noah's van", not a re-render that says "your child".
  const outbound = await db.query<{ id: string; state: string; template_id: string; vars: Record<string, unknown>; created_at: Date; block_reason: string | null; provider_message_id: string | null; source_mode: string; display_name: string | null }>(
    `SELECT o.id, o.state, o.template_id, o.vars, o.created_at, o.block_reason, o.provider_message_id, o.source_mode,
            c.display_name
     FROM ops.outbound_message o
     LEFT JOIN ops.child_profile c ON c.child_token = o.child_token AND c.site_id = o.site_id
     WHERE o.site_id = $1 AND o.recipient_token = $2 AND o.channel = 'SMS_1TO1'
     ORDER BY o.created_at DESC, o.id DESC LIMIT $3`, [p.siteId, p.contactToken, n]);

  const rows: PersonaMessage[] = [
    ...inbound.rows.map((m): PersonaMessage => ({
      id: m.id, direction: "IN", at: new Date(m.received_at).toISOString(), body: m.body_tokenized,
      state: null, templateId: null, reachedPhone: true, blockReason: null, providerMessageId: m.external_id,
      providerIndex: m.provider_index === null ? null : Number(m.provider_index), sourceMode: m.source_mode,
    })),
    ...outbound.rows.map((o): PersonaMessage => ({
      id: o.id, direction: "OUT", at: new Date(o.created_at).toISOString(), body: safeRender(o.template_id, o.vars, o.display_name),
      state: o.state, templateId: o.template_id, reachedPhone: ON_PHONE.has(o.state), blockReason: o.block_reason,
      providerMessageId: o.provider_message_id, providerIndex: null, sourceMode: o.source_mode,
    })),
  ];
  // uuidv7 ids break a tie in creation order, so a page boundary is stable.
  return rows.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1)).slice(-n);
}

function safeRender(templateId: string, vars: Record<string, unknown>, child: string | null): string | null {
  try { return renderTemplate(templateId, vars, { child }); } catch { return null; }
}

/**
 * The staff roles allowed to look inside a persona phone, read from this endpoint's row in the one
 * access table (src/auth/access.ts) rather than written out again here, so the module and the table
 * cannot disagree about who may read a family's thread. The row's reasoning is on the row: PRD §1.1
 * gives the web console to the coordinator and director and gives the front desk the ramp iPad, and
 * a thread is PHI-adjacent, so it is minimum-necessary rather than "any member of the site".
 */
const MAILBOX_ROW = endpointRow(API.simPhoneMessages)?.auth;
export const MAILBOX_ROLES: readonly StaffRole[] = MAILBOX_ROW?.kind === "session" ? MAILBOX_ROW.roles : [];

export type MailboxResponse =
  | { status: 200; body: { number: string; label: string | null; contactToken: string; messages: PersonaMessage[] } }
  | { status: 401 | 403 | 404; body: { error: string } };

/** The one 404, written once: a number nobody holds and a phone at someone else's site get this object. */
const UNKNOWN_PHONE: MailboxResponse = { status: 404, body: { error: "UNKNOWN_PHONE" } };

/**
 * The whole read path behind the persona-phone endpoint: signed in and active, the phone known, and a
 * membership at the site that phone belongs to in one of the roles the access table names. The site comes
 * from the data, never from the request (DATA-MODEL §5).
 *
 * The three refusals, in the order their answers differ (BUILD-PLAN §4, src/auth/core.ts):
 *  1. no session, or a user disabled or deleted since it was issued → **401**, before the phone is looked
 *     up, so a signed-out probe cannot learn anything by watching which numbers take longer;
 *  2. a number that belongs to nobody **and** a phone at a site this caller is not a member of → the same
 *     **404 `UNKNOWN_PHONE`**, the identical object, so the answer cannot be used to find out which phones
 *     or which sites exist;
 *  3. a member of that phone's own site whose role is not one the row allows → **403 `FORBIDDEN`**: their
 *     own site's existence is not a secret from them, so there is nothing for a 404 to hide here.
 */
export async function personaMailboxResponse(db: Exec, a: { number: string; pepper: string; userId: string | undefined; limit?: number; gateway: IdentityGateway }): Promise<MailboxResponse> {
  const user = await getActiveUser(db, a.userId);
  if (!user) return { status: 401, body: { error: "UNAUTHENTICATED" } };
  const persona = await resolvePersona(db, { number: a.number, pepper: a.pepper, gateway: a.gateway });
  if (!persona) return UNKNOWN_PHONE;
  try {
    await requireSiteAccess(db, user.id, persona.siteId, MAILBOX_ROLES);
  } catch (e) {
    // Disabled between the two reads: signed out, not refused a role.
    if (e instanceof Unauthenticated) return { status: 401, body: { error: "UNAUTHENTICATED" } };
    if (e instanceof SiteNotFound) return UNKNOWN_PHONE;
    if (e instanceof Forbidden) return { status: 403, body: { error: "FORBIDDEN" } };
    throw e;
  }
  const messages = await personaMessages(db, persona, clampLimit(a.limit));
  return { status: 200, body: { number: persona.number, label: persona.label, contactToken: persona.contactToken, messages } };
}
