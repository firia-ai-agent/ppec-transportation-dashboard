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
import { isSyntheticDemo } from "@/lib/env";
import type { Exec } from "@/db/exec";
import { DEMO_SITE_ID, FAMILIES, KIND, demoId, synLegalName } from "@/modules/demo/fixtures/standard";
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
}

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
  };
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
