/**
 * **Veri's agent gate, check 4: the context assembler sends tokens, not raw child or parent
 * details.**
 *
 * `assembler.test.ts` already asserts the prompt passes the gateway's own guard and names no
 * *fixture* person. This file asks the harder version of the question, the one that is about the
 * data rather than about the fixtures:
 *
 *  1. **It never reads the vault.** Every query the assembler issues is recorded, and not one of
 *     them touches an `identity.*` table. That is the structural answer: a name, a phone number or
 *     an address cannot reach a prompt from a table nobody selected from. The vault rows are
 *     seeded with values nothing else in the suite uses, so the search for them is real.
 *  2. **Everything it does send is a token or a code.** Every `key=value` in T1 and T2 is checked
 *     against the shape a token may take — a uuid, a version, a state, a date — so a reader does
 *     not have to take the module's word for it.
 *  3. **A name a family types is tokenized from the data, not from a hard-coded roster.** This is
 *     the part Veri's note anticipated ("implement the minimum token mapping inside the assembler
 *     for demo data"). P1's tokenizer knew the fixture roster and nothing else, so a child whose
 *     `ops.child_profile.display_name` was not one of the five fixture names went to the model as
 *     written. The mapping now comes from the operational row for the family on the thread, which
 *     is where a demo deployment's own names live.
 *
 * What is still the roster's job, and is said here so nobody mistakes it for an oversight: a
 * **guardian's** legal name exists only in `identity.guardian_contact`, which this module may not
 * read (point 1 is the reason). So a guardian name typed into a thread is tokenized from the P1
 * fixture roster, and the identity vault's name index replaces that list when real data arrives —
 * behind the same function, as `identity/names.ts` says.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { findLeaks, validatePromptTokensOnly } from "@/modules/agent/redact";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { dbContextAssembler } from "./assembler";

/**
 * What a real family's row would hold, in the shapes PRD §12 names: a legal name, a phone number
 * and a street address. Distinctive strings, so finding one anywhere is unambiguous — and none of
 * them is on the fixture roster, which is the point of choosing them.
 */
const VAULT = {
  childFirst: "Zephaniah",
  childLast: "Quintrell",
  guardianLegal: "Marguerite Quintrell-Vossberg",
  phone: "+15615550199",
  address: "4821 Hollow Brook Terrace, Greenacres FL 33415",
};

let pg: PGlite;
let db: Db;
let scenario: AgentScenario;
/** Every statement the assembler ran, in order. */
let statements: string[];
let spied: Db;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  statements = [];
  spied = {
    query: (sql, params) => {
      statements.push(sql);
      return db.query(sql, params);
    },
    tx: (fn) => db.tx(fn),
  };
}, 60_000);

afterEach(async () => {
  await pg.close();
});

/** Fill the identity vault for this scenario's family with values a prompt must never carry. */
async function fillTheVault(sc: AgentScenario) {
  await db.query(
    `INSERT INTO identity.child_identity (child_token, site_id, external_ehr_id, legal_first_name, legal_last_name, address_enc, created_by, updated_by)
     VALUES ($1, $2, 'EHR-1', $3, $4, $5, 'test', 'test')`,
    [sc.children[0], sc.siteId, VAULT.childFirst, VAULT.childLast, VAULT.address],
  );
  await db.query("UPDATE identity.guardian_contact SET legal_name = $2, phone_enc = $3 WHERE contact_token = $1", [
    sc.contactToken,
    VAULT.guardianLegal,
    VAULT.phone,
  ]);
}

const assemble = (db_: Db = spied) =>
  dbContextAssembler(db_, { env: {} })({
    runId: "01900000-0000-7000-8000-0000000000aa",
    trigger: { type: "msg.inbound", id: scenario.messageId, siteId: scenario.siteId },
    committed: [],
    now: TEST_NOW,
  });

describe("check 4, part 1: the assembler never reads the identity vault", () => {
  it("runs a prompt's worth of queries and not one of them names an identity table", async () => {
    scenario = await seedAgentScenario(db, { children: 2 });
    await fillTheVault(scenario);
    await assemble();

    expect(statements.length).toBeGreaterThan(4);
    for (const sql of statements) {
      expect({ sql, vault: /\bidentity\s*\./i.test(sql) }).toEqual({ sql, vault: false });
    }
    // And every one of them reads `ops.`, so the scan is reading real statements.
    expect(statements.every((s) => /\bops\s*\./i.test(s))).toBe(true);
  });

  it("the vault's own values reach no part of the assembled context", async () => {
    scenario = await seedAgentScenario(db, { children: 2 });
    await fillTheVault(scenario);
    const { prompt, policy } = await assemble();

    const everything = [prompt, JSON.stringify(policy), ...(policy.untrustedMessages ?? [])].join("\n");
    for (const [what, value] of Object.entries(VAULT)) {
      expect({ what, present: everything.includes(value) }).toEqual({ what, present: false });
    }
    // Belt: the gateway's own guards, over the same prompt.
    expect(() => validatePromptTokensOnly(prompt)).not.toThrow();
    expect(findLeaks(prompt)).toEqual([]);
  });
});

describe("check 4, part 2: every fact in T1 and T2 is a token or a code", () => {
  /** uuids, fixture-shaped tokens, versions, dates, clock times, states, scope codes, "none". */
  const TOKEN_OR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:|,\-/]*$/;

  it("holds nothing that is not one, across both tiers", async () => {
    scenario = await seedAgentScenario(db, { children: 2 });
    await fillTheVault(scenario);
    const { prompt } = await assemble();

    const tiers = prompt
      .split("\n")
      .filter((line) => line.startsWith("T1 ") || line.startsWith("T2 "))
      .map((line) => line.slice(3));
    expect(tiers).toHaveLength(2);

    const pairs = tiers.flatMap((tier) => tier.split(/\s+/)).filter((w) => w.includes("="));
    expect(pairs.length).toBeGreaterThan(8);
    for (const pair of pairs) {
      const value = pair.slice(pair.indexOf("=") + 1);
      // An empty value is fine (`children=` can be "none"); a space-separated phrase is not, and
      // cannot appear, because the split above is on whitespace.
      expect({ pair, shaped: value === "" || TOKEN_OR_CODE.test(value) }).toEqual({ pair, shaped: true });
    }
    // No tier may hold a word that is capitalized mid-sentence the way a name is.
    for (const tier of tiers) expect(tier).not.toMatch(/[A-Z][a-z]+\s+[A-Z]\./);
  });
});

describe("check 4, part 3: a name the family types is tokenized from this deployment's own data", () => {
  it("replaces the child's display name with the child's token, roster or no roster", async () => {
    scenario = await seedAgentScenario(db, { body: `will ${VAULT.childFirst} ${VAULT.childLast[0]}. be dropped at 5` });
    // The name this deployment actually holds for the child — not one of the five fixture names.
    await db.query("UPDATE ops.child_profile SET display_name = $2 WHERE child_token = $1", [
      scenario.children[0],
      `${VAULT.childFirst} ${VAULT.childLast[0]}.`,
    ]);
    await fillTheVault(scenario);

    const { prompt, policy } = await assemble();
    expect(prompt).not.toContain(VAULT.childFirst);
    expect((policy.untrustedMessages ?? []).join("\n")).not.toContain(VAULT.childFirst);
    // Tokenized, not redacted: the model can still say which child the text is about.
    expect(prompt).toContain(`will ${scenario.children[0]} be dropped at 5`);
  });

  it("the bare first name on its own is tokenized too, however the family capitalizes it", async () => {
    scenario = await seedAgentScenario(db, { body: `ZEPHANIAH is staying home today, and zephaniah's brother too` });
    await db.query("UPDATE ops.child_profile SET display_name = $2 WHERE child_token = $1", [
      scenario.children[0],
      `${VAULT.childFirst} Q.`,
    ]);

    const { prompt } = await assemble();
    expect(prompt.toLowerCase()).not.toContain(VAULT.childFirst.toLowerCase());
    expect(prompt).toContain(scenario.children[0]);
  });

  it("does not tokenize another family's child, even at the same site", async () => {
    scenario = await seedAgentScenario(db, { body: "is the van still coming" });
    const stranger = await seedAgentScenario(db, { number: "+15615550102" });
    await db.query("UPDATE ops.child_profile SET display_name = 'Zephaniah Q.' WHERE child_token = $1", [
      stranger.children[0],
    ]);

    // Nothing to replace in this family's thread, and no scope leak either way.
    const { prompt, policy } = await assemble();
    expect(prompt).toContain("is the van still coming");
    expect(policy.scope.tokens.has(stranger.children[0])).toBe(false);
  });

  it("leaves ordinary words alone: a mapping is not a licence to mangle the message", async () => {
    scenario = await seedAgentScenario(db, { body: "the van is late and I am waiting at the corner" });
    await db.query("UPDATE ops.child_profile SET display_name = 'Ed A.' WHERE child_token = $1", [
      scenario.children[0],
    ]);

    const { prompt } = await assemble();
    // "Ed" is two letters: too short to substitute safely, so the message is untouched.
    expect(prompt).toContain("the van is late and I am waiting at the corner");
  });
});
