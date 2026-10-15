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
import { Forbidden, getActiveUser, requireSiteRole, type StaffRole } from "@/auth/core";
import type { Exec } from "@/db/exec";
import { phoneHmac } from "@/modules/identity/phone";
import type { OutboxState } from "@/modules/outbox/outbox";
import { isSimPersonaNumber, parseSimNumber, simPersonaLabel } from "./sim-numbers";
import { renderTemplate } from "./templates";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

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
  reachedPhone: boolean;
  blockReason: string | null;
  providerMessageId: string | null;
  providerIndex: number | null;
  sourceMode: string;
};

/** Resolve the phone to its contact before any message is read, so authorization can run on the site first. */
export async function resolvePersona(db: Exec, a: { number: string; pepper: string }): Promise<Persona | null> {
  const number = parseSimNumber(a.number);
  if (!number || !isSimPersonaNumber(number)) return null;
  const r = await db.query<{ contact_token: string; family_group_id: string; site_id: string }>(
    `SELECT contact_token, family_group_id, site_id FROM identity.guardian_contact
     WHERE phone_hmac = $1 AND revoked_at IS NULL ORDER BY valid_from DESC LIMIT 1`, [phoneHmac(number, a.pepper)]);
  const row = r.rows[0];
  return row ? { number, label: simPersonaLabel(number), contactToken: row.contact_token, familyGroupId: row.family_group_id, siteId: row.site_id } : null;
}

export async function personaMessages(db: Exec, p: Persona, limit = DEFAULT_LIMIT): Promise<PersonaMessage[]> {
  const n = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
  const inbound = await db.query<{ id: string; body_tokenized: string; received_at: Date; provider_index: string | null; source_mode: string; external_id: string }>(
    `SELECT m.id, m.body_tokenized, m.received_at, m.provider_index, m.source_mode, m.external_id
     FROM ops.message m JOIN ops.conversation_thread t ON t.id = m.thread_id
     WHERE m.site_id = $1 AND t.counterparty_token = $2 AND m.direction = 'IN' AND m.is_own_echo = false
     ORDER BY m.received_at DESC, m.id DESC LIMIT $3`, [p.siteId, p.contactToken, n]);
  const outbound = await db.query<{ id: string; state: string; template_id: string; vars: Record<string, unknown>; created_at: Date; block_reason: string | null; provider_message_id: string | null; source_mode: string }>(
    `SELECT id, state, template_id, vars, created_at, block_reason, provider_message_id, source_mode
     FROM ops.outbound_message WHERE site_id = $1 AND recipient_token = $2 AND channel = 'SMS_1TO1'
     ORDER BY created_at DESC, id DESC LIMIT $3`, [p.siteId, p.contactToken, n]);

  const rows: PersonaMessage[] = [
    ...inbound.rows.map((m): PersonaMessage => ({
      id: m.id, direction: "IN", at: new Date(m.received_at).toISOString(), body: m.body_tokenized,
      state: null, reachedPhone: true, blockReason: null, providerMessageId: m.external_id,
      providerIndex: m.provider_index === null ? null : Number(m.provider_index), sourceMode: m.source_mode,
    })),
    ...outbound.rows.map((o): PersonaMessage => ({
      id: o.id, direction: "OUT", at: new Date(o.created_at).toISOString(), body: safeRender(o.template_id, o.vars),
      state: o.state, reachedPhone: ON_PHONE.has(o.state), blockReason: o.block_reason,
      providerMessageId: o.provider_message_id, providerIndex: null, sourceMode: o.source_mode,
    })),
  ];
  // uuidv7 ids break a tie in creation order, so a page boundary is stable.
  return rows.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1)).slice(-n);
}

function safeRender(templateId: string, vars: Record<string, unknown>): string | null {
  try { return renderTemplate(templateId, vars); } catch { return null; }
}

/** Staff roles allowed to look inside a persona phone: any member of that site (it is a demo instrument). */
export const MAILBOX_ROLES: StaffRole[] = ["DIRECTOR", "COORDINATOR", "FRONT_DESK"];

export type MailboxResponse =
  | { status: 200; body: { number: string; label: string | null; contactToken: string; messages: PersonaMessage[] } }
  | { status: 401 | 403 | 404; body: { error: string } };

/**
 * The whole read path behind GET /api/sim/phones/[number]/messages: signed in, phone known, and a membership
 * at the site that phone belongs to. The site comes from the data, never from the request (DATA-MODEL §5).
 */
export async function personaMailboxResponse(db: Exec, a: { number: string; pepper: string; userId: string | undefined; limit?: number }): Promise<MailboxResponse> {
  const user = await getActiveUser(db, a.userId);
  if (!user) return { status: 401, body: { error: "UNAUTHENTICATED" } };
  const persona = await resolvePersona(db, { number: a.number, pepper: a.pepper });
  if (!persona) return { status: 404, body: { error: "UNKNOWN_PHONE" } };
  try {
    await requireSiteRole(db, user.id, persona.siteId, MAILBOX_ROLES);
  } catch (e) {
    if (e instanceof Forbidden) return { status: 403, body: { error: "FORBIDDEN" } };
    throw e;
  }
  const messages = await personaMessages(db, persona, a.limit ?? DEFAULT_LIMIT);
  return { status: 200, body: { number: persona.number, label: persona.label, contactToken: persona.contactToken, messages } };
}
