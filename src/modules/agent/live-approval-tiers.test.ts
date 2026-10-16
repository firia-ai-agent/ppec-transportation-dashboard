/**
 * VERI-2 on the **live path**: the approval tiers are a property of the catalog and the policy
 * engine, not of which provider answered.
 *
 * §11.2 is unchanged by slice 5 — a templated send is autonomous, free text to a parent needs
 * human approval, a `propose_*` tool is always a proposal — and the risk a live vendor introduces
 * is that someone assumes the gate lives in the provider layer and quietly relaxes it for the
 * "real" model. So this file drives the **actual remote adapter**, with `fetch` mocked, through the
 * **actual gateway** into the **actual policy engine**, and asserts the tiers land exactly where
 * `free-text-approval.test.ts` says they do with a scripted provider.
 *
 * The strongest form of "unchanged" is here as its own test: the same model output, once through
 * `fakeProvider` and once through the live adapter, must produce byte-identical policy decisions.
 *
 * As in `free-text-approval.test.ts`, the catalog deliberately contains no free-text sender, so
 * `vi.mock` supplies one — `send_followup` re-declared with a `body` argument. `request_clarification`
 * keeps its real template declaration here, so the same file holds a genuine templated-auto case
 * next to the free-text one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools")>();
  const { z } = await import("zod");
  const freeTextFollowup = {
    ...actual.toolDef("send_followup")!,
    schema: z.strictObject({
      audience: z.enum(actual.AUDIENCES),
      subject_token: z.string(),
      body: z.string().min(1).max(320),
    }),
    staffTextFields: ["body"] as const,
    sendCopy: { kind: "free_text" as const },
    prd: "§11.2: free-text to parents *with* human approval — the tool the catalog deliberately lacks",
  };
  const overrides: Record<string, typeof freeTextFollowup> = { send_followup: freeTextFollowup };
  return {
    ...actual,
    TOOL_REGISTRY: { ...actual.TOOL_REGISTRY, ...overrides },
    toolDef: (name: string) => overrides[name] ?? actual.toolDef(name),
  };
});

import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "./config";
import { createGateway } from "./gateway";
import {
  type PolicyContext,
  type PolicyDecision,
  approvalKey,
  decisionSends,
  evaluate,
  familyScope,
  wrapUntrusted,
} from "./policy";
import { fakeProvider, toolCall } from "./providers/fake";
import { remoteProvider } from "./providers/remote";
import { toolDef } from "./tools";

const PLACEHOLDER_KEY = "placeholder-not-a-key";
/** Both halves of the demo-data guard: the operator's confirmation and the ADR-015 boot class. */
const DEMO_ENV = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
};
const KEY_ENV = { ...DEMO_ENV, OPENROUTER_API_KEY: PLACEHOLDER_KEY };
const DEMO = loadAgentConfig(DEMO_ENV);

const PROMPT = [
  "role=transport_coordinator_agent",
  "T1 site=S1 family=F1 child=C1 scopes=CANCEL_LEG,RECEIVE_TRANSPORT_UPDATES",
  "T2 leg=L-C1-AM state=SCHEDULED version=3 thread=TH-F1",
  `T3 ${wrapUntrusted("the van is going to be late isnt it")}`,
  "task=choose exactly one tool call",
].join("\n");

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: familyScope("F1", ["C1", "L-C1-AM", "TH-F1", "MSG-1", "SESS-C1"], ["V1", "P1", "R1"]),
  sendableSubjects: new Set(["C1", "TH-F1", "SESS-C1", "P1"]),
  foreignTokens: new Set(["F2", "C2"]),
  untrustedMessages: [],
  paused: false,
  sourceMessageId: "MSG-1",
  ...overrides,
});

/** The templated send: an allow-listed template id, no prose anywhere in the arguments. */
const CLARIFY = {
  thread_id: "TH-F1",
  ambiguity_type: "WHICH_CHILD",
  candidate_tokens: ["C1"],
  draft_template_id: "generic.notice",
};

/** The free-text send the mock made expressible. */
const FREE_TEXT = {
  audience: "GUARDIAN_OF_CHILD",
  subject_token: "C1",
  body: "the van is held up behind a school bus and will be about ten minutes late",
};

/** The human-tier proposal, which no approval model and no provider may make autonomous. */
const REALLOCATION = {
  infeasible_vehicle_token: "V1",
  leg_ids: ["L-C1-AM"],
  options: [{ vehicle_token: "V1", leg_ids: ["L-C1-AM"], added_minutes: 12 }],
  rationale_code: "CAPACITY",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A well-formed OpenRouter envelope carrying one tool call. */
const vendorSays = (name: string, args: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [
      { message: { content: null, tool_calls: [{ function: { name, arguments: args } }] }, finish_reason: "tool_calls" },
    ],
  }),
});

/**
 * One live turn: the vendor is told what to answer, the real adapter fetches it, the real gateway
 * validates it and the real policy engine rules on it. This is the whole path under test.
 */
async function liveTurn(
  name: string,
  args: unknown,
  policyCtx: PolicyContext = ctx(),
): Promise<{ readonly decision: PolicyDecision; readonly tier: string }> {
  fetchMock.mockResolvedValue(vendorSays(name, args));
  const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
  const accepted = await gateway.complete({ runId: `RUN-${name}`, prompt: PROMPT });
  expect(gateway.auditLog.at(-1)).toMatchObject({ outcome: "ACCEPTED", providerKind: "remote" });
  return { decision: evaluate({ tool: accepted.call.tool, args: accepted.call.args }, policyCtx), tier: accepted.call.tier };
}

describe("the mock put a free-text sender in the catalog, and left the templated one alone", () => {
  it("send_followup declares free text; request_clarification still declares its template", () => {
    expect(toolDef("send_followup")).toMatchObject({ effect: "send", tier: "auto", sendCopy: { kind: "free_text" } });
    expect(toolDef("request_clarification")!.sendCopy).toEqual({
      kind: "template",
      idArg: "draft_template_id",
      varsArg: null,
    });
    expect(toolDef("notify_affected_therapist")!.sendCopy).toEqual({ kind: "fixed" });
  });
});

describe("live path: a templated send stays autonomous", () => {
  it("a template-copy send from the live model is ALLOWed and sends, with no approval", async () => {
    const { decision, tier } = await liveTurn("request_clarification", CLARIFY);
    expect(tier).toBe("auto");
    expect(decision).toMatchObject({ verdict: "ALLOW", tool: "request_clarification", effect: "send" });
    expect(decisionSends(decision)).toBe(true);
    expect("requiresApproval" in decision).toBe(false);
  });

  it("a fixed-copy send from the live model is ALLOWed too", async () => {
    const { decision, tier } = await liveTurn("notify_affected_therapist", {
      therapy_session_token: "SESS-C1",
      child_token: "C1",
      impact: "LATE",
      eta: "09:30",
    });
    expect(tier).toBe("auto");
    expect(decision).toMatchObject({ verdict: "ALLOW", effect: "send" });
    expect(decisionSends(decision)).toBe(true);
  });

  it("an auto-tier read or mutate is unaffected by the provider being live", async () => {
    const { decision, tier } = await liveTurn("get_leg_state", { leg_id: "L-C1-AM" });
    expect([tier, decision.verdict]).toEqual(["auto", "ALLOW"]);
  });
});

describe("live path: free text to a parent still needs human approval", () => {
  it("unapproved, a live free-text send is a PROPOSAL that mutates nothing and sends nothing", async () => {
    const { decision, tier } = await liveTurn("send_followup", FREE_TEXT);
    // The *tool* is auto tier. Being a free-text send is what moves it, which is the distinction
    // that would be lost if the gate were ever implemented at the provider layer.
    expect(tier).toBe("auto");
    expect(decision).toMatchObject({
      verdict: "PROPOSAL",
      rule: "send_requires_approval",
      tool: "send_followup",
      mutates: false,
      requiresApproval: true,
    });
    expect(decisionSends(decision)).toBe(false);
  });

  it("with the approval bound to that exact call, the same live turn is allowed", async () => {
    const approved = ctx({ approvedCalls: new Set([approvalKey("send_followup", FREE_TEXT)]) });
    const { decision } = await liveTurn("send_followup", FREE_TEXT, approved);
    expect(decision).toMatchObject({ verdict: "ALLOW", effect: "send" });
    expect(decisionSends(decision)).toBe(true);
  });

  it("an approval for a different message does not release a live one", async () => {
    const approved = ctx({ approvedCalls: new Set([approvalKey("send_followup", FREE_TEXT)]) });
    const { decision } = await liveTurn(
      "send_followup",
      { ...FREE_TEXT, body: "the van is held up and will be about forty minutes late" },
      approved,
    );
    expect(decision).toMatchObject({ verdict: "PROPOSAL", rule: "send_requires_approval" });
  });

  it("the prose a human is asked to approve is stored redacted, live or not", async () => {
    const { decision } = await liveTurn("send_followup", {
      ...FREE_TEXT,
      body: "the driver tried to reach you on 561-555-0177",
    });
    expect(decision.verdict).toBe("PROPOSAL");
    expect(decision.verdict === "PROPOSAL" && decision.args.body).toContain("[REDACTED:PHONE]");
  });

  it("a human-tier tool from the live model is still a proposal", async () => {
    const { decision, tier } = await liveTurn("propose_manifest_reallocation", REALLOCATION);
    expect(tier).toBe("human");
    expect(decision).toMatchObject({
      verdict: "PROPOSAL",
      rule: "human_tier_requires_approval",
      mutates: false,
      requiresApproval: true,
    });
  });
});

describe("live path: the tiers do not depend on which provider answered", () => {
  it.each([
    ["request_clarification", CLARIFY],
    ["send_followup", FREE_TEXT],
    ["propose_manifest_reallocation", REALLOCATION],
    ["get_leg_state", { leg_id: "L-C1-AM" }],
  ])("%s decides identically through the fake and the live provider", async (tool, args) => {
    // Same model output, two transports. Any divergence here is a tier that leaked into the
    // provider layer, which is exactly the regression this file exists to catch.
    fetchMock.mockResolvedValue(vendorSays(tool, args));
    const live = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    const fake = createGateway(fakeProvider([toolCall(tool, args as Record<string, unknown>)], { vendor: DEMO.provider }), DEMO);

    const liveCall = (await live.complete({ runId: "RUN-LIVE", prompt: PROMPT })).call;
    const fakeCall = (await fake.complete({ runId: "RUN-FAKE", prompt: PROMPT })).call;
    expect(liveCall).toEqual(fakeCall);
    expect(evaluate({ tool: liveCall.tool, args: liveCall.args }, ctx())).toEqual(
      evaluate({ tool: fakeCall.tool, args: fakeCall.args }, ctx()),
    );
  });

  it("the keyword fallback's own call is auto tier and sends nothing", async () => {
    // A degraded run must not land in the approval queue, and must not send either. It escalates.
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    const accepted = await gateway.complete({ runId: "RUN-KW", prompt: PROMPT });
    expect(accepted.call).toMatchObject({ tool: "escalate_exception", tier: "auto" });
    const decision = evaluate({ tool: accepted.call.tool, args: accepted.call.args }, ctx());
    expect(decision.verdict).toBe("ALLOW");
    expect(decisionSends(decision)).toBe(false);
  });
});
