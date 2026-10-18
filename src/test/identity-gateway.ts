/**
 * THE SUITES' IDENTITY GATEWAY — in memory, fed by the seed helpers beside it.
 *
 * S1-6 moved every `identity.*` statement behind `IdentityGateway` (Firia's ruling 2, 2026-10-18
 * 2:48 AM ET), which left the suites needing a gateway that knows the rows *they* wrote. Two
 * existing gateways do not fit, each for a reason worth writing down:
 *
 *  - `syntheticIdentityGateway` answers from `fixtures/standard.ts`. `seedPersona` writes random
 *    `uuidv7` tokens, so the fixture gateway has never heard of its guardians.
 *  - `dbIdentityGateway` answers from the rows, which is exactly right — and it is what
 *    `identity-off-the-app-connection.test.ts` uses, over the superuser connection, to prove the
 *    SQL still matches the schema. It cannot be the *general* harness gateway because PGlite is
 *    one connection: `messaging/inbound.ts` asks the gateway from inside its own `db.tx`, and a
 *    second `pg.transaction` on the same handle waits on the first one forever (a 30 s timeout,
 *    not an error). On a deployment the gateway is a different connection and the question does
 *    not arise; in one process it has to be answered without a transaction.
 *
 * So this one holds what the helpers inserted, in a map, and answers from it. No database, no
 * transaction, and every answer is the row the test seeded — which is the same property the
 * fixture gateway has for the demo day.
 *
 * It is a module-level registry rather than a value threaded through every helper, because the
 * helpers are called from forty suites and vitest gives each file its own module instance.
 * `freshDb()` clears it, so a file's second database starts from an empty identity.
 */
import type {
  ConsentEvent,
  EgressFacts,
  GuardianContact,
  IdentityGateway,
  IdentityPerson,
  RecipientRoute,
} from "@/modules/identity/gateway";
import { normalizeE164, phoneHmac } from "@/modules/identity/phone";

/** A guardian the suites seeded into `identity.guardian_contact`. */
type Guardian = {
  readonly siteId: string;
  readonly contactToken: string;
  readonly familyGroupId: string;
  readonly phoneHmac: string;
  readonly legalName: string;
  readonly canReceiveUpdates: boolean;
  readonly isEmergency: boolean;
};

/** A therapist or provider dispatcher the suites seeded into `identity.external_person_identity`. */
type Person = { readonly siteId: string; readonly personToken: string; readonly phoneHmac: string };

type Logged = ConsentEvent & { readonly siteId: string; readonly contactToken: string; readonly channel: string };

const guardians: Guardian[] = [];
const people: Person[] = [];
const consent: Logged[] = [];

/** Forget everything. Called by `freshDb()`, so a new database means a new identity. */
export function resetTestIdentity(): void {
  guardians.length = 0;
  people.length = 0;
  consent.length = 0;
}

/**
 * Register a guardian row the suite just inserted, or replace the one it already registered.
 *
 * Replacing rather than appending, because `identity.guardian_contact` is keyed on
 * `(contact_token, site_id)` and a suite that re-points a contact — at a different number, or a
 * different `can_receive_updates` — expects the newer value to be the answer, exactly as an
 * `UPDATE` would. `isEmergency` defaults to the seed's `true`.
 */
export function registerTestGuardian(g: Omit<Guardian, "isEmergency"> & { isEmergency?: boolean }): void {
  const at = guardians.findIndex((row) => row.siteId === g.siteId && row.contactToken === g.contactToken);
  const row: Guardian = { isEmergency: g.isEmergency ?? true, ...g };
  if (at < 0) guardians.push(row);
  else guardians[at] = row;
}

/** Register an external person row the suite just inserted. */
export function registerTestPerson(p: Person): void {
  people.push(p);
}

const guardianByToken = (siteId: string, token: string): Guardian | undefined =>
  guardians.find((g) => g.siteId === siteId && g.contactToken === token);

/**
 * The newest consent event for this contact and channel, at or before `at`.
 *
 * `ORDER BY at DESC, id DESC`, which is what `dbIdentityGateway` does — the tie-break matters
 * because the out-of-order webhook tests write two events at the same instant on purpose.
 */
function newestConsent(a: { siteId: string; contactToken: string; channel: string; at: Date | null }): ConsentEvent | null {
  const rows = consent
    .filter(
      (e) =>
        e.siteId === a.siteId &&
        e.contactToken === a.contactToken &&
        e.channel === a.channel &&
        (a.at === null || e.at.getTime() <= a.at.getTime()),
    )
    .sort((x, y) => y.at.getTime() - x.at.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  return rows[0] ? { id: rows[0].id, kind: rows[0].kind, at: rows[0].at } : null;
}

/**
 * The gateway the suites hand to the webhook, the drain and the agent's run path.
 *
 * `uuid` is injected so a caller can keep its own id scheme; it defaults to `crypto.randomUUID`,
 * which is enough for a consent event nobody looks up by id.
 */
export function testIdentityGateway(opts: { pepper: string; uuid?: () => string } = { pepper: "" }): IdentityGateway {
  const newId = opts.uuid ?? (() => crypto.randomUUID());
  const hmacOf = (number: string): string | null => {
    const e164 = normalizeE164(number);
    return e164 === null ? null : phoneHmac(e164, opts.pepper);
  };
  return {
    async contactForPhone(number): Promise<GuardianContact | null> {
      const hmac = hmacOf(number);
      const g = hmac === null ? undefined : guardians.find((row) => row.phoneHmac === hmac);
      return g
        ? { contactToken: g.contactToken, familyGroupId: g.familyGroupId, siteId: g.siteId, legalName: g.legalName }
        : null;
    },

    async namesForContacts(contactTokens): Promise<ReadonlyMap<string, string>> {
      const wanted = new Set(contactTokens);
      const found = new Map<string, string>();
      for (const g of guardians) if (wanted.has(g.contactToken)) found.set(g.contactToken, g.legalName);
      return found;
    },

    async senderForPhoneHmac({ siteId, phoneHmac: hmac }): Promise<IdentityPerson | null> {
      const g = guardians.find((row) => row.siteId === siteId && row.phoneHmac === hmac);
      if (g) return { contactToken: g.contactToken, familyGroupId: g.familyGroupId };
      const p = people.find((row) => row.siteId === siteId && row.phoneHmac === hmac);
      return p ? { contactToken: p.personToken, familyGroupId: null } : null;
    },

    async routeForRecipient({ siteId, recipientToken }): Promise<RecipientRoute> {
      const g = guardianByToken(siteId, recipientToken);
      if (g) return { familyGroupId: g.familyGroupId, phoneHmac: g.phoneHmac };
      const p = people.find((row) => row.siteId === siteId && row.personToken === recipientToken);
      return { familyGroupId: null, phoneHmac: p?.phoneHmac ?? null };
    },

    async egressFacts({ siteId, recipientToken, kind, channel, at }): Promise<EgressFacts> {
      const latestConsentKind = newestConsent({ siteId, contactToken: recipientToken, channel, at })?.kind ?? null;
      if (kind === "therapist") return { onFile: true, guardian: null, latestConsentKind };
      if (kind === "dispatcher") {
        const onFile = people.some((row) => row.siteId === siteId && row.personToken === recipientToken);
        return { onFile, guardian: null, latestConsentKind: onFile ? latestConsentKind : null };
      }
      const g = guardianByToken(siteId, recipientToken);
      if (!g) return { onFile: false, guardian: null, latestConsentKind: null };
      return {
        onFile: true,
        guardian: { canReceiveUpdates: g.canReceiveUpdates, isEmergency: g.isEmergency },
        latestConsentKind,
      };
    },

    async appendConsent({ siteId, contactToken, channel, kind, at }) {
      const id = newId();
      consent.push({ siteId, contactToken, channel, id, kind, at });
      return { consentEventId: id, newest: newestConsent({ siteId, contactToken, channel, at: null }) };
    },

    async phoneHmacForPerson({ siteId, personToken }) {
      return people.find((row) => row.siteId === siteId && row.personToken === personToken)?.phoneHmac ?? null;
    },
  };
}

/**
 * The consent events this gateway has been handed, oldest first.
 *
 * Test-only, and it exists because the ledger moved: a suite that used to read
 * `identity.consent_event` out of PGlite is now reading the wrong place, since the code under
 * test appends through `IdentityGateway.appendConsent` and this implementation keeps the rows
 * here. The assertion is the same one — "one event, of this kind, at this time" — against the
 * ledger the run actually wrote to.
 */
export function testConsentEvents(): readonly ConsentEvent[] {
  return [...consent]
    .sort((x, y) => x.at.getTime() - y.at.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((e) => ({ id: e.id, kind: e.kind, at: e.at }));
}

/**
 * Record a consent event straight into the suites' ledger.
 *
 * For a test that says "this family has opted out" as a *precondition* rather than by sending a
 * STOP through the webhook. It used to be an `INSERT INTO identity.consent_event` on the suite's
 * own handle; since S1-6 the code under test reads the ledger through `IdentityGateway`, so the
 * precondition has to be set where the read will look.
 */
export function registerTestConsent(e: {
  siteId: string;
  contactToken: string;
  channel: string;
  kind: string;
  at: Date;
  id?: string;
}): void {
  consent.push({ ...e, id: e.id ?? crypto.randomUUID() });
}

/** Take an external person off file, as a `DELETE` from `identity.external_person_identity` would. */
export function unregisterTestPerson(a: { siteId: string; personToken: string }): void {
  const at = people.findIndex((p) => p.siteId === a.siteId && p.personToken === a.personToken);
  if (at >= 0) people.splice(at, 1);
}

/** Move an external person to another site, as an `UPDATE … SET site_id` would. */
export function moveTestPerson(a: { personToken: string; toSiteId: string }): void {
  const at = people.findIndex((p) => p.personToken === a.personToken);
  if (at >= 0) people[at] = { ...people[at], siteId: a.toSiteId };
}
