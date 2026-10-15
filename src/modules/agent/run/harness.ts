/**
 * In-memory harness for the run-loop suites, in the spirit of `jobs/fake-transport.ts`: everything
 * a run needs except a model, a network or a clock.
 *
 * The one piece of real thinking in here is `drive`. Each call builds a **fresh** `RunDeps` — a new
 * gateway over a new `FakeProvider` whose script is sliced at the number of tool calls already
 * persisted — which is what a restarted process looks like from the run's point of view: the
 * in-memory per-run rate-limit bucket is gone, and the model is answering the *next* turn because
 * the context it was given (the committed results, §11.1) is the next turn's context. Without the
 * slice a resumed run would be handed the response for a step it had already taken, which is a
 * model no amount of context could produce and would test the harness rather than the loop.
 *
 * The intent recorder is deliberately *not* rebuilt between drives: it stands in for the sink that
 * makes resume safe (a unique `ops.outbound_message.idempotency_key`, a version-guarded
 * `transition()`), and a sink does not forget when the process restarts.
 */
import type { Db } from "@/db/exec";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { type AgentConfig, loadAgentConfig } from "../config";
import { type LlmGateway, createGateway } from "../gateway";
import { type PolicyContext, familyScope } from "../policy";
import { fakeProvider, toolCall } from "../providers/fake";
import type { LlmProvider, ProviderResponseBody } from "../providers/provider";
import { type TierFacts, fixedAssembler } from "./context";
import { type IntentRecorder, type ToolExecutor, intentRecorder } from "./executors";
import { type RunDeps, type RunResult, driveRun, startAndDriveRun } from "./loop";
import type { Trigger } from "./triggers";

export type HarnessInput = {
  readonly db: Db;
  /** One response per model turn, in order. See the file header for how a resume is sliced. */
  readonly script: readonly ProviderResponseBody[];
  readonly facts: TierFacts;
  readonly policy: PolicyContext;
  /** Per-tool executors layered over the intent recorder. */
  readonly overrides?: Readonly<Record<string, ToolExecutor>>;
  /** Tools offered each turn; defaults to the whole §11.2 catalog. */
  readonly tools?: readonly string[];
  readonly now: () => Date;
  readonly isFatal?: (err: unknown) => boolean;
  /** Config overrides, through the slice-1 loader — the only place a knob may come from. */
  readonly config?: Partial<Parameters<typeof loadAgentConfig>[1]>;
  /** A provider other than the scripted fake (the recorded-cassette suite passes one). */
  readonly provider?: (offset: number) => LlmProvider;
};

export type Harness = {
  readonly config: AgentConfig;
  readonly recorder: IntentRecorder;
  readonly transport: FakeTransport;
  /** Every gateway built so far, newest last — one per drive, each with its own audit log. */
  readonly gateways: readonly LlmGateway[];
  start(trigger: Trigger): Promise<RunResult>;
  drive(runId: string): Promise<RunResult>;
  deps(offset: number): RunDeps;
};

export function runHarness(input: HarnessInput): Harness {
  const config = loadAgentConfig({}, input.config ?? {});
  const recorder = intentRecorder(input.overrides ?? {});
  const transport = new FakeTransport();
  const scheduler = new VercelQueueScheduler(input.db, transport, () => input.now());
  const gateways: LlmGateway[] = [];

  const deps = (offset: number): RunDeps => {
    const provider = input.provider?.(offset) ?? fakeProvider(input.script.slice(offset));
    const gateway = createGateway(provider, config, { now: () => input.now().getTime() });
    gateways.push(gateway);
    return {
      db: input.db,
      gateway,
      assemble: fixedAssembler(input.facts, input.policy, input.tools),
      executors: recorder.executors,
      scheduler,
      now: () => input.now(),
      isFatal: input.isFatal,
    };
  };

  const callCount = async (runId: string): Promise<number> => {
    const r = await input.db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.agent_tool_call WHERE run_id = $1",
      [runId],
    );
    return r.rows[0]?.n ?? 0;
  };

  const offsetForTrigger = async (trigger: Trigger): Promise<number> => {
    const r = await input.db.query<{ id: string }>(
      "SELECT id FROM ops.agent_run WHERE trigger_type = $1 AND trigger_id = $2",
      [trigger.type, trigger.id],
    );
    return r.rows[0] ? callCount(r.rows[0].id) : 0;
  };

  return {
    config,
    recorder,
    transport,
    gateways,
    deps,
    start: async (trigger) => startAndDriveRun(deps(await offsetForTrigger(trigger)), trigger),
    drive: async (runId) => driveRun(deps(await callCount(runId)), runId),
  };
}

/* ───────── the AT-01 scenario (PRD §18.2 demo step 2), shared by the slice-2 suites ───────── */

/**
 * One guardian cancels the AM leg and names a self-arrival, in tokens. The three turns below are
 * the shape §11.1 describes — fetch state with its version, write guarded on that version, leave a
 * staff note — and every suite in this slice drives this same scenario, so a test that fails is
 * failing about the loop rather than about its own fixture.
 */
export const AT01_FACTS: TierFacts = {
  t1: "site=S1 family=F1 child=C1 scopes=CANCEL_LEG,RECEIVE_TRANSPORT_UPDATES",
  t2: "leg=L-C1-AM state=SCHEDULED version=3 thread=TH-F1",
  t3: ["wont need the AM van, dropping off at 9:30"],
  t4: "channel=SMS locale=en-US",
};

/** The run's scope, as a session would build it (never from a tool argument). */
export const at01Policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: familyScope("F1", ["C1", "L-C1-AM", "TH-F1", "MSG-1", "TK-1", "SESS-C1"], ["V1", "P1", "R1"]),
  sendableSubjects: new Set(["TH-F1", "SESS-C1"]),
  sourceMessageId: "MSG-1",
  ...over,
});

export const AT01_READ = toolCall("get_leg_state", { leg_id: "L-C1-AM" });
export const AT01_CANCEL = toolCall("cancel_attendance_or_leg", {
  child_token: "C1", date: "2026-10-15", day_part: "AM", reason_code: "FAMILY_DROPOFF",
  expected_self_arrival: "09:30", expected_version: 3,
});
export const AT01_NOTE = toolCall("summarize_thread_for_staff", {
  // Not a sentence on purpose: `src/ui/copy.test.ts` keeps rendered prose in copy.ts, and a
  // fixture string in a non-test module is scanned like any other literal.
  thread_id: "TH-F1", summary: "Guardian canceled the AM leg; self-arrival 09:30",
});

export const AT01_SCRIPT: readonly ProviderResponseBody[] = [AT01_READ, AT01_CANCEL, AT01_NOTE];
/** The tools of AT01_SCRIPT, in turn order. */
export const AT01_TOOLS: readonly string[] = ["get_leg_state", "cancel_attendance_or_leg", "summarize_thread_for_staff"];

/** What each of the three tools "does": carry a version forward, then finish the run. */
export const AT01_EXECUTORS: Readonly<Record<string, ToolExecutor>> = {
  get_leg_state: async () => ({ data: { state: "SCHEDULED", version: 3 }, promptFacts: { leg_state: "SCHEDULED", leg_version: 3 } }),
  cancel_attendance_or_leg: async () => ({ data: { transitioned: "CANCELED_ATTENDANCE" }, promptFacts: { leg_canceled: true } }),
  summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }),
};
