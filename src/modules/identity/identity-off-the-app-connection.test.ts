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
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { appRoleDb, freshDb, SITE } from "@/test/pglite";
import { PEPPER } from "@/test/messaging";
import { seedAgentScenario, type AgentScenario } from "@/test/agent-state";
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
 * The modules that may name an `identity` table, each because of the connection it runs on —
 * and this is an EXACT set, not a floor: a module that starts naming one has to be argued for
 * here, which is the step that was missing when `mailbox.ts` and `staff-alert.ts` grew theirs.
 *
 *  - the gateway, whose whole job is to be the one place that holds the SQL. A page reaches it
 *    only through `identityGateway()`, which in this data class is the synthetic implementation
 *    and runs none of it.
 *
 * (`src/db/schema.ts` is NOT on the list and does not need to be: `identity.table(…)` is
 * drizzle's schema builder rather than a table name, and `identityTablesIn` drops it. The file
 * is the *declaration* of the restriction, at line 104.)
 *  - `outbox/policy.ts` (`dbRecipientAuthorizer`) — the send-time consent check. It is the
 *    original form of this same seam ("ops never reads identity directly", B-08) and it runs on
 *    the outbox drain, never on a page render. Its own comment, :119, says it runs on the
 *    `identity_gateway` connection in deployed envs.
 *  - `agent/run/exec/reads.ts`, `agent/run/exec/capability.ts` — the agent's run path, driven by
 *    the inbound webhook and the job queue. Also not a page render.
 *
 * All three of the last group are in the page's *import* graph (the page imports the agent's
 * alert module, which imports its config, and so on) without being on the page's *call* path.
 * They are S2s of the same family and are listed as follow-ups; what this file holds is that the
 * render path has none.
 */
const MAY_NAME_IDENTITY = [
  "src/modules/identity/gateway.ts",
  "src/modules/outbox/policy.ts",
  "src/modules/agent/run/exec/reads.ts",
  "src/modules/agent/run/exec/capability.ts",
];

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
