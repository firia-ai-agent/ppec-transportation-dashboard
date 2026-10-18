/**
 * THE APP CONNECTION NEVER READS `identity`. (S1, 12:13 AM ET.)
 *
 * The rule is written in the schema: src/db/schema.ts:104 — "Restricted. App role `app_rw` gets
 * NO select on these; only `identity_gateway` role (used by IdentityGateway) does." 0001_roles.sql
 * enforces it (`REVOKE ALL ON SCHEMA identity FROM PUBLIC`) and src/db/migrations.test.ts:108
 * asserts the grant is absent.
 *
 * It was broken in two places at once, and both of them were on the Family texts page:
 *
 *  - `messaging/mailbox.ts` `resolvePersona` — the phone→contact lookup, reached from
 *    `/family-texts` through `threadFor`;
 *  - `agent/staff-alert.ts` `openAssistantAlerts` — a `LEFT JOIN identity.guardian_contact` for
 *    the adult's name on the "For you" alert cards.
 *
 * Both ran on `getNeonDb()`. Locally they passed, because the PGlite harness connects as the
 * superuser and the superuser can read everything. On the preview the page answered
 * `permission denied for schema identity` and a coordinator saw "the message log could not be
 * read".
 *
 * So this file holds the line twice over, in the two ways a line like this can be held:
 *
 *  1. **With the real privileges.** `appRoleDb` (src/test/pglite.ts) runs every statement as
 *     `app_rw`, so a read that needs `identity` fails here exactly the way it fails on a
 *     deployment. The first test proves the harness really does refuse, and the rest prove the
 *     page's own reads go through on it.
 *  2. **Structurally.** The second block walks the import graph from the page and refuses any
 *     `identity.` SQL in it. That is the test that fails if the join is put back — including in
 *     a module nobody thought of as "the page", which is how it got there the first time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { appRoleDb, freshDb, SITE } from "@/test/pglite";
import { PEPPER } from "@/test/messaging";
import { normalizeE164, phoneHmac } from "./phone";
import { seedAgentScenario, seedProviderRoute, type AgentScenario } from "@/test/agent-state";
import { resolvePersona } from "@/modules/messaging/mailbox";
import { openAssistantAlerts, raiseModelUnavailableAlert } from "@/modules/agent/staff-alert";
import { FAMILIES, KIND, demoId, synLegalName } from "@/modules/demo/fixtures/standard";
import {
  dbIdentityGateway,
  identityGateway,
  syntheticIdentityGateway,
  unwiredIdentityGateway,
} from "./gateway";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";

let pg: PGlite;
/** The superuser connection. Seeding is the migrator's and the gateway's job, not the app's. */
let root: Db;
/** The connection the application actually has: `app_rw`, with no grant on `identity`. */
let app: Db;
let sc: AgentScenario;

beforeEach(async () => {
  ({ pg, db: root } = await freshDb());
  app = appRoleDb(pg);
  sc = await seedAgentScenario(root, { body: "can someone else get him today?" });
});

afterEach(async () => {
  await pg.close();
});

describe("the application role cannot read identity, and the screens no longer ask it to (schema.ts:104)", () => {
  it("the harness enforces the real role split: identity is refused on the app connection", async () => {
    // The exact failure the preview gave. If this ever stops throwing, the harness has stopped
    // modelling the deployment and every other test in this file is worthless.
    await expect(app.query("SELECT count(*) FROM identity.guardian_contact", [])).rejects.toThrow(
      /permission denied for schema identity/i,
    );
    // ops is the app's own schema and is readable, so the refusal above is about identity and
    // not about a harness that refuses everything.
    const ok = await app.query<{ n: string }>("SELECT count(*)::text n FROM ops.site", []);
    expect(Number(ok.rows[0].n)).toBeGreaterThan(0);
  });

  it("handing the DEPLOYED gateway the app connection re-creates the bug — which is why no page does", async () => {
    /*
     * `dbIdentityGateway` is the identity SQL. It is correct, and it is refused here, because
     * the connection is `app_rw` rather than `identity_gateway` (0001_roles.sql). This is the
     * permanent, executable form of the mutation proof: reintroducing the old call — the gateway
     * or the join, over `getNeonDb()` — fails exactly like this.
     */
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).contactForPhone(sc.number),
    ).rejects.toThrow(/permission denied for schema identity/i);
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).namesForContacts([sc.contactToken]),
    ).rejects.toThrow(/permission denied for schema identity/i);

    // The same statements, on a connection that may run them, answer.
    const viaRoot = await dbIdentityGateway(root, { pepper: PEPPER }).contactForPhone(sc.number);
    expect(viaRoot?.contactToken).toBe(sc.contactToken);
  });

  it("resolvePersona answers on the app connection, because the lookup is the gateway's", async () => {
    /*
     * The F2 number is a demo fixture's, so `identityGateway()` — the synthetic gateway this
     * data class runs (ADR-015) — knows it without a database. The point of the assertion is
     * the `app` connection: before the fix this call threw `permission denied`, which is what
     * `threadFor`'s catch turned into "the message log could not be read" on every render.
     */
    const family = FAMILIES[1];
    const number = family.guardian.phone;
    const persona = await resolvePersona(app, {
      number,
      pepper: PEPPER,
      gateway: syntheticIdentityGateway(PEPPER),
    });
    expect(persona).toMatchObject({
      contactToken: demoId(KIND.contact, 2),
      familyGroupId: demoId(KIND.family, 2),
    });
  });

  it("the For you alerts load on the app connection, and still name the adult", async () => {
    await raiseModelUnavailableAlert(root, {
      siteId: sc.siteId,
      messageId: sc.messageId,
      reason: "provider_error",
      by: "test",
    });

    /*
     * The name comes from the gateway, in one batched call after the ops read — so the query
     * itself is pure `ops` and runs as `app_rw`, and the name is still on the card. The gateway
     * here is the deployed one over the superuser connection, which is what P2's separate
     * `identity_gateway` connection will be.
     */
    const named = await openAssistantAlerts(app, [sc.siteId], dbIdentityGateway(root, { pepper: PEPPER }));
    expect(named).toHaveLength(1);
    // `guardianShortName` cuts the stored legal name down to first-name-plus-initial (§15.2).
    expect(named[0].sentence).toContain("SYN G.");

    // And with no gateway wired at all it still loads: the adult is simply not named. A card
    // that cannot name somebody beats a tab that throws (display-name.ts's fail-soft rule).
    const unnamed = await openAssistantAlerts(app, [sc.siteId], unwiredIdentityGateway());
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0].sentence).not.toContain("SYN G.");
  });

  it("an alert at another site is still not selected, gateway or no gateway", async () => {
    await raiseModelUnavailableAlert(root, {
      siteId: sc.siteId, messageId: sc.messageId, reason: "provider_error", by: "test",
    });
    expect(await openAssistantAlerts(app, [SITE === sc.siteId ? "00000000-0000-7000-8000-0000000000b1" : SITE], unwiredIdentityGateway())).toEqual([]);
  });
});

describe("the synthetic gateway is the seed's own rows, not an approximation", () => {
  it("returns the contact token and the legal name the seed writes", async () => {
    const gateway = syntheticIdentityGateway(PEPPER);
    for (const [i, family] of FAMILIES.entries()) {
      const contact = await gateway.contactForPhone(family.guardian.phone);
      // src/modules/demo/seed.ts:126 (`contactId`) and :252 (the guardian_contact insert).
      expect(contact?.contactToken).toBe(demoId(KIND.contact, i + 1));
      expect(contact?.legalName).toBe(synLegalName(family.guardian.firstName, family.guardian.lastInitial));
    }
  });

  it("knows nothing about a number no family holds, and nothing without a pepper", async () => {
    expect(await syntheticIdentityGateway(PEPPER).contactForPhone("+15615559999")).toBeNull();
    expect(await syntheticIdentityGateway(PEPPER).contactForPhone("nonsense")).toBeNull();
    expect(await syntheticIdentityGateway(undefined).contactForPhone(FAMILIES[0].guardian.phone)).toBeNull();
  });

  it("is the gateway this data class chooses (ADR-015)", async () => {
    const env = { [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS, HMAC_PEPPER: PEPPER };
    expect(await identityGateway(env).contactForPhone(FAMILIES[0].guardian.phone)).not.toBeNull();
    // Any other data class has no gateway connection yet, and says so by knowing nothing.
    expect(await identityGateway({ HMAC_PEPPER: PEPPER }).contactForPhone(FAMILIES[0].guardian.phone)).toBeNull();
  });
});

/* ─────────────── the structural half: no identity SQL in the page's graph ─────────────── */

const ROOT = resolve(__dirname, "..", "..", "..");
/**
 * The entry points this rule covers: the Family texts page (both tabs are one route) and the
 * server action behind its buttons. Anything either of them can reach is "the page".
 */
const ENTRIES = [
  "src/app/(app)/family-texts/page.tsx",
  "src/app/(app)/family-texts/actions.ts",
];
/**
 * The modules that may name an `identity` table. **There is exactly one** (S1-6; Firia's ruling 2,
 * 2026-10-18 2:48 AM ET), and the list being a single item is the whole claim.
 *
 * It used to have four entries. Three of them — `outbox/policy.ts`, `agent/run/exec/reads.ts` and
 * `agent/run/exec/capability.ts` — were argued for on the grounds that they run on the drain or
 * the agent's run path rather than on a page render, and the argument was wrong: those paths were
 * handed the application connection too (`outbox/deps.ts` built the authorizer from `getNeonDb()`,
 * and `ExecutorDeps.db` *is* that connection), so `permission denied for schema identity` was
 * waiting on each of them as surely as it was on the page. Three more were never in this graph at
 * all and had the same bug: `messaging/inbound.ts`, `messaging/consent.ts` and
 * `messaging/sim-provider.ts`.
 *
 * All six are the gateway's questions now, so the exception list is empty and what is left is the
 * gateway itself, whose whole job is to be the one place that holds the SQL. A page reaches it
 * only through `identityGateway()`, which in this data class is the synthetic implementation and
 * runs none of it.
 *
 * (`src/db/schema.ts` is NOT on the list and does not need to be: `identity.table(…)` is
 * drizzle's schema builder rather than a table name, and `identityTablesIn` drops it. The file is
 * the *declaration* of the restriction, at line 104.)
 */
const MAY_NAME_IDENTITY = ["src/modules/identity/gateway.ts"];

/** The two modules the preview actually died in. Named on their own so a regression is obvious. */
const THE_TWO_THAT_BROKE = [
  "src/modules/messaging/mailbox.ts",
  "src/modules/agent/staff-alert.ts",
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
/** `identity.<table>` in a string, which is the only way this app spells a table. */
const IDENTITY_SQL = /\bidentity\.[a-z_]+/g;

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(ROOT, "src", spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(join(ROOT, from)), spec)
      : null;
  if (base === null) return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = `${base}${ext}`;
    try {
      readFileSync(p, "utf8");
      return relative(ROOT, p);
    } catch { /* next candidate */ }
  }
  return null;
}

function graphFrom(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try { source = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
    for (const m of source.matchAll(IMPORT_RE)) {
      const next = resolveImport(file, m[1] ?? m[2]);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/**
 * The identity tables a file names, in code — comments are prose about the rule rather than a
 * query, and `identity.table` is drizzle's schema builder rather than a table at all.
 */
function identityTablesIn(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return [...new Set([...code.matchAll(IDENTITY_SQL)].map((m) => m[0]))]
    .filter((name) => name !== "identity.table")
    .sort();
}

describe("nothing the Family texts page can reach queries identity (src/db/schema.ts:104)", () => {
  it("walks a real graph, so the rule cannot be satisfied by an empty one", () => {
    const graph = graphFrom(ENTRIES);
    // Sanity: the two modules that held the bug are genuinely in it.
    expect(graph).toContain("src/modules/messaging/mailbox.ts");
    expect(graph).toContain("src/modules/agent/staff-alert.ts");
    expect(graph.size).toBeGreaterThan(40);
  });

  it("NEITHER module that broke the preview names an identity table any more", () => {
    // The mutation proof in standing form. Put the `LEFT JOIN identity.guardian_contact` back in
    // staff-alert.ts, or the `FROM identity.guardian_contact` back in mailbox.ts, and this fails.
    for (const file of THE_TWO_THAT_BROKE) {
      expect(identityTablesIn(file), `${file} queries identity on the app connection`).toEqual([]);
    }
  });

  it("the set of modules in the page's graph that name one is exactly the argued-for list", () => {
    const naming = [...graphFrom(ENTRIES)].filter((f) => identityTablesIn(f).length > 0).sort();
    expect(
      naming,
      "a module in the Family texts graph grew identity SQL. It runs as app_rw, which has no " +
        "SELECT on that schema (src/db/schema.ts:104) — route it through IdentityGateway, or " +
        "argue for it in MAY_NAME_IDENTITY with the connection it runs on",
    ).toEqual([...MAY_NAME_IDENTITY].sort());
  });

  it("the gateway's own identity SQL is still there, so the rule above is about placement", () => {
    expect(identityTablesIn("src/modules/identity/gateway.ts")).toContain("identity.guardian_contact");
  });
});

/* ───────────── S1-6: the drain, the webhook and the agent's run path, too ───────────── */

/**
 * **EVERY PATH, NOT JUST THE PAGE** — Firia's ruling 2, 2026-10-18 2:48 AM ET:
 *
 *   "S1, BLOCKS MERGE: the drain, webhook and agent paths still read identity.* on the APP
 *    connection: src/modules/outbox/policy.ts:134, and inbound.ts:126, consent.ts:88,
 *    sim-provider.ts:160, reads.ts:194, capability.ts:406. Route every one through the EXISTING
 *    identity gateway, the same way S1-0 did mailbox.ts and staff-alert.ts. … Add a test citing
 *    src/db/schema.ts:104 that FAILS if any drain, webhook or agent path (and ideally any
 *    non-gateway module) queries identity.* on the app connection."
 *
 * The rule is src/db/schema.ts:104: "App role `app_rw` gets NO select on these; only
 * `identity_gateway` role (used by IdentityGateway) does."
 *
 * The block above walks the Family texts page's import graph. That was the right net for S1-0 and
 * it is the wrong one for this, because none of these six is on a page at all — they are the SMS
 * webhook, the outbox drain and the agent's run. So the net here is **the whole tree**: no file
 * under `src/` outside `MAY_NAME_IDENTITY` may name an identity table, which is a rule no new
 * module can be outside of by accident.
 *
 * The three assertions after it are the other half, because a file can be free of identity SQL
 * and still be wrong: what matters at the call site is which *connection* the gateway is built
 * from. `outbox/deps.ts` built its authorizer from `getNeonDb()` and that one line was the drain's
 * whole bug.
 */
describe("no module outside the gateway queries identity, on any path (src/db/schema.ts:104)", () => {
  /**
   * Every **production** `.ts`/`.tsx` under `src/`: no `*.test.ts` and nothing under `src/test/`.
   *
   * Deliberately not the tests. A suite that inserts an `identity` row does so on the
   * migrator/superuser handle it owns, is in no build or boot graph, and is usually writing the
   * very rows the gateway is then asked about (`src/test/messaging.ts`, `migrations.test.ts`).
   * Including them would turn this rule into a list of exceptions, which is how the four-entry
   * list this file used to carry stopped meaning anything.
   */
  function productionSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (relative(ROOT, full) !== join("src", "test")) walk(full);
        } else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) {
          out.push(relative(ROOT, full));
        }
      }
    };
    walk(join(ROOT, "src"));
    return out;
  }

  it("scans the whole tree, so the rule cannot be satisfied by a short list", () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(200);
    // The six modules ruling 2 named are all really in it, whatever they contain now.
    for (const named of THE_SIX_RULING_2_NAMED) expect(files, named).toContain(named);
  });

  it("knows the identity schema's own four tables, so the scan is not matching a variable", () => {
    /*
     * `identity` is also the name of a *copy object* (`copy.identity.account`, read by
     * ConsoleShell) and of a drizzle schema builder, so "the word `identity` followed by a dot"
     * finds things that are not tables at all. The scan is keyed on the four real table names
     * instead, and those are read off the schema file that declares them — src/db/schema.ts:104's
     * block — so a fifth identity table cannot appear without appearing here.
     */
    const declared = [...codeOf("src/db/schema.ts").matchAll(/identity\.table\("([a-z_]+)"/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...IDENTITY_TABLES].sort());
  });

  it("the ONLY production module naming an identity table is the gateway", () => {
    const naming = productionSources()
      .filter((f) => identityTablesNamedIn(f).length > 0)
      .sort();
    expect(
      naming,
      "a module grew identity SQL. It runs as app_rw, which has no SELECT on that schema " +
        "(src/db/schema.ts:104) — route it through IdentityGateway",
    ).toEqual([...MAY_NAME_IDENTITY_IN_PRODUCTION].sort());
  });

  it("and none of the six ruling 2 named has any left", () => {
    // The mutation proof in standing form: put `FROM identity.guardian_contact` back into any one
    // of these and this line fails, naming the file.
    for (const file of THE_SIX_RULING_2_NAMED) {
      expect(identityTablesNamedIn(file), `${file} queries identity on the app connection`).toEqual([]);
    }
  });

  it("the drain builds its authorizer from the GATEWAY, never from getNeonDb()", () => {
    /*
     * src/modules/outbox/deps.ts was the drain's bug in one line: `dbRecipientAuthorizer(db)`,
     * where `db` is `getNeonDb()`. It still calls `getNeonDb()` — the SIM provider needs an `ops`
     * connection — so the check is about what reaches the *authorizer*.
     */
    const deps = codeOf("src/modules/outbox/deps.ts");
    expect(deps).toMatch(/authorizer:\s*gatewayRecipientAuthorizer\(identityGateway\(\)\)/);
    expect(deps).not.toMatch(/dbRecipientAuthorizer\s*\(\s*db\s*\)/);
  });

  it("the webhook and the agent's executors both carry a gateway of their own", () => {
    // Optional, defaulting to this data class's own — so a call site cannot silently have none.
    expect(codeOf("src/modules/messaging/inbound.ts")).toMatch(/gateway\?:\s*IdentityGateway/);
    expect(codeOf("src/modules/messaging/inbound.ts")).toMatch(/deps\.gateway \?\? identityGateway\(\)/);
    expect(codeOf("src/modules/agent/run/exec/effects.ts")).toMatch(/gateway\?:\s*IdentityGateway/);
    expect(codeOf("src/modules/agent/run/exec/effects.ts")).toMatch(/deps\.gateway \?\? identityGateway\(\)/);
  });
});

/** The identity schema's tables, asserted above against the ones src/db/schema.ts declares. */
const IDENTITY_TABLES = ["child_identity", "guardian_contact", "consent_event", "external_person_identity"];

/**
 * Where an identity table may be named in production code, and why each one is here.
 *
 *  - the **gateway**, whose whole job is to be the one place that holds the SQL;
 *  - the **demo seed**, which *writes* the rows. It is the source of every identity row in this
 *    data class (ADR-015) and it runs on the reset path as the migrator, never on a request. It is
 *    also already fenced in by `build-isolation.test.ts`, which holds that no build or boot entry
 *    point can reach it at all.
 */
const MAY_NAME_IDENTITY_IN_PRODUCTION = [
  "src/modules/identity/gateway.ts",
  "src/modules/demo/seed.ts",
];

/** The identity tables a file names in code — by table name, so a copy object is not a query. */
function identityTablesNamedIn(file: string): string[] {
  const code = codeOf(file);
  return IDENTITY_TABLES.filter((t) => new RegExp(`\\bidentity\\.${t}\\b`).test(code)).sort();
}

/**
 * THE FIVE STATEMENTS ARE STILL REAL SQL, AND STILL REFUSED ON THE APP ROLE.
 *
 * Moving a query behind an interface is only a fix if the query still runs. Each of S1-6's five
 * questions is exercised twice here: once on `root`, which may read `identity` and therefore
 * proves the statement matches the migrations, and once on `app`, which is `app_rw` and gives the
 * exact `permission denied for schema identity` a deployment gives.
 *
 * That second half is the mutation proof in permanent form. Re-introducing any of these as a
 * direct query — on `deps.db`, on the webhook's `tx`, on `outboxDeps()`'s connection — is the
 * same thing as calling `dbIdentityGateway(app, …)`, and it fails here.
 */
describe("S1-6's five statements run on a gateway connection and are refused on the app's", () => {
  const refused = /permission denied for schema identity/i;

  /** The blind index of the scenario's own number, the way every caller derives it. */
  const senderHmac = () => phoneHmac(normalizeE164(sc.number)!, PEPPER);

  it("senderForPhoneHmac — the webhook's and the agent's sender lookup", async () => {
    const at = new Date();
    const viaRoot = await dbIdentityGateway(root, { pepper: PEPPER }).senderForPhoneHmac({
      siteId: sc.siteId, phoneHmac: senderHmac(), at,
    });
    expect(viaRoot?.contactToken).toBe(sc.contactToken);
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).senderForPhoneHmac({ siteId: sc.siteId, phoneHmac: senderHmac(), at }),
    ).rejects.toThrow(refused);
  });

  it("routeForRecipient — the SIM provider's addressing", async () => {
    const viaRoot = await dbIdentityGateway(root, { pepper: PEPPER }).routeForRecipient({
      siteId: sc.siteId, recipientToken: sc.contactToken,
    });
    expect(viaRoot.phoneHmac).toBe(senderHmac());
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).routeForRecipient({ siteId: sc.siteId, recipientToken: sc.contactToken }),
    ).rejects.toThrow(refused);
  });

  it("egressFacts — the drain's own consent check", async () => {
    const at = new Date();
    const viaRoot = await dbIdentityGateway(root, { pepper: PEPPER }).egressFacts({
      siteId: sc.siteId, recipientToken: sc.contactToken, kind: "guardian", channel: "SMS_1TO1", at,
    });
    expect(viaRoot.onFile).toBe(true);
    expect(viaRoot.guardian?.canReceiveUpdates).toBe(true);
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).egressFacts({
        siteId: sc.siteId, recipientToken: sc.contactToken, kind: "guardian", channel: "SMS_1TO1", at,
      }),
    ).rejects.toThrow(refused);
  });

  it("appendConsent — the consent ledger, which WRITES", async () => {
    const at = new Date();
    const wrote = await dbIdentityGateway(root, { pepper: PEPPER }).appendConsent({
      siteId: sc.siteId, contactToken: sc.contactToken, channel: "SMS_1TO1", kind: "STOP", at,
      evidenceMessageId: null,
    });
    expect(wrote.newest?.kind).toBe("STOP");
    // The row is really in the ledger, which is what makes the refusal below about privilege.
    const rows = await root.query<{ kind: string }>(
      "SELECT kind FROM identity.consent_event WHERE id = $1", [wrote.consentEventId],
    );
    expect(rows.rows[0].kind).toBe("STOP");
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).appendConsent({
        siteId: sc.siteId, contactToken: sc.contactToken, channel: "SMS_1TO1", kind: "STOP", at,
        evidenceMessageId: null,
      }),
    ).rejects.toThrow(refused);
  });

  it("phoneHmacForPerson — the capability report's dispatcher check", async () => {
    /*
     * A provider route with a dispatcher, which is the shape `record_provider_capability` reads:
     * the van's provider's `dispatcher_person_token`, and that person's blind index. Seeded here
     * rather than assumed, because the base scenario has no provider in it.
     */
    const route = await seedProviderRoute(root, {
      siteId: sc.siteId,
      serviceDate: sc.serviceDate,
      windowStart: sc.receivedAt,
    });
    const dispatcherToken = route.dispatcherToken;
    expect(dispatcherToken, "seedProviderRoute gives the provider a dispatcher").toBeTruthy();
    const viaRoot = await dbIdentityGateway(root, { pepper: PEPPER }).phoneHmacForPerson({
      siteId: sc.siteId, personToken: dispatcherToken!,
    });
    expect(viaRoot).not.toBeNull();
    await expect(
      dbIdentityGateway(app, { pepper: PEPPER }).phoneHmacForPerson({ siteId: sc.siteId, personToken: dispatcherToken! }),
    ).rejects.toThrow(refused);
  });
});

/** The six modules Firia's ruling 2 named, by path, so the scan above cannot miss one. */
const THE_SIX_RULING_2_NAMED = [
  "src/modules/outbox/policy.ts",
  "src/modules/messaging/inbound.ts",
  "src/modules/messaging/consent.ts",
  "src/modules/messaging/sim-provider.ts",
  "src/modules/agent/run/exec/reads.ts",
  "src/modules/agent/run/exec/capability.ts",
];

/**
 * Test helpers that INSERT identity rows, which is a different act from querying one on the app
 * connection: they run on the migrator/superuser handle a suite owns, they are not in any build or
 * boot graph, and the rows they write are what the gateway is then asked about. Named one at a
 * time rather than excluded by a `test/` prefix, so a *production* module cannot hide behind the
 * same rule.
 */
const TEST_FILES_THAT_SEED_IDENTITY = [
  "src/test/agent-state.ts",
  "src/test/messaging.ts",
  "src/modules/demo/seed.ts",
  "src/modules/identity/identity-off-the-app-connection.test.ts",
];

/** A file's code, comments stripped — prose about a table is not a query. */
function codeOf(file: string): string {
  const source = readFileSync(join(ROOT, file), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
