import type { Exec } from "@/db/exec";

/** Purposes that bypass ALL_NON_SAFETY suppression (PRD §10). Scope ALL still blocks them. */
export const SAFETY_PURPOSES = new Set(["SAFETY_ALERT", "CHILD_NOT_RECEIVED"]);

export type SuppressionScope = "ALL" | "ALL_NON_SAFETY";

/**
 * What each opt-out kind suppresses on that channel until a later START / OPT_IN. The PRD distinguishes the
 * two revocations (PRD l.218 §2.6: "NL opt-out classifier (honored immediately; suppresses non-safety;
 * AMBER confirm-by-phone task); safety messages fall back to staff voice task"), so:
 *  - plain-English opt-out ⇒ ALL_NON_SAFETY: ride updates stop, a safety purpose still goes out by text
 *    while staff confirm by phone (the AMBER task raised by the consent ledger);
 *  - carrier STOP ⇒ ALL: the keyword is a channel-level revocation the carrier itself enforces, so nothing
 *    more is texted and a safety message falls back to the staff voice task instead.
 * This object is the single source of that mapping; messaging/consent projects ops.suppression from it.
 */
export const OPT_OUT_SCOPES: Readonly<Record<string, SuppressionScope>> = {
  STOP: "ALL",
  NL_OPT_OUT: "ALL_NON_SAFETY",
  PERMANENT_TEST_OPT_OUT: "ALL",
};

/** Consent kinds that withdraw consent. Derived from OPT_OUT_SCOPES so the two can never drift apart. */
export const OPT_OUT_KINDS: ReadonlySet<string> = new Set(Object.keys(OPT_OUT_SCOPES));

/** Does a suppression of this scope block this purpose? ALL_NON_SAFETY lets the safety purposes through. */
export function suppressesPurpose(scope: SuppressionScope, purpose: string): boolean {
  return scope === "ALL" || !SAFETY_PURPOSES.has(purpose);
}

/** Per-child authorization (PRD §6.4) at send time: contact × child × scope × channel × validity window. */
export async function childAuthorized(db: Exec, a: { siteId: string; recipientToken: string; childToken: string; channel: string; purpose: string; at: Date }) {
  const scopes = SAFETY_PURPOSES.has(a.purpose) ? ["RECEIVE_TRANSPORT_UPDATES", "RECEIVE_CHILD"] : ["RECEIVE_TRANSPORT_UPDATES"];
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM ops.contact_authorization WHERE site_id = $1 AND contact_token = $2 AND child_token = $3
       AND channel = $4 AND scope::text = ANY($5::text[]) AND valid_from <= $6 AND (valid_to IS NULL OR valid_to > $6)`,
    [a.siteId, a.recipientToken, a.childToken, a.channel, scopes, a.at.toISOString()]);
  return r.rows[0].n > 0;
}

export type RecipientKind = "guardian" | "therapist" | "dispatcher";
/**
 * The recipient's actual type, from the data, never from the recipient_rule string (Veri #8 follow-up):
 * a token that is a therapist's person_token at this site is a therapist, one that is a provider's
 * `dispatcher_person_token` at this site is that provider's dispatcher (PRD §10.1 "Dispatcher links";
 * B-08 §11.2 `request_provider_capability`), and anything else is checked as a guardian contact.
 *
 * Both lookups are **ops** reads: the token is matched against the operational row that says whose
 * contact point it is, and only then does the authorizer ask identity about the person behind it.
 */
export async function recipientKind(db: Exec, a: { siteId: string; recipientToken: string }): Promise<RecipientKind> {
  const r = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.therapist WHERE site_id = $1 AND person_token = $2", [a.siteId, a.recipientToken]);
  if (r.rows[0].n > 0) return "therapist";
  const d = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.provider WHERE site_id = $1 AND dispatcher_person_token = $2", [a.siteId, a.recipientToken]);
  return d.rows[0].n > 0 ? "dispatcher" : "guardian";
}

/** Therapist ↔ child at send time: the therapist must still own a non-canceled session for this child (that session, if given). */
export async function therapistAuthorized(db: Exec, a: { siteId: string; personToken: string; childToken: string; therapySessionId: string | null }) {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM ops.therapy_session s JOIN ops.therapist t ON t.id = s.therapist_id
     WHERE s.site_id = $1 AND t.person_token = $2 AND s.child_token = $3 AND s.status <> 'CANCELED'
       AND ($4::uuid IS NULL OR s.id = $4::uuid)`, [a.siteId, a.personToken, a.childToken, a.therapySessionId]);
  return r.rows[0].n > 0;
}

/** IdentityGateway seam: is this recipient token currently allowed to get this purpose? ops never reads identity directly. */
export interface RecipientAuthorizer {
  authorize(a: { siteId: string; recipientToken: string; purpose: string; channel: string; at: Date; kind: RecipientKind }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * Reads identity.guardian_contact, or — for a therapist or a provider's dispatcher —
 * identity.external_person_identity. In deployed envs it runs on the identity_gateway connection
 * (0001_roles).
 *
 * The dispatcher branch is what makes an egress to `identity.external_person_identity` possible at
 * all (B-08 §11.2 `request_provider_capability`): the person has to still be on file **for this
 * site**, and their consent is then checked exactly like anyone else's, because a dispatcher can
 * text STOP too. A therapist is checked against the same table by the *ops* side instead
 * (`therapistAuthorized`: they must still own a session for that child), which is why that kind
 * needs no identity row of its own here.
 */
export function dbRecipientAuthorizer(identityDb: Exec): RecipientAuthorizer {
  return {
    async authorize({ siteId, recipientToken, purpose, channel, at, kind }) {
      if (kind === "dispatcher") {
        const p = await identityDb.query<{ n: number }>(
          "SELECT count(*)::int n FROM identity.external_person_identity WHERE person_token = $1 AND site_id = $2",
          [recipientToken, siteId]);
        if (p.rows[0].n === 0) return { ok: false, reason: "recipient not found or other site" };
      }
      if (kind === "guardian") {
      const r = await identityDb.query<{ ok_updates: boolean; ok_emergency: boolean }>(
        `SELECT can_receive_updates ok_updates, is_emergency ok_emergency FROM identity.guardian_contact
         WHERE contact_token = $1 AND site_id = $2 AND revoked_at IS NULL
           AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)`, [recipientToken, siteId, at.toISOString()]);
      const c = r.rows[0];
      if (!c) return { ok: false, reason: "recipient not found, revoked, expired or other site" };
      if (!(c.ok_updates || (SAFETY_PURPOSES.has(purpose) && c.ok_emergency))) return { ok: false, reason: "recipient not authorized for this purpose" };
      }
      // Consent at send time: the latest consent event for this contact on this channel wins (append-only log).
      const ev = await identityDb.query<{ kind: string }>(
        `SELECT kind FROM identity.consent_event WHERE contact_token = $1 AND site_id = $2 AND channel = $3 AND at <= $4
         ORDER BY at DESC, id DESC LIMIT 1`, [recipientToken, siteId, channel, at.toISOString()]);
      const k = ev.rows[0]?.kind;
      // PRD l.218 §2.6: an opt-out "suppresses non-safety", so this check is scoped by purpose and never
      // stricter than the ledger projection the drainer reads (activeSuppression). A safety purpose is
      // blocked only by a carrier STOP (scope ALL), where it "falls back to staff voice task" instead.
      const withdrawn = k ? OPT_OUT_SCOPES[k] : undefined;
      if (withdrawn && suppressesPurpose(withdrawn, purpose)) return { ok: false, reason: `consent withdrawn (${k})` };
      return { ok: true };
    },
  };
}

/** Active suppression for this contact and purpose (ops.suppression, written from consent events). */
export async function activeSuppression(db: Exec, a: { siteId: string; recipientToken: string; purpose: string }) {
  const r = await db.query<{ scope: string }>(
    `SELECT scope FROM ops.suppression WHERE site_id = $1 AND contact_token = $2 AND lifted_at IS NULL`, [a.siteId, a.recipientToken]);
  return r.rows.find((s) => (s.scope === "ALL" || s.scope === "ALL_NON_SAFETY") && suppressesPurpose(s.scope, a.purpose))?.scope ?? null;
}
