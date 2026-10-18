/**
 * Consent ledger (MSG-04, PRD §10 l.218/l.915, CQ-04 "honor any revocation immediately; 10-year ledger").
 *
 * identity.consent_event is append-only and is the record of what the family asked for. ops.suppression is a
 * projection of it that the outbox reads at send time (outbox/policy.activeSuppression). Because the
 * projection is recomputed from the newest event every time, a webhook that arrives out of order cannot
 * re-suppress a contact who has since restarted, and a repeated STOP cannot add a second suppression
 * (MSG-04 acceptance: "STOP -> suppression <= 1 event").
 *
 * Note for P2 (ADR-011): identity writes belong to the IdentityGateway role. In P1 they run on the caller's
 * transaction so the event commits with the message that evidences it; splitting the connection later means
 * passing an identity Exec here, nothing else.
 */
import { uuidv7 } from "uuidv7";
import type { IdentityGateway } from "@/modules/identity/gateway";
import type { Exec } from "@/db/exec";
import { OPT_OUT_KINDS, OPT_OUT_SCOPES, type SuppressionScope } from "@/modules/outbox/policy";
import { consentFollowUp } from "@/ui/copy";

export type ConsentKind = "OPT_IN" | "START" | "STOP" | "NL_OPT_OUT" | "HELP" | "PERMANENT_TEST_OPT_OUT";

/**
 * Carrier keywords, matched on the whole body only (case and punctuation insensitive).
 * CANCEL and END are deliberately NOT opt-out words here: in a transport service "cancel" is a ride request,
 * and treating it as an opt-out would silently stop a family's ride updates. A family who means to opt out
 * still has STOP, STOPALL, UNSUBSCRIBE, QUIT and plain English (below).
 */
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "quit", "optout", "revoke"]);
const START_WORDS = new Set(["start", "unstop", "subscribe", "resubscribe"]);
const HELP_WORDS = new Set(["help", "info"]);

/** Plain-English opt-out (PRD §10: honored immediately, then confirmed by phone). Kept narrow on purpose. */
const NL_OPT_OUT_PATTERNS = [
  /\bstop[a-z\s]{0,16}\b(text|texts|texting|message|messages|messaging|sms)\b/,
  /\b(?:no more|dont want|do not want|don't want)\b[a-z\s]{0,16}\b(text|texts|messages|sms)\b/,
  /\b(?:dont|do not|don't)\s+(?:text|message)\s+(?:me|us)\b/,
  /\b(?:take|remove)\s+(?:me|us)\s+off\b/,
  /\bopt\s+(?:me\s+|us\s+)?out\b/,
  /\bunsubscribe\b/,
];

/** The consent meaning of an inbound body, or null when it is an ordinary message. */
export function classifyConsentKeyword(body: string): ConsentKind | null {
  const text = body.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (!text.includes(" ")) {
    if (STOP_WORDS.has(text)) return "STOP";
    if (START_WORDS.has(text)) return "START";
    if (HELP_WORDS.has(text)) return "HELP";
  }
  if (NL_OPT_OUT_PATTERNS.some((re) => re.test(text))) return "NL_OPT_OUT";
  return null;
}

/**
 * The scope this revocation projects into ops.suppression, taken from outbox/policy.OPT_OUT_SCOPES so the
 * ledger and the send-time check can never disagree: a carrier STOP stops everything and a safety message
 * falls back to a staff voice task, while a plain-English opt-out "suppresses non-safety" (PRD l.218 §2.6).
 */
function suppressionScope(kind: ConsentKind): { scope: SuppressionScope; permanentTest: boolean } | null {
  const scope = OPT_OUT_SCOPES[kind];
  return scope ? { scope, permanentTest: kind === "PERMANENT_TEST_OPT_OUT" } : null;
}

/**
 * The staff task a revocation opens. A coordinator reads it, so the words live with the rest of the
 * app's copy in src/ui/copy.ts (`consentFollowUp`); which kind gets a task is the decision here.
 * A kind absent from this table opens no task (START, HELP, PERMANENT_TEST_OPT_OUT).
 */
const FOLLOW_UP: Partial<Record<ConsentKind, { summary: string; nextStep: string; predicate: string }>> = consentFollowUp;

export type ConsentResult = {
  consentEventId: string;
  kind: ConsentKind;
  suppression: "added" | "lifted" | "unchanged";
  taskId: string | null;
};

/**
 * Append one consent event and bring ops.suppression in line with the newest event for this contact+channel.
 * Idempotency is the caller's job: the inbound handler only calls this for a message it just inserted.
 */
export async function recordConsent(tx: Exec, gateway: IdentityGateway, a: {
  siteId: string; contactToken: string; channel: string; kind: ConsentKind;
  at: Date; evidenceMessageId?: string | null; by: string;
}): Promise<ConsentResult> {
  /*
   * THE LEDGER IS THE GATEWAY'S, THE PROJECTION IS OURS (S1-6).
   *
   * The append and the read-back were two statements on `tx` — the webhook's own `ops`
   * transaction, on the application connection — and `app_rw` has no privilege on `identity` at
   * all (src/db/schema.ts:104). So on a deployment with the real role split a family texting STOP
   * got `permission denied for schema identity` and nothing was recorded anywhere, which is the
   * worst version of this bug: a carrier opt-out that silently did not take.
   *
   * One gateway call, because this needs the newest event *after* its own append and the two must
   * not be able to disagree about what that is. Everything below is unchanged and is all `ops`:
   * `ops.suppression` is the projection the drain actually enforces at send time
   * (`policy.activeSuppression`), so what a STOP *does* is a real row in this transaction whatever
   * the ledger behind it is.
   */
  const { consentEventId, newest } = await gateway.appendConsent({
    siteId: a.siteId,
    contactToken: a.contactToken,
    channel: a.channel,
    kind: a.kind,
    at: a.at,
    evidenceMessageId: a.evidenceMessageId ?? null,
  });
  const result: ConsentResult = { consentEventId, kind: a.kind, suppression: "unchanged", taskId: null };
  if (!newest) return result;

  const active = await tx.query<{ id: string }>(
    "SELECT id FROM ops.suppression WHERE site_id = $1 AND contact_token = $2 AND lifted_at IS NULL", [a.siteId, a.contactToken]);
  const scope = OPT_OUT_KINDS.has(newest.kind) ? suppressionScope(newest.kind as ConsentKind) : null;

  if (scope) {
    if (!active.rows.length) {
      await tx.query(
        `INSERT INTO ops.suppression (id, site_id, contact_token, scope, permanent_test, consent_event_id, created_by, updated_by, source_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'SIMULATED')`,
        [uuidv7(), a.siteId, a.contactToken, scope.scope, scope.permanentTest, newest.id, a.by]);
      result.suppression = "added";
    }
  } else if (active.rows.length) {
    // A re-subscribe lifts an opt-out but never a permanent test opt-out (demo reset keeps those, PRD l.1330).
    const lifted = await tx.query<{ id: string }>(
      `UPDATE ops.suppression SET lifted_at = $4, version = version + 1, updated_at = now(), updated_by = $5
       WHERE site_id = $1 AND contact_token = $2 AND lifted_at IS NULL AND permanent_test = false AND scope = ANY($3::text[])
       RETURNING id`,
      [a.siteId, a.contactToken, ["ALL", "ALL_NON_SAFETY"], newest.at, a.by]);
    if (lifted.rows.length) result.suppression = "lifted";
  }

  const follow = result.suppression === "added" ? FOLLOW_UP[a.kind] : undefined;
  if (follow) {
    result.taskId = uuidv7();
    await tx.query(
      `INSERT INTO ops.task (id, site_id, category, severity, summary, next_step, completion_predicate, created_by, updated_by, source_mode)
       VALUES ($1,$2,'CONSENT_OPT_OUT','AMBER',$3,$4,$5,$6,$6,'SIMULATED')`,
      [result.taskId, a.siteId, follow.summary, follow.nextStep, follow.predicate, a.by]);
  }
  return result;
}
