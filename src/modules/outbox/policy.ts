import type { Exec } from "@/db/exec";
import { dbIdentityGateway, type IdentityGateway } from "@/modules/identity/gateway";

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

/**
 * How a family is reached about a ride, written once (PRD §10.1 "Fan-out 1:1 broadcast", §10.3
 * "recipients computed at send time").
 *
 * Every family-facing SMS in the app carries these three values — the agent's `send_followup`
 * (run/exec/followup.ts `AUDIENCE_RULES`) and the deterministic ETA notice
 * (messaging/eta-notice.ts) are the two callers — so the purpose a suppression is checked against
 * and the rule an audit row records cannot differ between the two paths that produce the same
 * text on the same phone.
 */
export const FAMILY_SMS = {
  channel: "SMS_1TO1",
  purpose: "TRANSPORT_UPDATE",
  recipientRule: "guardian_of_child",
} as const;

/**
 * The contacts §6.4 authorizes to be told about this child on this channel, in token order.
 *
 * One query, two callers, and the reason it lives beside `childAuthorized` rather than in either
 * of them: this is the *same* authorization the drainer re-checks per contact at send time, read
 * earlier so that a message is only queued for somebody who may have it. A caller that resolved
 * recipients its own way would be a second answer to a question §6.4 has exactly one answer to.
 *
 * `at` defaults to the database's own `now()`, which is what a send-time check wants; a caller
 * reading the window as of a message's arrival time passes that instant instead (PRD §6.4 reads
 * the validity window at arrival).
 */
export async function authorizedContactsForChild(
  db: Exec,
  a: { siteId: string; childToken: string; channel?: string; at?: Date | null },
): Promise<string[]> {
  const r = await db.query<{ contact_token: string }>(
    `SELECT DISTINCT contact_token FROM ops.contact_authorization
     WHERE site_id = $1 AND child_token = $2 AND channel = $3
       AND scope = 'RECEIVE_TRANSPORT_UPDATES'
       AND valid_from <= COALESCE($4::timestamptz, now())
       AND (valid_to IS NULL OR valid_to > COALESCE($4::timestamptz, now()))
     ORDER BY contact_token`,
    [a.siteId, a.childToken, a.channel ?? FAMILY_SMS.channel, a.at?.toISOString() ?? null],
  );
  return r.rows.map((row) => row.contact_token);
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
 * The egress door, over the IdentityGateway (S1-6; Firia's ruling 2, 2026-10-18 2:48 AM ET).
 *
 * This module used to hold the three identity statements itself and be handed a connection that
 * could run them. In P1 it was handed `getNeonDb()` — `outbox/deps.ts` built it that way — and
 * `app_rw` has no SELECT on `identity` (src/db/schema.ts:104), so the drain's own consent check
 * was `permission denied for schema identity` on any real deployment. It is the same bug S1-0
 * fixed on the Family texts page, on the path that decides whether a family may be texted at all.
 *
 * The statements are not gone: they are `dbIdentityGateway.egressFacts`, unchanged, and the
 * fixture gateway answers the same questions from the seed's own rows. What this function keeps is
 * the part that was always its own — the *policy*: which purposes a guardian's two flags permit,
 * and which opt-out scopes suppress which purpose.
 *
 * The dispatcher branch is what makes an egress to a provider's dispatcher possible at all (B-08
 * §11.2 `request_provider_capability`): the person has to still be on file **for this site**, and
 * their consent is then checked exactly like anyone else's, because a dispatcher can text STOP
 * too. A therapist is checked against the same table by the *ops* side instead
 * (`therapistAuthorized`: they must still own a session for that child), which is why that kind
 * needs no identity row of its own here.
 */
export function gatewayRecipientAuthorizer(gateway: IdentityGateway): RecipientAuthorizer {
  return {
    async authorize({ siteId, recipientToken, purpose, channel, at, kind }) {
      const facts = await gateway.egressFacts({ siteId, recipientToken, kind, channel, at });
      if (!facts.onFile) {
        return {
          ok: false,
          reason:
            kind === "dispatcher"
              ? "recipient not found or other site"
              : "recipient not found, revoked, expired or other site",
        };
      }
      if (kind === "guardian") {
        const c = facts.guardian;
        if (!c) return { ok: false, reason: "recipient not found, revoked, expired or other site" };
        if (!(c.canReceiveUpdates || (SAFETY_PURPOSES.has(purpose) && c.isEmergency))) {
          return { ok: false, reason: "recipient not authorized for this purpose" };
        }
      }
      // Consent at send time: the latest consent event for this contact on this channel wins.
      const k = facts.latestConsentKind;
      // PRD l.218 §2.6: an opt-out "suppresses non-safety", so this check is scoped by purpose and never
      // stricter than the ledger projection the drainer reads (activeSuppression). A safety purpose is
      // blocked only by a carrier STOP (scope ALL), where it "falls back to staff voice task" instead.
      const withdrawn = k ? OPT_OUT_SCOPES[k] : undefined;
      if (withdrawn && suppressesPurpose(withdrawn, purpose)) return { ok: false, reason: `consent withdrawn (${k})` };
      return { ok: true };
    },
  };
}

/**
 * The deployed shape, for the suites that prove the SQL still matches the schema: the same
 * authorizer over `dbIdentityGateway`, which must be handed a connection running as
 * `identity_gateway` (0001_roles) and never the application's.
 */
export function dbRecipientAuthorizer(identityDb: Exec): RecipientAuthorizer {
  return gatewayRecipientAuthorizer(dbIdentityGateway(identityDb, { pepper: "" }));
}

/** Active suppression for this contact and purpose (ops.suppression, written from consent events). */
export async function activeSuppression(db: Exec, a: { siteId: string; recipientToken: string; purpose: string }) {
  const r = await db.query<{ scope: string }>(
    `SELECT scope FROM ops.suppression WHERE site_id = $1 AND contact_token = $2 AND lifted_at IS NULL`, [a.siteId, a.recipientToken]);
  return r.rows.find((s) => (s.scope === "ALL" || s.scope === "ALL_NON_SAFETY") && suppressesPurpose(s.scope, a.purpose))?.scope ?? null;
}
