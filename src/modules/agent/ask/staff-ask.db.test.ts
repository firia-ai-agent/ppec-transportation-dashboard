import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { agentAsk, agentTasks } from "@/ui/copy";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "../config";
import { approvalKey } from "../policy";
import { freeText, toolCall } from "../providers/fake";
import type { TierFacts } from "../run/context";
import type { PolicyContext } from "../policy";
import { type AgentRunner, agentRunner } from "../run/deps";
import { liveHarness } from "../run/exec/live-harness";
import { askUnavailableLogLine } from "../staff-alert";
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

/**
 * The runner's own sentence about why it refused, whichever half of the union it came back as.
 * It is the *log* channel on both: it names env vars and build conditions, never a value, and the
 * tests below check it reaches no row and no answer.
 */
const runnerReason = (r: AgentRunner): string | null => r.reason;

/** The arguments the model answers an ask with: a reallocation nobody but a person may apply. */
const REALLOCATION = () => ({
  infeasible_vehicle_token: "V-SYN-1",
  leg_ids: [sc.legs[sc.children[0]].AM],
  options: [{ vehicle_token: "V-SYN-2", leg_ids: [sc.legs[sc.children[0]].AM], added_minutes: 12 }],
  rationale_code: "SECUREMENT",
});

/**
 * The ask path with a model, as a harness's deps in place of `agentRunner(db, env)`'s.
 *
 * `refused: false, reason: null` is the "a vendor will answer this turn" half of the runner's
 * union (run/deps.ts) — the shape the ask requires before it will drive anything, and the reason
 * the suite has to say it rather than leave it off.
 */
function withModel(script: Parameters<typeof liveHarness>[0]["script"], over: Partial<PolicyContext> = {}) {
  const h = liveHarness({ db, script, facts: facts(), policy: policy(over), now: () => now });
  return {
    harness: h,
    deps: {
      runner: () => ({ ok: true as const, refused: false, reason: null, deps: h.deps(0) }),
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
   * This deployment's real answer, from the real runner (`agentRunner(db, env)`, the one the agent
   * queue consumer drives with) rather than from a stub standing in for it.
   *
   * With no model env there are two shapes it can refuse in and the ask treats them alike: no
   * provider could be built at all (`ok: false`), or one was built that may not be *called*
   * (`ok: true, refused: true` — no key, no demo-data confirmation, a base URL off the host
   * allow-list), which is a provider that throws on the first turn. Neither is a runnable result,
   * so neither starts a run.
   */
  it("is what this deployment actually does: the real runner has no model to drive", async () => {
    const runner = agentRunner(db, {});
    expect(runner.ok && !runner.refused).toBe(false);
    // And it says why, for the log — which the test below proves goes nowhere near a screen.
    expect(runnerReason(runner) ?? "").toMatch(/\S/);

    // The whole of what the ask does with that: one STAFF_ALERT row and nothing driven.
    const r = await askAgent(db, { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" }, { env: {} });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.outcome).toBe("unavailable");
    expect((await tasks()).map((t) => [t.category, t.severity, t.state])).toEqual([
      [STAFF_ALERT_TASK_CATEGORY, "RED", "OPEN"],
    ]);
    for (const table of ["ops.agent_run", "ops.approval_request", "ops.change_request"]) {
      expect((await db.query(`SELECT id FROM ${table}`, [])).rows, table).toEqual([]);
    }
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
    // Four fields at most: ok, outcome, and — only for a run that ran — the model's answer (in
    // names) and the proposal id. Never the runner's reason, which is the log's.
    expect(route).toMatch(/Response\.json\(\{ ok: result\.ok, outcome: result\.outcome, \.\.\.said \}/);
    expect(route).toMatch(/result\.outcome === "ran" \? \{ answer: result\.answer, proposalId: result\.proposalId \} : \{\}/);
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
    const reason = runnerReason(agentRunner(db, {})) ?? "";
    expect(reason).toMatch(/\S/);
    expect(said).not.toContain(reason.toLowerCase());
  });

  it("raises the same alert when the model is reached and fails", async () => {
    const before = await tasks();
    const drive = vi.fn(async () => {
      throw new Error("provider unreachable");
    });
    const r = await askAgent(
      db,
      { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" },
      {
        env: {},
        // A runner that exists and a drive that throws: a PROVIDER_ERROR, a missing key, a refusal.
        runner: () => ({ ok: true as const, refused: false, reason: null, deps: { gateway: { config: { askTimeoutMs: 5_000 } } } as never }),
        drive,
      },
    );
    // The alert comes from the model-failure path: the run was really driven, once.
    expect(drive).toHaveBeenCalledTimes(1);
    expect(r.ok === false && r.outcome).toBe("unavailable");
    const added = (await tasks()).filter((t) => !before.some((b) => b.id === t.id));
    expect(added.map((t) => [t.category, t.severity, t.state])).toEqual([
      [STAFF_ASK_TASK_CATEGORY, "AMBER", "OPEN"],
      [STAFF_ALERT_TASK_CATEGORY, "RED", "OPEN"],
    ]);
  });

  /**
   * The third shape of "no model", and the one that is a *throw* rather than an answer: a
   * configuration no provider can be built from at all. `run/deps.ts` reads the config outside the
   * `try` that turns this into `ok: false`, so it escapes the runner — and an ask that let it
   * escape would be a 503 with nothing on the board, which is the founder's rule broken by a
   * construction order rather than by a decision.
   */
  it("raises the alert, and no run, when the runner cannot be built at all", async () => {
    const r = await askAgent(
      db,
      { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" },
      {
        env: {},
        runner: () => {
          throw new Error("Invalid agent config [baseUrl: host is not on the allow-list]");
        },
      },
    );
    expect(r.ok === false && r.outcome).toBe("unavailable");
    expect((await tasks()).map((t) => [t.category, t.severity, t.state])).toEqual([
      [STAFF_ALERT_TASK_CATEGORY, "RED", "OPEN"],
    ]);
    expect((await db.query("SELECT id FROM ops.agent_run", [])).rows).toEqual([]);
  });

  /**
   * NO KEYWORD PARSER ON THE ASK PATH — the degraded mode is a person, not a worse machine
   * (founder's rule, docs/DATA-MODEL.md M3).
   *
   * Walked rather than grepped: a direct `import` is easy to not write, and the thing that would
   * actually reintroduce the parser is a module three hops away picking it up.
   *
   * What is forbidden is a **text parser standing in for the model**, and that is now said as
   * three things rather than as a ban on one file: the deleted reader's own path, any reachable
   * module *named* for the job it did, and any reachable module that names one of its exports.
   *
   * `providers/remote.ts` used to be forbidden here as a proxy for the ban, because its §18.1
   * model chain once ended in the parser. It does not any more — the chain ends in
   * `RemoteProviderUnavailable` and `no-keyword-fallback.test.ts` holds that structurally — and
   * since the founder's ruling of 2026-10-18 the ask drives the **real** runner, whose gateway is
   * built on that adapter. So the adapter is asserted to be *present*: it is the thing that calls
   * the model, and an ask that could not reach it could not reach a model at all.
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
    const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
    const reachable = [...seen].map(rel);

    // 1. The deleted reader, by the path it had.
    expect(reachable.filter((f) => f === "modules/agent/providers/keyword.ts")).toEqual([]);

    // 2. No reachable module is NAMED for a keyword or text parser — the same four words
    //    `no-keyword-fallback.test.ts` bans a new provider file for, applied to this whole graph
    //    rather than to one directory.
    expect(reachable.filter((f) => /[^/]*(?:keyword|parser|fallback|degraded)[^/]*\.tsx?$/i.test(f))).toEqual([]);

    // 3. And no reachable module NAMES one of the reader's exports. Comments stripped, so the
    //    prose about why it is gone — this module has plenty — is not read as a use of it.
    // The finish reason the reader used to produce is deliberately NOT spelled here: the src-wide
    // scan for it lives in `no-keyword-fallback.test.ts`, and that scan reads this file too — a
    // literal copy of the string would make this suite its own offender.
    const banned = [/\bkeywordResponse\b/, /\bkeywordProvider\b/, /\bKEYWORD_RULES\b/, /\bclassifyKeywords\b/];
    const uses = [...seen]
      .filter((f) => {
        const code = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
          .join("\n");
        return banned.some((b) => b.test(code));
      })
      .map(rel);
    expect(uses).toEqual([]);

    // And the live vendor adapter IS here, because the ask drives the real runner: the refusal
    // this path takes is "no model would answer", not "no model was ever asked".
    expect(reachable).toContain("modules/agent/providers/remote.ts");
  });
});

/**
 * PPE-103 S2: WHAT THE ALERT RECORDS, AND WHICH RUNS EARN ONE.
 *
 * Two facts the degraded path had been losing. (a) A *timeout* — our own deadline on the whole
 * ask — left a row indistinguishable from a vendor error, so nobody reading the board afterwards
 * could tell "the model never answered" from "we stopped waiting". (b) A run that FAILED for any
 * other reason came back `ok` with no answer on it, which reads in the panel as a model that had
 * nothing to say.
 *
 * Both are asserted against the real board: the row `raiseAskUnavailableAlert` actually wrote,
 * read back out of `ops.task`, and the real run loop driven to a real FAILED.
 */
describe("PPE-103 (a) the alert records which kind of nothing happened", () => {
  /** The alert row and the class on it, as `openAssistantAlerts` and an on-call would read them. */
  const alertRow = async () =>
    (
      await db.query<{ id: string; summary: string; completion_evidence: Record<string, unknown> | null }>(
        "SELECT id, summary, completion_evidence FROM ops.task WHERE category = $1",
        [STAFF_ALERT_TASK_CATEGORY],
      )
    ).rows[0];

  /** A runner that exists, with the deadline the ask is held to and nothing else on it. */
  const runnerWithDeadline = (askTimeoutMs: number) => () => ({
    ok: true as const,
    refused: false,
    reason: null,
    deps: { gateway: { config: { askTimeoutMs } } } as never,
  });

  it("stores TIMEOUT as the alert's reason class when the ask runs out of time", async () => {
    // A drive that never settles: the deadline is the only thing that can end this ask.
    const r = await askAgent(
      db,
      { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" },
      { env: {}, runner: runnerWithDeadline(10), drive: () => new Promise(() => {}) },
    );
    expect(r.ok === false && r.outcome).toBe("unavailable");
    expect(r.outcome === "unavailable" && r.reason).toBe("TIMEOUT");

    const ask = (await tasks()).find((t) => t.category === STAFF_ASK_TASK_CATEGORY);
    const alert = await alertRow();
    expect(alert).toBeDefined();
    // The same shape `raiseModelUnavailableAlert` writes for an inbound text, so one query
    // answers "what kind of failure was this" for both doors into the alert.
    expect(alert.completion_evidence).toEqual({
      locator: { ask_task_id: ask!.id, reason_class: "timeout" },
    });
  });

  it("logs the class alone — not the error, not the deadline, not what was asked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await askAgent(
        db,
        { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" },
        { env: {}, runner: runnerWithDeadline(10), drive: () => new Promise(() => {}) },
      );
      expect(warn.mock.calls.map((c) => c[0])).toContain(askUnavailableLogLine("timeout"));
      const logged = warn.mock.calls.flat().join(" ").toLowerCase();
      expect(logged).not.toContain("tell the family");
      expect(logged).not.toMatch(/https?:\/\//);
      expect(logged).not.toMatch(/\d/);
    } finally {
      warn.mockRestore();
    }
  });

  it("classes a reached-and-failed vendor as the vendor's failure, not as a timeout", async () => {
    const r = await askAgent(
      db,
      { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" },
      {
        env: {},
        runner: runnerWithDeadline(5_000),
        drive: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    expect(r.outcome === "unavailable" && r.reason).toBe("the model could not be reached");
    expect((await alertRow()).completion_evidence).toMatchObject({ locator: { reason_class: "provider_error" } });
  });
});

describe("PPE-103 (b) any FAILED run is a person's job, not an answer", () => {
  /**
   * The run is really driven, really reaches the gateway and really fails — `freeText` is the
   * model answering with a sentence where a catalog call belongs, which the gateway refuses
   * (`REJECTED_FREE_TEXT`) and the loop fails shut on. It is **not** an outage: `modelUnavailable`
   * returns null for it, so `run.modelUnavailable` is unset and the loop raised no alert of its
   * own. Everything the ask does from here it does by reading the run's state.
   */
  it("answers not-ok and raises the alert for a run that failed without an outage", async () => {
    const before = await stateSnapshot();
    const { deps } = withModel([freeText("just call her mother")]);
    const r = await askAgent(db, { siteId: sc.siteId, text: "Tell the family we are late", by: "u1" }, deps);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.outcome).toBe("unavailable");

    // The run is on the board as FAILED, with no tool call under it: nothing was executed.
    const runs = (await db.query<{ id: string; state: string }>("SELECT id, state FROM ops.agent_run", [])).rows;
    expect(runs.map((x) => x.state)).toEqual(["FAILED"]);
    expect(await toolCalls(db, runs[0].id)).toEqual([]);

    // Two rows: the ask, and the alert that says nobody answered it.
    expect((await tasks()).map((t) => [t.category, t.severity, t.state])).toEqual([
      [STAFF_ASK_TASK_CATEGORY, "AMBER", "OPEN"],
      [STAFF_ALERT_TASK_CATEGORY, "RED", "OPEN"],
    ]);
    // And it says which kind of nothing: a run that ran and stopped, not a vendor that was down.
    const alert = (
      await db.query<{ completion_evidence: Record<string, unknown> | null }>(
        "SELECT completion_evidence FROM ops.task WHERE category = $1",
        [STAFF_ALERT_TASK_CATEGORY],
      )
    ).rows[0];
    expect(alert.completion_evidence).toMatchObject({ locator: { reason_class: "run_failed" } });
    // Nothing the ask could have changed, changed.
    expect(await stateSnapshot()).toEqual(before);
  });

  it("still answers ok, with no alert, for a run that succeeded", async () => {
    const { deps } = withModel([toolCall("propose_manifest_reallocation", REALLOCATION())], {
      scope: { ...sc.scope, shared: new Set(["V-SYN-1", "V-SYN-2"]) },
    });
    const r = await askAgent(db, { siteId: sc.siteId, text: "Van 1 cannot take its runs", by: "u1" }, deps);
    expect(r.ok && r.run.state).toBe("SUCCEEDED");
    expect((await tasks()).map((t) => t.category)).not.toContain(STAFF_ALERT_TASK_CATEGORY);
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
    // Veri #84 S1: no DATABASE_URL means the handle itself throws; that must not 500 the console.
    const noUrl = () => {
      throw new Error("DATABASE_URL is not set");
    };
    expect(await readAgentThreadOrEmpty(noUrl, sc.siteId)).toEqual({ items: [], waiting: 0 });
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
