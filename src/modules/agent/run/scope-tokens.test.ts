/**
 * ONE MAPPING, BOTH WAYS (Veri's review, demo item 3).
 *
 * The bug this file pins down: `identity/names.ts` hands the model fixture keys — a family's "can
 * Noah be dropped at 5" reaches the prompt as "can C2 be dropped at 5" — while `assembler.ts`
 * built the scope out of uuids. So the model answered in the only language the context gave it and
 * every call it made was refused as out-of-scope. The dictionary in `scope-tokens.ts` closes that,
 * and the two halves of this file are the two directions:
 *
 *  - **outward** — the prompt names a child, a leg, a thread and a van by the labels the model
 *    will be held to, and nothing in the tiers is a uuid the model has no way to talk about;
 *  - **inward** — a call that uses one of those labels is judged, and executed, against the id the
 *    row actually has, while a label this run does not hold stays exactly as the model wrote it
 *    and is refused by the same scope validator as before.
 *
 * That second clause is the one that matters for security, so it is tested from both ends: a
 * token that *is* in scope resolves, and a token that is a perfectly valid fixture key belonging
 * to **another family** resolves to nothing and is blocked. Resolution can only name something
 * already inside the scope; it can never widen one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { evaluate, familyScope } from "@/modules/agent/policy";
import { CHILDREN, demoChildToken, demoLegId } from "@/modules/demo/fixtures/standard";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { dbContextAssembler } from "./assembler";
import { NO_SCOPE_TOKENS, demoTokenForId, resolveScopeTokens, scopeTokens } from "./scope-tokens";

/** The demo child this file puts into the thread's own family, and the one it never may touch. */
const MINE = "C2";
const THEIRS = "C7";

describe("the dictionary itself", () => {
  it("answers in both directions, and only about pairs it was given", () => {
    const tokens = scopeTokens([{ token: "C2", id: "id-2" }, { token: "L-C2-PM", id: "id-leg" }]);

    expect(tokens.idFor("C2")).toBe("id-2");
    expect(tokens.tokenFor("id-2")).toBe("C2");
    expect(tokens.idFor("L-C2-PM")).toBe("id-leg");
    // A token it does not hold is not an id, and is not invented into one.
    expect(tokens.idFor(THEIRS)).toBeNull();
    // An id it does not hold is passed through as itself, so a caller can always write something.
    expect(tokens.tokenFor("id-unknown")).toBe("id-unknown");
  });

  it("keeps the first pair for a token or an id, so a later one cannot redefine it", () => {
    const tokens = scopeTokens([
      { token: "C2", id: "first" },
      { token: "C2", id: "second" },
      { token: "other", id: "first" },
    ]);
    expect(tokens.idFor("C2")).toBe("first");
    expect(tokens.idFor("other")).toBeNull();
    expect(tokens.tokenFor("first")).toBe("C2");
    expect(tokens.pairs).toHaveLength(1);
  });

  it("the empty dictionary resolves nothing and renames nothing", () => {
    expect(NO_SCOPE_TOKENS.idFor("C2")).toBeNull();
    expect(NO_SCOPE_TOKENS.tokenFor("anything")).toBe("anything");
  });

  /**
   * The demo half is the seed's own id function run backwards, so this asserts against the
   * function rather than against a copied-out uuid — a changed `demoId` has to break here.
   */
  it("reads a synthetic id back to the fixture label the seed wrote it from", () => {
    expect(demoTokenForId(demoChildToken(MINE))).toBe(MINE);
    expect(demoTokenForId(demoLegId(MINE, "PM"))).toBe(`L-${MINE}-PM`);
    expect(demoTokenForId(demoLegId(MINE, "AM"))).toBe(`L-${MINE}-AM`);
    // Every fixture child round-trips, so the table is not just right for the demo's own family.
    for (const child of CHILDREN) expect(demoTokenForId(demoChildToken(child.key))).toBe(child.key);
    // An id no fixture accounts for has no label, and saying so is the point: real data gets none.
    expect(demoTokenForId(uuidv7())).toBeNull();
  });
});

describe("resolving a call's arguments", () => {
  const tokens = scopeTokens([{ token: "C2", id: "child-uuid" }, { token: "L-C2-PM", id: "leg-uuid" }]);

  it("replaces a reference, at any depth, and leaves everything else alone", () => {
    expect(
      resolveScopeTokens(
        {
          child_token: "C2",
          day_part: "PM",
          expected_version: 3,
          expected_self_arrival: null,
          options: [{ leg_ids: ["L-C2-PM"], added_minutes: 10 }],
        },
        tokens,
      ),
    ).toEqual({
      child_token: "child-uuid",
      day_part: "PM",
      expected_version: 3,
      expected_self_arrival: null,
      options: [{ leg_ids: ["leg-uuid"], added_minutes: 10 }],
    });
  });

  /**
   * Whole values only. A staff note that mentions a token is prose for a person to read, and
   * rewriting a uuid into the middle of a sentence would be a worse bug than the one being fixed.
   */
  it("does not rewrite a token inside a sentence", () => {
    expect(resolveScopeTokens({ claim_summary: "C2 is being collected early" }, tokens)).toEqual({
      claim_summary: "C2 is being collected early",
    });
  });

  it("leaves a token it cannot resolve exactly as the model wrote it", () => {
    expect(resolveScopeTokens({ child_token: THEIRS }, tokens)).toEqual({ child_token: THEIRS });
  });
});

/* ──────────────── and the same thing, against the database and the real gate ──────────────── */

let pg: PGlite;
let db: Db;
let scenario: AgentScenario;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
}, 60_000);

afterEach(async () => {
  await pg.close();
});

/**
 * Put a **demo-seeded** child into the thread's own family: `seedAgentScenario` mints random
 * uuids, which is right for the suites that only need real uuid columns, but the token mapping is
 * exactly the thing that only has labels for the ids the demo seed wrote. So this adds one child
 * and its two legs with the seed's own ids, which is what a demo deployment holds.
 */
async function addDemoChild(sc: AgentScenario, childKey: string): Promise<{ child: string; pmLeg: string }> {
  const child = demoChildToken(childKey);
  await db.query(
    `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
     VALUES ($1, $2, $3, 'Syn D.', 'test', 'test')`,
    [child, sc.siteId, sc.familyGroupId],
  );
  await db.query(
    `INSERT INTO ops.contact_authorization (id, site_id, contact_token, child_token, scope, channel, valid_from, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'RECEIVE_TRANSPORT_UPDATES', 'SMS_1TO1', $5, 'test', 'test')`,
    [uuidv7(), sc.siteId, sc.contactToken, child, sc.receivedAt.toISOString()],
  );
  await db.query(
    `INSERT INTO ops.attendance_day (id, site_id, child_token, service_date, state, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'SCHEDULED', 'test', 'test')`,
    [uuidv7(), sc.siteId, child, sc.serviceDate],
  );
  for (const direction of ["AM", "PM"] as const) {
    await db.query(
      `INSERT INTO ops.trip_leg (id, site_id, child_token, service_date, direction, mode, state, plan_version, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'PROVIDER', 'SCHEDULED', 1, 'test', 'test')`,
      [demoLegId(childKey, direction), sc.siteId, child, sc.serviceDate, direction],
    );
  }
  return { child, pmLeg: demoLegId(childKey, "PM") };
}

const assemble = () =>
  dbContextAssembler(db, { env: {} })({
    runId: "01900000-0000-7000-8000-0000000000aa",
    trigger: { type: "msg.inbound", id: scenario.messageId, siteId: scenario.siteId },
    committed: [],
    now: TEST_NOW,
  });

describe("outward: the prompt names things the way the model will be held to", () => {
  it("writes the child and the leg as their labels, not as uuids", async () => {
    scenario = await seedAgentScenario(db, { body: "can we move the afternoon drop-off" });
    const demo = await addDemoChild(scenario, MINE);

    const { prompt, tokens } = await assemble();

    expect(prompt).toContain(`child=${MINE}`);
    expect(prompt).toContain(`leg=L-${MINE}-PM`);
    // The uuid itself is gone from the prompt: there is nothing left for the model to copy out.
    expect(prompt).not.toContain(demo.child);
    expect(prompt).not.toContain(demo.pmLeg);
    // And the dictionary that did it came back on the context, for the loop to read calls through.
    expect(tokens?.idFor(MINE)).toBe(demo.child);
    expect(tokens?.idFor(`L-${MINE}-PM`)).toBe(demo.pmLeg);
  });

  it("tokenizes the family's own words to the same label the tiers use", async () => {
    scenario = await seedAgentScenario(db, { body: "will Rudabeh be dropped at 5" });
    await addDemoChild(scenario, MINE);
    await db.query("UPDATE ops.child_profile SET display_name = 'Rudabeh K.' WHERE child_token = $1", [
      demoChildToken(MINE),
    ]);

    const { prompt } = await assemble();

    // One language across T2 and T3: the message says what the state says.
    expect(prompt).toContain(`will ${MINE} be dropped at 5`);
    expect(prompt).toContain(`child=${MINE}`);
    expect(prompt).not.toContain("Rudabeh");
  });
});

describe("inward: a call in labels, judged against the ids the rows have", () => {
  it("resolves an in-scope label and the gate allows the call", async () => {
    scenario = await seedAgentScenario(db, { body: "can we move the afternoon drop-off" });
    const demo = await addDemoChild(scenario, MINE);
    const { policy, tokens } = await assemble();

    // What the model sends, in the labels it was given.
    const args = resolveScopeTokens({ leg_id: `L-${MINE}-PM` }, tokens!);

    expect(args).toEqual({ leg_id: demo.pmLeg });
    expect(evaluate({ tool: "get_leg_state", args }, policy).verdict).toBe("ALLOW");
  });

  /**
   * The security half. `C7` is a real fixture key — this process can derive its uuid perfectly
   * well — and it belongs to another family. It must resolve to nothing, survive into the call as
   * written, and be refused by the scope validator exactly as an invented id would be.
   */
  it("refuses another family's label, even though the fixtures know it", async () => {
    scenario = await seedAgentScenario(db, { body: "what about the other kids" });
    await addDemoChild(scenario, MINE);
    const { policy, tokens } = await assemble();

    expect(tokens?.idFor(THEIRS)).toBeNull();

    const args = resolveScopeTokens({ child_token: THEIRS }, tokens!);
    expect(args).toEqual({ child_token: THEIRS });

    const decision = evaluate(
      {
        tool: "cancel_attendance_or_leg",
        args: {
          ...args,
          date: scenario.serviceDate,
          day_part: "PM",
          reason_code: "PARENT_PICKUP",
          expected_self_arrival: null,
          expected_version: 1,
        },
      },
      policy,
    );
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.verdict === "BLOCK" && decision.rule).toBe("cross_family_disclosure");
    // And the uuid that label stands for never entered the scope.
    expect(policy.scope.tokens.has(demoChildToken(THEIRS))).toBe(false);
  });

  /** Belt: the dictionary is built from the scope, so it cannot hold a pair the scope lacks. */
  it("holds no label for anything outside this run's scope", async () => {
    scenario = await seedAgentScenario(db, { body: "is the van coming" });
    await addDemoChild(scenario, MINE);
    const { policy, tokens } = await assemble();

    for (const pair of tokens?.pairs ?? []) {
      const known = policy.scope.tokens.has(pair.id) || policy.scope.shared.has(pair.id);
      expect({ token: pair.token, known }).toEqual({ token: pair.token, known: true });
    }
  });
});

/** The hand-built contexts the other suites use carry no dictionary, and must keep working. */
describe("no dictionary", () => {
  it("passes a call through untouched", () => {
    const scope = familyScope("F1", ["C1", "L-C1-AM"]);
    const args = resolveScopeTokens({ leg_id: "L-C1-AM" }, NO_SCOPE_TOKENS);
    expect(args).toEqual({ leg_id: "L-C1-AM" });
    expect(evaluate({ tool: "get_leg_state", args }, { scope, sendableSubjects: new Set() }).verdict).toBe("ALLOW");
  });
});
