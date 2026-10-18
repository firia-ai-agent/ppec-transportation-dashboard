import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { agentAsk, agentTasks } from "@/ui/copy";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "../config";
import { approvalKey } from "../policy";
import { toolCall } from "../providers/fake";
import type { TierFacts } from "../run/context";
import type { PolicyContext } from "../policy";
import { AGENT_RUNNER_NO_CONTEXT_SOURCE, agentRunner } from "../run/deps";
import { liveHarness } from "../run/exec/live-harness";
import { toolCalls } from "../run/store";
import { TRIGGER_TYPES } from "../run/triggers";
import {
  MAX_ASK_LENGTH,
  STAFF_ALERT_TASK_CATEGORY,
  STAFF_ASK_TASK_CATEGORY,
  askAgent,
  normalizeAsk,
} from "./staff-ask";
import { readAgentThread, readAgentThreadOrEmpty } from "./thread";

/**
 * (d) AN ASK MADE FROM THE BUBBLE CREATES A PENDING APPROVAL AND APPLIES NOTHING, and
 * (e) WITH NO MODEL IT RAISES THE STAFF ALERT AND NO KEYWORD PARSER IS REACHABLE.
 *
 * The bubble is Vera's mockup (/workspace/ppec-redesign/mockups/agent-bubble.html, and
 * png/agent-bubble-{closed,open}-{1440,390}.png); this file is the half behind its compose bar.
 *
 * Driven on the PGlite real-migration harness (src/test/pglite.ts) through **the one run loop**,
 * with the scripted fake provider standing in for the model — the same way every other slice-3
 * suite drives it (run/exec/staff.test.ts). What is asserted is the thing the lane is about: a
 * `propose_*` call from an ask leaves a row for a person and moves nothing else.
 */
let pg: PGlite;
let db: Db;
let sc: AgentScenario;
const open: PGlite[] = [];
const now = new Date(TEST_NOW);

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  sc = await seedAgentScenario(db);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["is the van coming"],
  t4: "channel=SMS locale=en-US",
});

const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
  ...over,
});

/** Everything an ask must not move. Compared before and after, as a whole object. */
const stateSnapshot = async () => ({
  legs: (await db.query("SELECT id, state, version, plan_version FROM ops.trip_leg ORDER BY id", [])).rows,
  days: (await db.query("SELECT id, state, version FROM ops.attendance_day ORDER BY id", [])).rows,
  contacts: (await db.query("SELECT id, contact_token, child_token, scope FROM ops.contact_authorization ORDER BY id", []))
    .rows,
  outbound: (await db.query("SELECT id, state FROM ops.outbound_message ORDER BY id", [])).rows,
  messages: (await db.query("SELECT id, direction FROM ops.message ORDER BY id", [])).rows,
  exceptions: (await db.query("SELECT id FROM ops.attendance_exception ORDER BY id", [])).rows,
});

const tasks = async () =>
  (
    await db.query<{ id: string; category: string; severity: string; state: string; summary: string }>(
      "SELECT id, category, severity, state, summary FROM ops.task ORDER BY created_at, id",
      [],
    )
  ).rows;

/** The arguments the model answers an ask with: a reallocation nobody but a person may apply. */
const REALLOCATION = () => ({
  infeasible_vehicle_token: "V-SYN-1",
  leg_ids: [sc.legs[sc.children[0]].AM],
  options: [{ vehicle_token: "V-SYN-2", leg_ids: [sc.legs[sc.children[0]].AM], added_minutes: 12 }],
  rationale_code: "SECUREMENT",
});

/** The ask path, with a harness's deps in place of the runner this deployment refuses. */
function withModel(script: Parameters<typeof liveHarness>[0]["script"], over: Partial<PolicyContext> = {}) {
  const h = liveHarness({ db, script, facts: facts(), policy: policy(over), now: () => now });
  return {
    harness: h,
    deps: {
      runner: () => ({ ok: true as const, deps: h.deps(0) }),
      env: {} as Record<string, string | undefined>,
    },
  };
}

describe("(d) an ask that makes a proposal leaves a pending approval and changes nothing", () => {
  it("starts one run on a staff.ask trigger whose id is the ask's own row", async () => {
    const args = REALLOCATION();
    const { deps } = withModel([toolCall("propose_manifest_reallocation", args)], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    const r = await askAgent(db, { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" }, deps);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The ask is a stored thing before anything is driven, and the run is identified by it.
    const runs = (
      await db.query<{ id: string; trigger_type: string; trigger_id: string }>(
        "SELECT id, trigger_type, trigger_id FROM ops.agent_run",
        [],
      )
    ).rows;
    expect(runs).toHaveLength(1);
    expect([runs[0].trigger_type, runs[0].trigger_id]).toEqual(["staff.ask", r.taskId]);
    expect(TRIGGER_TYPES).toContain("staff.ask");
  });

  it("writes the approval request PENDING, with the task beside it, and applies no change", async () => {
    const before = await stateSnapshot();
    const args = REALLOCATION();
    const { deps } = withModel([toolCall("propose_manifest_reallocation", args)], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    const r = await askAgent(db, { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" }, deps);
    expect(r.ok && r.run.state).toBe("SUCCEEDED");
    if (!r.ok) return;

    // The call was PROPOSED, never executed: no executor runs for a human-tier tool.
    const [call] = await toolCalls(db, r.run.runId);
    expect([call.status, call.policyDecision]).toEqual(["PROPOSED", "PROPOSAL:human_tier_requires_approval"]);
    expect(call.result).toMatchObject({ mutated: false });

    // PENDING = nobody has decided. There is no decided_at and no decision on the row.
    const [ar] = (
      await db.query<{ id: string; task_id: string; decided_at: Date | null; decision: string | null; proposal: Record<string, unknown> }>(
        "SELECT id, task_id, decided_at, decision, proposal FROM ops.approval_request",
        [],
      )
    ).rows;
    expect(ar).toBeDefined();
    expect([ar.decided_at, ar.decision]).toEqual([null, null]);
    expect(ar.proposal).toMatchObject({ approval_key: approvalKey("propose_manifest_reallocation", args) });

    // The exception task the proposal hangs on, plus the ask's own row. Two tasks, both OPEN.
    const rows = await tasks();
    expect(rows.map((t) => [t.category, t.severity, t.state])).toEqual([
      [STAFF_ASK_TASK_CATEGORY, "AMBER", "OPEN"],
      ["INFEASIBLE", "RED", "OPEN"],
    ]);
    expect(rows[1].id).toBe(ar.task_id);

    /*
     * AND THE TARGET DATA IS UNCHANGED. This is the assertion the whole lane turns on: the
     * reallocation names a leg and a vehicle, and neither moved. Mutation-proved — making the
     * loop apply a human-tier call turns this red.
     */
    expect(await stateSnapshot()).toEqual(before);
  });

  it("records the ask itself as the staff-visible row the trigger is named after", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    const r = await askAgent(db, { siteId: sc.siteId, text: "  Van 1   cannot take its runs  ", by: "u1" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ask = (await tasks()).find((t) => t.id === r.taskId);
    // The words around it are copy.ts's; what the person typed is in it, whitespace normalized.
    expect(ask?.summary).toBe(`${agentAsk.asked.summary}: Van 1 cannot take its runs`);
  });

  it("refuses an empty or oversized ask without writing anything", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())]);
    const before = await tasks();
    for (const text of ["", "   ", "x".repeat(MAX_ASK_LENGTH + 1)]) {
      expect(await askAgent(db, { siteId: sc.siteId, text, by: "u1" }, deps)).toEqual({
        ok: false,
        outcome: "rejected",
      });
    }
    expect(await tasks()).toEqual(before);
    expect((await db.query("SELECT id FROM ops.agent_run", [])).rows).toEqual([]);
  });

  it("writes nothing at all on a preview, where the database is read-only", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())]);
    const before = await stateSnapshot();
    const r = await askAgent(
      db,
      { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" },
      { ...deps, env: { VERCEL_ENV: "preview" } },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.outcome).toBe("skipped");
    expect(await tasks()).toEqual([]);
    expect((await db.query("SELECT id FROM ops.agent_run", [])).rows).toEqual([]);
    expect(await stateSnapshot()).toEqual(before);
  });
});

describe("(e) with no model there is a staff alert, and nothing else", () => {
  /**
   * This deployment's real answer: `agentRunner()` refuses, because there is no §11.1 context
   * assembler and a run driven against an invented scope is worse than no run (run/deps.ts).
   * So the production path through the bubble is this test, not the one above.
   */
  it("is what this deployment actually does: the runner refuses by name", () => {
    const runner = agentRunner();
    expect(runner.ok).toBe(false);
    expect(runner.ok === false && runner.reason).toBe(AGENT_RUNNER_NO_CONTEXT_SOURCE);
  });

  it("raises the NEEDS_PERSON alert, RED and open, and drives no run", async () => {
    const before = await stateSnapshot();
    const r = await askAgent(db, { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" }, { env: {} });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.outcome).toBe("unavailable");
    // docs/DATA-MODEL.md, StaffAlert: kind NEEDS_PERSON, severity RED, state OPEN, no proposal.
    const rows = await tasks();
    expect(rows.map((t) => [t.category, t.severity, t.state])).toEqual([[STAFF_ALERT_TASK_CATEGORY, "RED", "OPEN"]]);
    expect(rows[0].summary).toBe(`${agentAsk.unavailable.summary}: Tell the family we are late`);
    // Nothing was driven, nothing was proposed, nothing was sent.
    expect((await db.query("SELECT id FROM ops.agent_run", [])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM ops.approval_request", [])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM ops.change_request", [])).rows).toEqual([]);
    expect(await stateSnapshot()).toEqual(before);
  });

  it("says nothing about the vendor, the model or the key, on the row or in the answer", async () => {
    const r = await askAgent(db, { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" }, { env: {} });
    /*
     * What a person can see: the row on the board, and the two fields the route forwards. The
     * module's `reason` is the *log* channel — it carries the runner's own sentence, which names
     * build milestones — and the route is read here to prove it never leaves the server.
     */
    const route = readFileSync(
      path.resolve(__dirname, "..", "..", "..", "app", "api", "agent", "ask", "route.ts"),
      "utf8",
    );
    expect(route).toMatch(/Response\.json\(\{ ok: result\.ok, outcome: result\.outcome \}/);
    expect(route).not.toMatch(/result\.reason/);
    const forwarded = { ok: r.ok, outcome: r.outcome };
    const said = `${JSON.stringify(forwarded)} ${(await tasks()).map((t) => t.summary).join(" ")}`.toLowerCase();

    /*
     * The vendor and the model are read from the configured ones rather than typed here —
     * no-hardcoded-models.test.ts bans a vendor slug anywhere under src/, this file included,
     * and a check that names them would be the thing it is checking for.
     */
    const config = loadAgentConfig({
      [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
      [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
    });
    expect(said).not.toContain(config.provider.toLowerCase());
    expect(said).not.toContain(config.model.toLowerCase());
    expect(said).not.toContain(config.apiKeyEnvVar.toLowerCase());

    // Nothing key-shaped, no endpoint, no "AI" label, and not the runner's own build-note reason.
    expect(said).not.toMatch(/sk-[a-z0-9]/);
    expect(said).not.toMatch(/https?:\/\//);
    expect(said).not.toMatch(/\bai\b/);
    expect(said).not.toContain(AGENT_RUNNER_NO_CONTEXT_SOURCE.toLowerCase());
  });

  it("raises the same alert when the model is reached and fails", async () => {
    const before = await tasks();
    const r = await askAgent(
      db,
      { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" },
      {
        env: {},
        // A runner that exists and a drive that throws: a PROVIDER_ERROR, a missing key, a refusal.
        runner: () => ({ ok: true as const, deps: {} as never }),
        drive: async () => {
          throw new Error("provider unreachable");
        },
      },
    );
    expect(r.ok === false && r.outcome).toBe("unavailable");
    const added = (await tasks()).filter((t) => !before.some((b) => b.id === t.id));
    expect(added.map((t) => [t.category, t.severity, t.state])).toEqual([
      [STAFF_ASK_TASK_CATEGORY, "AMBER", "OPEN"],
      [STAFF_ALERT_TASK_CATEGORY, "RED", "OPEN"],
    ]);
  });

  /**
   * NO KEYWORD PARSER. `providers/keyword.ts` is on this branch and the remote adapter's model
   * chain can still reach it, but nothing the bubble's ask path imports does — the degraded mode
   * is a person, not a worse machine (founder's rule, docs/DATA-MODEL.md M3).
   *
   * Walked rather than grepped: a direct `import` is easy to not write, and the thing that would
   * actually reintroduce the parser is a module three hops away picking it up.
   */
  it("cannot reach the keyword parser from the ask path", () => {
    const SRC = path.resolve(__dirname, "..", "..", "..");
    const seen = new Set<string>();
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/")
        ? path.join(SRC, spec.slice(2))
        : spec.startsWith(".")
          ? path.resolve(path.dirname(from), spec)
          : null;
      if (!base) return null;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        try {
          readFileSync(candidate, "utf8");
          return candidate;
        } catch {
          /* not this one */
        }
      }
      return null;
    };
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      // Value imports only: a `import type {...}` is erased and reaches nothing at runtime.
      for (const m of source.matchAll(/^import\s+(?!type\s)(?:[\s\S]*?)\sfrom\s+"([^"]+)";/gm)) {
        const next = resolve(file, m[1]);
        if (next) walk(next);
      }
    };
    walk(path.join(__dirname, "staff-ask.ts"));

    expect(seen.size).toBeGreaterThan(5);
    const keyword = path.join(SRC, "modules", "agent", "providers", "keyword.ts");
    expect([...seen].filter((f) => f === keyword)).toEqual([]);
    // And the remote adapter, which is what *does* reach it, is not on this path either.
    expect([...seen].filter((f) => f.endsWith(path.join("providers", "remote.ts")))).toEqual([]);
  });
});

describe("the thread the panel draws is read from rows this app holds", () => {
  it("is empty, and says nothing, on a day with nothing in it", async () => {
    expect(await readAgentThread(db, sc.siteId)).toEqual({ items: [], waiting: 0 });
  });

  it("shows the ask, then the proposal it produced, in the order they happened", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    await askAgent(db, { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" }, deps);

    const view = await readAgentThread(db, sc.siteId);
    // png/agent-bubble-open-1440.png: a day label, then the conversation interleaved.
    expect(view.items.map((i) => i.kind)).toEqual(["day", "staff", "proposal"]);
    expect(view.items[1]).toMatchObject({ kind: "staff", text: "Van 1 cannot take its runs" });
    // The proposal's title is the words on the task it hangs on — nothing is written here.
    expect(view.items[2]).toMatchObject({ kind: "proposal", question: agentTasks.proposedReallocation.summary });
    // The coral dot is drawn iff this is above zero (src/ui/agent-bubble-thread.test.ts).
    expect(view.waiting).toBe(1);
  });

  it("counts no proposal once it has been decided", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    await askAgent(db, { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" }, deps);
    /*
     * Deciding is a write this branch has not got — `modules/approvals/decide.ts` is on #75 — so
     * the decision is stamped directly here. What is under test is the *read*: pending is the
     * absence of a decision on the row, never a count this module keeps of its own.
     */
    await db.query("UPDATE ops.approval_request SET decided_at = now() WHERE site_id = $1", [sc.siteId]);
    const view = await readAgentThread(db, sc.siteId);
    expect(view.waiting).toBe(0);
    expect(view.items.map((i) => i.kind)).toEqual(["day", "staff"]);
  });

  it("shows another site nothing of this one's", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    await askAgent(db, { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" }, deps);
    expect(await readAgentThread(db, "00000000-0000-7000-8000-00000000beef")).toEqual({ items: [], waiting: 0 });
  });

  it("never takes a screen down with it", async () => {
    const broken = { query: async () => { throw new Error("no"); } } as unknown as typeof db;
    expect(await readAgentThreadOrEmpty(broken, sc.siteId)).toEqual({ items: [], waiting: 0 });
  });
});

describe("what an ask is allowed to be", () => {
  it("trims it, collapses its whitespace and bounds its length", () => {
    expect(normalizeAsk("  move   the   van  ")).toBe("move the van");
    expect(normalizeAsk("")).toBeNull();
    expect(normalizeAsk("x".repeat(MAX_ASK_LENGTH))).toHaveLength(MAX_ASK_LENGTH);
    expect(normalizeAsk("x".repeat(MAX_ASK_LENGTH + 1))).toBeNull();
  });

  it("scrubs a phone number and a name somebody typed into the bubble", () => {
    // agent/redact.ts is the module's own leak scrubber; this row is read on a board, and what
    // a coordinator types in a hurry is as likely to carry a number as an inbound text is.
    expect(normalizeAsk("call them on 561-555-0134")).not.toMatch(/555-0134/);
    expect(normalizeAsk("move Liam to Van 2")).not.toMatch(/Liam/);
  });
});
