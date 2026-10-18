/**
 * **A family is texted on a synthetic number, or not at all** (Veri's bar, 2026-10-17;
 * MOCKS-AND-DEMO §3; ADR-006 / `APP_DATA_CLASS=SYNTHETIC`).
 *
 * Four independent things have to hold for that sentence to be true, and each is a test here:
 *
 *  1. **Only one provider is wired.** P1 runs the SIM provider, which writes into the persona
 *     mailbox in this database; the live adapter refuses outright, so there is no code path that
 *     reaches a carrier even if somebody configured one.
 *  2. **The address book is fiction.** Every number the simulation can name is in the 555-01xx
 *     block the mocks reserve — the centre's and the eight persona phones — and nothing else is
 *     addressable, in either direction.
 *  3. **The send refuses a family it cannot name.** A recipient with a family group whose blind
 *     index is not in that address book is `ProviderRejected`: the message ends FAILED rather
 *     than being retried at a number nobody chose.
 *  4. **The demo day's own recipients are all personas**, so the screens this PR builds text
 *     nobody else.
 *
 * It is a rule about egress, so it is tested against the real provider and the real tables on
 * PGlite rather than against a mock of the thing being proved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTestGuardian, testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). Every `identity.*` statement moved behind
 * `IdentityGateway`, so the code under test asks this rather than the connection — and it answers
 * from the rows `seedPersona` / `seedAgentScenario` just wrote. See src/test/identity-gateway.ts
 * for why it is in memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { FAMILIES } from "@/modules/demo/fixtures/standard";
import { normalizeE164 } from "@/modules/identity/phone";
import { ProviderRejected, twilioStub } from "@/modules/outbox/provider";
import { TEST_NOW } from "@/test/clock";
import { PEPPER, seedPersona } from "@/test/messaging";
import { freshDb, SITE } from "@/test/pglite";
import { DbSimMessagingProvider } from "./sim-provider";
import { SIM_CENTER_NUMBER, SIM_PERSONA_NUMBERS, isSimPersonaNumber, parseSimNumber } from "./sim-numbers";

/** The fiction block the mocks reserve: +1 561 555 01xx, and nothing else, ever. */
const FICTION = /^\+1561555 ?01\d\d$/;

let pg: PGlite;
let db: Db;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
});

afterEach(async () => {
  await pg.close();
});

/** The scheduler the provider needs. Nothing here exercises it; a send that lands schedules one. */
const scheduler = { schedule: async () => {} };

function provider(): DbSimMessagingProvider {
  return new DbSimMessagingProvider(db, scheduler as never, { pepper: PEPPER, gateway: GATEWAY });
}

const payload = (recipientToken: string) => ({
  messageId: "00000000-0000-7000-8000-00000000e001",
  siteId: SITE,
  idempotencyKey: "synthetic-only-1",
  channel: "SMS_1TO1",
  recipientToken,
  templateId: "generic.notice",
  vars: {},
  childToken: null,
});

describe("only one provider is wired, and the live one refuses", () => {
  it("is the SIM provider, which writes to the persona mailbox and not to a carrier", () => {
    expect(provider().name).toBe("SIM");
  });

  it("and the live adapter refuses by construction (ADR-006, P1)", async () => {
    await expect(
      twilioStub.send(payload("00000000-0000-7000-8000-00000000c001"), {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not enabled in P1/);
  });
});

describe("every number the simulation can name is fiction", () => {
  it("is 555-01xx, for the centre and for every persona", () => {
    for (const number of [SIM_CENTER_NUMBER, ...SIM_PERSONA_NUMBERS]) {
      expect(number, number).toMatch(FICTION);
    }
    // The eight are distinct, so "a persona" is always one family and never two by accident.
    expect(new Set(SIM_PERSONA_NUMBERS).size).toBe(SIM_PERSONA_NUMBERS.length);
  });

  it("and a real number is not addressable, in either direction", () => {
    for (const real of ["+12125550000", "+15615551234", "+447700900000"]) {
      expect(isSimPersonaNumber(real), real).toBe(false);
      expect(parseSimNumber(real), real).toBeNull();
    }
  });

  it("including every guardian the demo fixtures give a phone to", () => {
    for (const family of FAMILIES) {
      const e164 = normalizeE164(family.guardian.phone);
      expect(e164, `${family.key} ${family.guardian.phone}`).not.toBeNull();
      expect(e164!, family.key).toMatch(FICTION);
    }
  });
});

describe("the send refuses a family it cannot name", () => {
  it("delivers to a persona number", async () => {
    const persona = await seedPersona(db, SIM_PERSONA_NUMBERS[1], { siteId: SITE, now: TEST_NOW });
    const answer = await provider().send(payload(persona.contactToken), {
      signal: new AbortController().signal,
    });
    expect(answer.providerMessageId).toContain("SIM-");
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.message", []);
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it("and refuses a family contact whose number is not one", async () => {
    const persona = await seedPersona(db, SIM_PERSONA_NUMBERS[2], { siteId: SITE, now: TEST_NOW });
    // The same contact, re-pointed at a number the fiction block does not hold. Everything else
    // about the send is unchanged, so the refusal is about the number and nothing else.
    const notAPersona = "not-a-persona-blind-index";
    await db.query(
      "UPDATE identity.guardian_contact SET phone_hmac = $1 WHERE contact_token = $2",
      [notAPersona, persona.contactToken],
    );
    // And in the gateway, which is where the provider reads it from since S1-6. Both, because the
    // row and the gateway's answer are the same fact and a test that moved only one of them would
    // be asserting against a state no deployment can be in.
    registerTestGuardian({
      siteId: SITE,
      contactToken: persona.contactToken,
      familyGroupId: persona.familyGroupId,
      phoneHmac: notAPersona,
      legalName: "SYN Guardian",
      canReceiveUpdates: true,
    });
    await expect(
      provider().send(payload(persona.contactToken), { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    // FAILED, and nothing written: no row in the mailbox to be delivered later.
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.message", []);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});
