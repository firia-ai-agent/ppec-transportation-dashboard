/**
 * THE IDENTITY GATEWAY — the only way `ops` code is allowed to learn anything from `identity`.
 *
 * ## Why this file exists at all
 *
 * `identity` is a restricted schema. `0001_roles.sql` says it in SQL and src/db/schema.ts:104
 * says it in prose: "App role `app_rw` gets NO select on these; only `identity_gateway` role
 * (used by IdentityGateway) does." `src/db/migrations.test.ts:108` asserts it on every engine
 * the suites run on.
 *
 * So a query against `identity.*` sent down the ordinary application connection does not return
 * a wrong answer — it raises `permission denied for schema identity` and takes the screen with
 * it. That is exactly what happened to Family texts on the preview (12:13 AM ET): the page
 * called `threadFor` → `resolvePersona`, which read `identity.guardian_contact` on `getNeonDb()`,
 * and the coordinator got "the message log could not be read". `agent/staff-alert.ts` had the
 * same join in the "For you" tab's alert query.
 *
 * The fix is not a grant and not a migration. It is the seam the architecture already names:
 * ops asks a **gateway** for the one fact it needs, and the gateway is the only thing that knows
 * whether that fact lives behind a restricted schema, a vault, or a KMS key. `outbox/policy.ts`
 * has had the same shape since B-08 (`RecipientAuthorizer`, "ops never reads identity
 * directly"); this is that pattern, for the two lookups the staff screens need.
 *
 * ## The two implementations, and which one runs
 *
 *  - `dbIdentityGateway(identityDb)` — the real SQL, the same statements that used to sit in
 *    `mailbox.ts` and `staff-alert.ts`. It must be handed a connection whose role is
 *    `identity_gateway`. In P1 there is no such connection (one `DATABASE_URL`, one role,
 *    ADR-009), so **nothing in src/app wires it**; the DB suites hand it PGlite, where it proves
 *    the statements still match the schema.
 *  - `syntheticIdentityGateway()` — P1. This deployment runs on synthetic data only
 *    (`APP_DATA_CLASS=SYNTHETIC`, ADR-015, enforced at boot by src/lib/env.ts), and every
 *    identity row in it was written by the demo seed from `fixtures/standard.ts`. So the gateway
 *    answers from the same fixture the seed inserted: the same contact tokens
 *    (`demoId(KIND.contact, …)`), the same `synLegalName`, the same phone HMACs. It is not a
 *    stand-in for the vault — in this data class it *is* the vault's contents, which is why it
 *    can be exact rather than approximate.
 *  - `unwiredIdentityGateway()` — anything else. It answers "I don't know" rather than throwing,
 *    because the caller's fallback (an unnamed adult, a thread read by family group) is a
 *    smaller harm than a 500 on a coordinator's screen, and because P2 is where the real
 *    connection arrives (B-19: KMS CMK per data class, RLS).
 *
 * Nothing here is a privilege decision: the gateway answers *who someone is*, never *who may
 * read it*. The caller has already been through `requireSiteAccess`.
 */
import { uuidv7 } from "uuidv7";
import { isSyntheticDemo } from "@/lib/env";
import type { Exec } from "@/db/exec";
import {
  CHILDREN,
  DEMO_SITE_ID,
  EXTERNAL_PEOPLE,
  FAMILIES,
  KIND,
  demoId,
  synLegalName,
} from "@/modules/demo/fixtures/standard";
import { normalizeE164, phoneHmac } from "./phone";

/** One guardian, as a staff screen needs them: the token ops joins on, and the name to print. */
export type GuardianContact = {
  readonly contactToken: string;
  readonly familyGroupId: string;
  readonly siteId: string;
  /** The stored legal name, marker and all ("Dara O. (SYN)"). `display-name.ts` shortens it. */
  readonly legalName: string;
};

/**
 * What ops may ask about a person. Two questions, because two screens ask them:
 *
 *  - the persona phone panel starts from a number and needs the contact token the message rows
 *    are keyed by (`mailbox.resolvePersona`);
 *  - the "needs a person" alert starts from a thread's `counterparty_token` and needs a name to
 *    put in the card (`agent/staff-alert.openAssistantAlerts`).
 *
 * Deliberately not wider. A gateway with a general `query` on it is the app connection again
 * with one more hop.
 */
export interface IdentityGateway {
  /** The guardian holding this phone, or null. The number is E.164 or anything `normalizeE164` takes. */
  contactForPhone(number: string): Promise<GuardianContact | null>;
  /** Stored legal names for these contact tokens. Missing tokens are simply absent from the map. */
  namesForContacts(contactTokens: readonly string[]): Promise<ReadonlyMap<string, string>>;

  /* ── S1-6: the drain, the webhook and the agent's run path ask these ── */

  /**
   * Who sent a text, from the blind index on the number — a guardian first, then a therapist or a
   * provider's dispatcher. The webhook (`messaging/inbound.resolveSender`) and the agent's read
   * step (`run/exec/reads.contactForHmac`) both asked this, in the same two statements, on the
   * app connection.
   */
  senderForPhoneHmac(a: {
    readonly siteId: string;
    readonly phoneHmac: string;
    readonly at: Date;
  }): Promise<IdentityPerson | null>;

  /**
   * Where a message to this recipient goes: the family group whose thread it belongs in, and the
   * blind index the provider addresses it by. Addressing only — never a number, and never a
   * permission (`messaging/sim-provider.recipient`).
   */
  routeForRecipient(a: {
    readonly siteId: string;
    readonly recipientToken: string;
  }): Promise<RecipientRoute>;

  /**
   * The egress door's own questions, at send time (`outbox/policy.dbRecipientAuthorizer`): is this
   * person still on file at this site, what may a guardian be sent, and what is the newest consent
   * event on this channel. One call, because the door asks all three about one recipient and a
   * gateway that answered them one at a time would be three round trips per message.
   */
  egressFacts(a: {
    readonly siteId: string;
    readonly recipientToken: string;
    readonly kind: "guardian" | "therapist" | "dispatcher";
    readonly channel: string;
    readonly at: Date;
  }): Promise<EgressFacts>;

  /**
   * Append one consent event and answer the newest one for this contact and channel.
   *
   * The only question here that *writes*, and it is a write to `identity.consent_event` — the
   * append-only record of what a family asked for (`messaging/consent.recordConsent`). It is one
   * call rather than an append and a read because the caller needs the newest event *after* its
   * own, and the two must not be able to disagree.
   *
   * What a STOP durably does is still an `ops` row: `consent.recordConsent` projects the newest
   * event into `ops.suppression`, which is the table the drain enforces (`activeSuppression`).
   * See `syntheticIdentityGateway` for what that means in this data class.
   */
  appendConsent(a: {
    readonly siteId: string;
    readonly contactToken: string;
    readonly channel: string;
    readonly kind: string;
    readonly at: Date;
    readonly evidenceMessageId: string | null;
  }): Promise<{ readonly consentEventId: string; readonly newest: ConsentEvent | null }>;

  /**
   * The blind index on a person's number, for a check that compares two indexes rather than two
   * numbers (`run/exec/capability.providerEvidence`: was this text sent from the dispatcher
   * contact point of the van's own provider?). Null for a person this site has no row for.
   */
  phoneHmacForPerson(a: {
    readonly siteId: string;
    readonly personToken: string;
  }): Promise<string | null>;
}

/** A person the centre can address: a guardian contact, or a therapist / provider dispatcher. */
export type IdentityPerson = {
  readonly contactToken: string;
  /** The family whose thread this is, or null for a therapist or dispatcher — they have none. */
  readonly familyGroupId: string | null;
};

/** Addressing for one outbound message. Both halves may be null for a recipient nobody knows. */
export type RecipientRoute = {
  readonly familyGroupId: string | null;
  readonly phoneHmac: string | null;
};

/** One row of the append-only consent ledger. */
export type ConsentEvent = { readonly id: string; readonly kind: string; readonly at: Date };

/**
 * What the egress door learns about a recipient.
 *
 * `onFile` is the answer to "does this site still have a row for this person, of this kind" — and
 * it is `true` for a therapist with no further question, because the *ops* side has already
 * checked that one (`policy.therapistAuthorized`: they must still own a session for the child).
 * `guardian` is present only for a guardian, because the two flags are columns of that row.
 */
export type EgressFacts = {
  readonly onFile: boolean;
  readonly guardian: { readonly canReceiveUpdates: boolean; readonly isEmergency: boolean } | null;
  readonly latestConsentKind: string | null;
};

/**
 * The deployed gateway: the identity SQL, in one file.
 *
 * `identityDb` must be a connection running as `identity_gateway` (0001_roles). Handing it the
 * application connection re-creates the bug this module exists to fix, which is why no call site
 * in `src/app` passes `getNeonDb()` to it and `identity-off-the-app-connection.test.ts` holds
 * that line.
 *
 * `pepper` is `HMAC_PEPPER`: the blind index on `guardian_contact.phone_hmac` is how a number is
 * matched without a plaintext number ever being compared (DATA-MODEL §1).
 */
export function dbIdentityGateway(identityDb: Exec, a: { pepper: string }): IdentityGateway {
  return {
    async contactForPhone(number) {
      const e164 = normalizeE164(number);
      if (!e164) return null;
      const r = await identityDb.query<{ contact_token: string; family_group_id: string; site_id: string; legal_name: string }>(
        `SELECT contact_token, family_group_id, site_id, legal_name FROM identity.guardian_contact
         WHERE phone_hmac = $1 AND revoked_at IS NULL ORDER BY valid_from DESC LIMIT 1`,
        [phoneHmac(e164, a.pepper)],
      );
      const row = r.rows[0];
      return row
        ? { contactToken: row.contact_token, familyGroupId: row.family_group_id, siteId: row.site_id, legalName: row.legal_name }
        : null;
    },
    async namesForContacts(contactTokens) {
      const tokens = [...new Set(contactTokens.filter((t) => t))];
      if (tokens.length === 0) return new Map();
      const r = await identityDb.query<{ contact_token: string; legal_name: string }>(
        "SELECT contact_token, legal_name FROM identity.guardian_contact WHERE contact_token = ANY($1::uuid[])",
        [tokens],
      );
      return new Map(r.rows.map((row) => [row.contact_token, row.legal_name]));
    },

    /*
     * The five statements S1-6 moved here, verbatim from the modules that held them (Firia's
     * ruling 2, 2026-10-18 2:48 AM ET). Same columns, same predicates, same ordering — the move
     * is about which connection they run on, and `identity-off-the-app-connection.test.ts` runs
     * every one of them against the real migrations so the SQL is still proved.
     */
    async senderForPhoneHmac({ siteId, phoneHmac: hmac, at }) {
      const g = await identityDb.query<{ contact_token: string; family_group_id: string }>(
        `SELECT contact_token, family_group_id FROM identity.guardian_contact
         WHERE phone_hmac = $1 AND site_id = $2 AND revoked_at IS NULL
           AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
         ORDER BY valid_from DESC LIMIT 1`,
        [hmac, siteId, at.toISOString()],
      );
      if (g.rows[0]) {
        return { contactToken: g.rows[0].contact_token, familyGroupId: g.rows[0].family_group_id };
      }
      const p = await identityDb.query<{ person_token: string }>(
        "SELECT person_token FROM identity.external_person_identity WHERE phone_hmac = $1 AND site_id = $2 LIMIT 1",
        [hmac, siteId],
      );
      return p.rows[0] ? { contactToken: p.rows[0].person_token, familyGroupId: null } : null;
    },

    async routeForRecipient({ siteId, recipientToken }) {
      const g = await identityDb.query<{ family_group_id: string; phone_hmac: string }>(
        `SELECT family_group_id, phone_hmac FROM identity.guardian_contact
         WHERE contact_token = $1 AND site_id = $2 ORDER BY valid_from DESC LIMIT 1`,
        [recipientToken, siteId],
      );
      if (g.rows[0]) return { familyGroupId: g.rows[0].family_group_id, phoneHmac: g.rows[0].phone_hmac };
      // Therapists and provider dispatchers have no family group; they still get a thread of their own.
      const p = await identityDb.query<{ phone_hmac: string | null }>(
        "SELECT phone_hmac FROM identity.external_person_identity WHERE person_token = $1 AND site_id = $2",
        [recipientToken, siteId],
      );
      return { familyGroupId: null, phoneHmac: p.rows[0]?.phone_hmac ?? null };
    },

    async egressFacts({ siteId, recipientToken, kind, channel, at }) {
      const consent = async (): Promise<string | null> => {
        const ev = await identityDb.query<{ kind: string }>(
          `SELECT kind FROM identity.consent_event WHERE contact_token = $1 AND site_id = $2 AND channel = $3 AND at <= $4
           ORDER BY at DESC, id DESC LIMIT 1`,
          [recipientToken, siteId, channel, at.toISOString()],
        );
        return ev.rows[0]?.kind ?? null;
      };
      if (kind === "dispatcher") {
        const p = await identityDb.query<{ n: number }>(
          "SELECT count(*)::int n FROM identity.external_person_identity WHERE person_token = $1 AND site_id = $2",
          [recipientToken, siteId],
        );
        if (p.rows[0].n === 0) return { onFile: false, guardian: null, latestConsentKind: null };
        return { onFile: true, guardian: null, latestConsentKind: await consent() };
      }
      if (kind === "guardian") {
        const r = await identityDb.query<{ ok_updates: boolean; ok_emergency: boolean }>(
          `SELECT can_receive_updates ok_updates, is_emergency ok_emergency FROM identity.guardian_contact
           WHERE contact_token = $1 AND site_id = $2 AND revoked_at IS NULL
             AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)`,
          [recipientToken, siteId, at.toISOString()],
        );
        const c = r.rows[0];
        if (!c) return { onFile: false, guardian: null, latestConsentKind: null };
        return {
          onFile: true,
          guardian: { canReceiveUpdates: c.ok_updates, isEmergency: c.ok_emergency },
          latestConsentKind: await consent(),
        };
      }
      // A therapist: ops has already checked they own a session for the child, so there is no
      // identity row to find here. Their consent is still theirs — they can text STOP too.
      return { onFile: true, guardian: null, latestConsentKind: await consent() };
    },

    async appendConsent({ siteId, contactToken, channel, kind, at, evidenceMessageId }) {
      const consentEventId = uuidv7();
      await identityDb.query(
        `INSERT INTO identity.consent_event (id, site_id, contact_token, kind, channel, evidence_message_id, at, source_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'SIMULATED')`,
        [consentEventId, siteId, contactToken, kind, channel, evidenceMessageId, at.toISOString()],
      );
      // The newest event wins, whatever order the webhooks arrived in.
      const latest = await identityDb.query<{ id: string; kind: string; at: Date | string }>(
        `SELECT id, kind, at FROM identity.consent_event WHERE site_id = $1 AND contact_token = $2 AND channel = $3
         ORDER BY at DESC, id DESC LIMIT 1`,
        [siteId, contactToken, channel],
      );
      const row = latest.rows[0];
      return {
        consentEventId,
        newest: row ? { id: row.id, kind: row.kind, at: row.at instanceof Date ? row.at : new Date(row.at) } : null,
      };
    },

    async phoneHmacForPerson({ siteId, personToken }) {
      const r = await identityDb.query<{ phone_hmac: string | null }>(
        "SELECT phone_hmac FROM identity.external_person_identity WHERE person_token = $1 AND site_id = $2",
        [personToken, siteId],
      );
      return r.rows[0]?.phone_hmac ?? null;
    },
  };
}

/**
 * P1's gateway: the demo fixture, which is what the seed put in `identity.guardian_contact`.
 *
 * Both answers are derived the same way the seed derives them (src/modules/demo/seed.ts:126 and
 * :252), so the token this returns is the token the message rows carry. No database at all,
 * which is also why Family texts renders on a laptop with no `DATABASE_URL`.
 */
export function syntheticIdentityGateway(pepper: string | undefined): IdentityGateway {
  const contactOf = (i: number): GuardianContact => ({
    contactToken: demoId(KIND.contact, i + 1),
    familyGroupId: demoId(KIND.family, i + 1),
    siteId: DEMO_SITE_ID,
    legalName: synLegalName(FAMILIES[i].guardian.firstName, FAMILIES[i].guardian.lastInitial),
  });
  return {
    async contactForPhone(number) {
      const e164 = normalizeE164(number);
      if (!e164) return null;
      /*
       * Matched on the blind index rather than on the digits, so this gateway and the deployed
       * one agree about what "the same number" means — including a fixture written as
       * "+1-561-555-0102" and a request carrying "+15615550102". With no pepper there is no
       * index to match on, and the honest answer is "I don't know".
       */
      if (!pepper) return null;
      const want = phoneHmac(e164, pepper);
      const i = FAMILIES.findIndex((f) => {
        const n = normalizeE164(f.guardian.phone);
        return n !== null && phoneHmac(n, pepper) === want;
      });
      return i < 0 ? null : contactOf(i);
    },
    async namesForContacts(contactTokens) {
      const wanted = new Set(contactTokens);
      const found = new Map<string, string>();
      FAMILIES.forEach((_, i) => {
        const c = contactOf(i);
        if (wanted.has(c.contactToken)) found.set(c.contactToken, c.legalName);
      });
      return found;
    },

    /*
     * S1-6's five questions, answered from the same fixture the seed inserted — the same contact
     * and person tokens, the same blind indexes, and the two guardian flags derived exactly as
     * `seed.ts` derives them from the family's own authorization scopes. In this data class the
     * fixture *is* the vault's contents (ADR-015), which is why these can be exact.
     */
    async senderForPhoneHmac({ phoneHmac: hmac }) {
      if (!pepper) return null;
      const f = FAMILIES.findIndex((family) => hmacOfNumber(family.guardian.phone, pepper) === hmac);
      if (f >= 0) {
        const c = contactOf(f);
        return { contactToken: c.contactToken, familyGroupId: c.familyGroupId };
      }
      const p = EXTERNAL_PEOPLE.findIndex((person) => hmacOfNumber(person.phone, pepper) === hmac);
      // A therapist or a dispatcher: their own token, and no family group — they are not a family.
      return p < 0 ? null : { contactToken: personTokenOf(p), familyGroupId: null };
    },

    async routeForRecipient({ recipientToken }) {
      const f = FAMILIES.findIndex((_, i) => contactOf(i).contactToken === recipientToken);
      if (f >= 0) {
        return {
          familyGroupId: contactOf(f).familyGroupId,
          phoneHmac: pepper ? hmacOfNumber(FAMILIES[f].guardian.phone, pepper) : null,
        };
      }
      const p = EXTERNAL_PEOPLE.findIndex((_, i) => personTokenOf(i) === recipientToken);
      if (p < 0) return { familyGroupId: null, phoneHmac: null };
      return { familyGroupId: null, phoneHmac: pepper ? hmacOfNumber(EXTERNAL_PEOPLE[p].phone, pepper) : null };
    },

    async egressFacts({ siteId, recipientToken, kind, channel, at }) {
      const latestConsentKind = newestConsentOf({ siteId, contactToken: recipientToken, channel, at });
      if (kind === "therapist") return { onFile: true, guardian: null, latestConsentKind };
      if (kind === "dispatcher") {
        const onFile = EXTERNAL_PEOPLE.some((_, i) => personTokenOf(i) === recipientToken);
        return { onFile, guardian: null, latestConsentKind: onFile ? latestConsentKind : null };
      }
      const f = FAMILIES.findIndex((_, i) => contactOf(i).contactToken === recipientToken);
      if (f < 0) return { onFile: false, guardian: null, latestConsentKind: null };
      /*
       * The two flags, derived the way `seed.ts:261-264` derives the columns: a family may be sent
       * updates when one of its children's scopes says so, and `is_emergency` is `true` for every
       * seeded guardian. Derived rather than restated, so a scope change moves both at once.
       */
      const scopes = new Set(
        CHILDREN.filter((c) => c.familyKey === FAMILIES[f].key).flatMap((c) => c.scopes as readonly string[]),
      );
      return {
        onFile: true,
        guardian: {
          canReceiveUpdates:
            scopes.has("RECEIVE_TRANSPORT_UPDATES") || scopes.has("RECEIVE_ATTENDANCE_UPDATES"),
          isEmergency: true,
        },
        latestConsentKind,
      };
    },

    async appendConsent({ siteId, contactToken, channel, kind, at }) {
      const consentEventId = uuidv7();
      consentLog().push({ siteId, contactToken, channel, id: consentEventId, kind, at });
      return {
        consentEventId,
        newest: newestConsentRowOf({ siteId, contactToken, channel, at: null }),
      };
    },

    async phoneHmacForPerson({ personToken }) {
      if (!pepper) return null;
      const p = EXTERNAL_PEOPLE.findIndex((_, i) => personTokenOf(i) === personToken);
      return p < 0 ? null : hmacOfNumber(EXTERNAL_PEOPLE[p].phone, pepper);
    },
  };
}

/** The blind index of a fixture number, or "" for one `normalizeE164` will not take. */
function hmacOfNumber(number: string, pepper: string): string {
  const e164 = normalizeE164(number);
  return e164 === null ? "" : phoneHmac(e164, pepper);
}

/** A therapist's or dispatcher's person token, derived as the seed derives it. */
const personTokenOf = (i: number): string => demoId(KIND.person, i + 1);

/**
 * THE SYNTHETIC GATEWAY'S CONSENT LEDGER, and what it is and is not.
 *
 * `identity.consent_event` is append-only and is the *record* of what a family asked for. The
 * fixture gateway has no table, so the record it keeps is this list — and it is on `globalThis`
 * rather than in module scope on purpose: Next gives a route handler and a page separate copies of
 * a module, so a STOP written by the SMS webhook would be invisible to the outbox drain if this
 * were a plain `const`.
 *
 * What a STOP *does* is not kept here and does not depend on this list. `consent.recordConsent`
 * projects the newest event into `ops.suppression`, a real table with a real row, and that is what
 * the drain enforces at send time (`policy.activeSuppression`, read on every message). This list
 * is the ledger beside it, and in this data class it lives as long as the process does.
 *
 * The follow-up is the one named in the S1-0 notes: a gateway backed by the `identity_gateway`
 * connection (B-19), at which point `dbIdentityGateway` answers all of this off the real rows and
 * nothing in P1's shape survives.
 */
type LoggedConsent = {
  readonly siteId: string;
  readonly contactToken: string;
  readonly channel: string;
  readonly id: string;
  readonly kind: string;
  readonly at: Date;
};
const CONSENT_LOG = Symbol.for("ppec.identity.syntheticConsentLog");
function consentLog(): LoggedConsent[] {
  const host = globalThis as unknown as Record<symbol, LoggedConsent[] | undefined>;
  return (host[CONSENT_LOG] ??= []);
}

/** The newest event for this contact and channel, at or before `at` when `at` is given. */
function newestConsentRowOf(a: {
  siteId: string;
  contactToken: string;
  channel: string;
  at: Date | null;
}): ConsentEvent | null {
  const rows = consentLog()
    .filter(
      (e) =>
        e.siteId === a.siteId &&
        e.contactToken === a.contactToken &&
        e.channel === a.channel &&
        (a.at === null || e.at.getTime() <= a.at.getTime()),
    )
    // Newest first, and `id` breaks a tie the way `ORDER BY at DESC, id DESC` does.
    .sort((x, y) => y.at.getTime() - x.at.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  const row = rows[0];
  return row ? { id: row.id, kind: row.kind, at: row.at } : null;
}

const newestConsentOf = (a: { siteId: string; contactToken: string; channel: string; at: Date }): string | null =>
  newestConsentRowOf({ ...a })?.kind ?? null;

/**
 * Forget every consent event this process has logged.
 *
 * For the suites, and for "Restart demo day" — which truncates the ops side and prunes the real
 * ledger (`seed.ts`'s `PRESERVED_TABLES`), so the fixture ledger has to be able to start over too.
 */
export function resetSyntheticConsentLog(): void {
  consentLog().length = 0;
}

/**
 * No gateway connection on this deployment: "I don't know", for both questions.
 *
 * Not a throw. The two callers both have a smaller answer to fall back to — a thread read by
 * family group, a card that names the child and not the adult — and a staff screen that fails
 * closed on a *name* is worse than one that is briefly less specific. P2 replaces this with
 * `dbIdentityGateway` over the `identity_gateway` connection (B-19).
 */
export function unwiredIdentityGateway(): IdentityGateway {
  return {
    async contactForPhone() { return null; },
    async namesForContacts() { return new Map(); },
    /*
     * S1-6's questions, all answered "I don't know" — and note what that means at the egress door:
     * `onFile: false` with no guardian row, which `policy.dbRecipientAuthorizer` turns into a
     * REFUSAL. That asymmetry is deliberate and is the opposite of the two above. Not knowing a
     * *name* is a card that is less specific; not knowing whether somebody consented is not a
     * licence to text them, so a deployment with no gateway sends nobody anything rather than
     * sending on an assumption.
     */
    async senderForPhoneHmac() { return null; },
    async routeForRecipient() { return { familyGroupId: null, phoneHmac: null }; },
    async egressFacts() { return { onFile: false, guardian: null, latestConsentKind: null }; },
    async appendConsent() { return { consentEventId: uuidv7(), newest: null }; },
    async phoneHmacForPerson() { return null; },
  };
}

/**
 * The gateway this process runs with, chosen by data class and by nothing a request can set.
 *
 * `APP_DATA_CLASS=SYNTHETIC` is the only value the boot guard accepts in P1 (src/lib/env.ts), so
 * in practice this is the fixture gateway everywhere the app runs today. The other branch is
 * written down rather than left implicit so that the day a real connection exists, there is one
 * line to change and one place to look.
 */
export function identityGateway(
  env: Record<string, string | undefined> = process.env,
): IdentityGateway {
  return isSyntheticDemo(env) ? syntheticIdentityGateway(env.HMAC_PEPPER) : unwiredIdentityGateway();
}
