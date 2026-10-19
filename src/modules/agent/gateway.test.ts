/**
 * The §11.2 LLM gateway contract, clause by clause. Every case drives the real gateway over the
 * deterministic FakeProvider: no network, no key, no clock.
 */
import { describe, expect, it, vi } from "vitest";
import { type AgentConfig, loadAgentConfig } from "./config";
import { GatewayError, createGateway } from "./gateway";
import { fakeProvider, freeText, toolCall } from "./providers/fake";
import { sha256Hex } from "./redact";
import { TOOL_COUNT } from "./tools";

/** This deployment's configured shape. Model ids come from here, never from a literal. */
const CONFIG = loadAgentConfig({});

const PROMPT = [
  "T1 site=S1 family=F1 child=C1",
  "T2 leg=L-C1-AM state=SCHEDULED version=3",
  "task=choose exactly one tool call",
].join("\n");

const CANCEL = {
  child_token: "C1",
  date: "2026-10-16",
  day_part: "AM",
  reason_code: "FAMILY_DROPOFF",
  expected_self_arrival: "09:30",
  expected_version: 3,
};

const ATTESTATION = {
  provider: "openrouter",
  // From config, never a literal: a model id anywhere outside the config module fails
  // no-hardcoded-models.test.ts, and an attestation naming a model this deployment does not
  // call would not be an attestation about this call anyway.
  model: CONFIG.model,
  region: "us-east-1",
  baa_version: "2026-02",
  retention_confirmation_id: "zdr-7781",
};

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ ...loadAgentConfig({}), ...overrides });

const gatewayFor = (
  script: Parameters<typeof fakeProvider>[0],
  overrides: Partial<AgentConfig> = {},
  now?: () => number,
) => {
  const cfg = config(overrides);
  const provider = fakeProvider(script, { vendor: cfg.provider });
  return { provider, gateway: createGateway(provider, cfg, now ? { now } : {}), cfg };
};

describe("complete(): one schema-valid catalog tool call, or nothing", () => {
  it("accepts a scripted call and returns parsed arguments", async () => {
    const { gateway, provider } = gatewayFor([toolCall("cancel_attendance_or_leg", CANCEL)]);
    const r = await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    expect(r.call).toEqual({ tool: "cancel_attendance_or_leg", tier: "auto", args: CANCEL });
    expect(r.promptHash).toBe(sha256Hex(PROMPT));
    // ADR-000 #12: zdr:true on every call, decided by the gateway, not the adapter.
    expect(provider.calls).toEqual([
      // The whole §11.2 catalog is offered; `TOOL_COUNT` rather than a literal, so adding a tool
      // is one edit in tools.ts and not two (the sixteenth one broke this line).
      { promptHash: sha256Hex(PROMPT), endpoint: "/api/v1/chat/completions", model: CONFIG.model, zdr: true, tools: TOOL_COUNT },
    ]);
  });

  it("accepts arguments the vendor sent as a JSON string", async () => {
    const { gateway } = gatewayFor([toolCall("get_leg_state", JSON.stringify({ leg_id: "L-C1-AM" }))]);
    const r = await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    expect(r.call.args).toEqual({ leg_id: "L-C1-AM" });
  });

  it("reads a quoted None or null from the model as null, and nothing else", async () => {
    // Seen live on a free endpoint: `requested_stop_token: "None"` for a drop-off that kept its stop.
    const args = {
      leg_id: "L-C1-PM", requested_dropoff_time: "17:00", requested_stop_token: "None",
      rationale_code: "PARENT_REQUEST", alert_text: "The family asked to move the drop-off to 5 PM.",
      reply: "Yes, we can drop them off at 5 today.", source_message_id: "MSG-1", expected_version: 1,
    };
    const { gateway } = gatewayFor([toolCall("propose_dropoff_change", JSON.stringify(args))]);
    const r = await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    expect(r.call.args).toMatchObject({ requested_stop_token: null, reply: "Yes, we can drop them off at 5 today." });

    // And an enum whose real value is the word NONE keeps it.
    const esc = gatewayFor([toolCall("escalate_exception", {
      severity: "INFO", category: "ACK_OVERDUE", leg_id: null, summary: "Recording that the ack is late", next_step_code: "NONE",
    })]);
    expect((await esc.gateway.complete({ runId: "RUN-2", prompt: PROMPT })).call.args).toMatchObject({ next_step_code: "NONE" });
  });

  it("rejects free text (§11.2 JSON-schema tool calls only)", async () => {
    const { gateway } = gatewayFor([freeText("The van will be there at 8:15, I'll tell the driver.")]);
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_FREE_TEXT",
    });
  });

  it("rejects a tool that is not in the catalog", async () => {
    const { gateway } = gatewayFor([toolCall("send_raw_sms", { to: "+15615550101" })]);
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_UNKNOWN_TOOL",
    });
  });

  it("rejects a catalog tool that was not offered this turn", async () => {
    const { gateway } = gatewayFor([toolCall("cancel_attendance_or_leg", CANCEL)]);
    await expect(
      gateway.complete({ runId: "RUN-1", prompt: PROMPT, tools: ["get_leg_state", "escalate_exception"] }),
    ).rejects.toMatchObject({ outcome: "REJECTED_UNKNOWN_TOOL" });
  });

  it("rejects an offer of a tool that does not exist", async () => {
    const { gateway, provider } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    await expect(
      gateway.complete({ runId: "RUN-1", prompt: PROMPT, tools: ["get_leg_state", "make_it_so"] }),
    ).rejects.toMatchObject({ outcome: "REJECTED_UNKNOWN_TOOL" });
    expect(provider.calls).toEqual([]);
  });

  it("rejects invalid arguments without echoing the values", async () => {
    const { gateway } = gatewayFor([
      toolCall("cancel_attendance_or_leg", { ...CANCEL, day_part: "MORNING", child_token: "+1-561-555-0101" }),
    ]);
    try {
      await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
      expect.unreachable();
    } catch (e) {
      const err = e as GatewayError;
      expect(err.outcome).toBe("REJECTED_INVALID_ARGS");
      expect(err.message).toContain("day_part");
      expect(err.message).not.toContain("MORNING");
      expect(err.message).not.toContain("561");
    }
  });

  it("rejects a batch of tool calls (§11.1 persists one call at a time)", async () => {
    const { gateway } = gatewayFor([
      {
        tool_calls: [
          { name: "get_leg_state", arguments: { leg_id: "L-C1-AM" } },
          { name: "cancel_attendance_or_leg", arguments: CANCEL },
        ],
      },
    ]);
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_MULTIPLE_CALLS",
    });
  });

  it("surfaces a provider failure as PROVIDER_ERROR", async () => {
    const { gateway } = gatewayFor([]);
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "PROVIDER_ERROR",
    });
  });
});

describe("the prompt is not scrubbed: the agent runtime is HIPAA-compliant (2026-10-18)", () => {
  it("sends a prompt carrying a name, a number and an address to the provider, and audits only its hash", async () => {
    const { gateway, provider } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    const prompt = `${PROMPT}\nguardian=Alma R. +1-561-555-0101 home=2216 Jog Rd`;
    const r = await gateway.complete({ runId: "RUN-1", prompt });
    expect(r.call.tool).toBe("get_leg_state");
    expect(provider.calls).toHaveLength(1);
    expect(gateway.auditLog.at(-1)).toMatchObject({ outcome: "ACCEPTED", promptHash: sha256Hex(prompt) });
    // The audit row is still hashes, codes and counts: none of the prompt's words are in it.
    const audit = JSON.stringify(gateway.auditLog);
    for (const fragment of ["Alma", "555-0101", "Jog Rd"]) expect(audit).not.toContain(fragment);
  });
});

describe("endpoint allow-list (§11.2 excludes Batch/Files/Code-Exec/Web-Fetch)", () => {
  it("refuses an endpoint that is not on the list", async () => {
    const { gateway, provider } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    await expect(
      gateway.complete({ runId: "RUN-1", prompt: PROMPT, endpoint: "/api/v1/batch" }),
    ).rejects.toMatchObject({ outcome: "REJECTED_ENDPOINT" });
    expect(provider.calls).toEqual([]);
  });

  it("refuses an excluded family even if it somehow reached the configured list", async () => {
    // The config schema refuses this list, so the gateway is given one directly: defence in depth.
    const cfg = { ...loadAgentConfig({}), endpointAllowList: ["/api/v1/files"] };
    const provider = fakeProvider([toolCall("get_leg_state", { leg_id: "L-C1-AM" })], {
      vendor: cfg.provider,
      endpoint: "/api/v1/files",
    });
    const gateway = createGateway(provider, cfg);
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_ENDPOINT",
    });
    expect(gateway.auditLog.at(-1)!.outcome).toBe("REJECTED_ENDPOINT");
  });

  it("refuses a provider whose vendor is not the configured one", () => {
    const provider = fakeProvider([], { vendor: "some-other-vendor" });
    expect(() => createGateway(provider, config())).toThrow(GatewayError);
  });
});

describe("vendorAttestation in PHI mode (§11.2)", () => {
  it("refuses a PHI-mode call with no attestation", async () => {
    const { gateway } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })], { dataMode: "PHI" });
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_ATTESTATION",
    });
  });

  it("accepts a PHI-mode call with all five fields, and records the retention id", async () => {
    const { gateway } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })], { dataMode: "PHI" });
    const r = await gateway.complete({ runId: "RUN-1", prompt: PROMPT, vendorAttestation: ATTESTATION });
    expect(r.call.tool).toBe("get_leg_state");
    expect(r.audit.retentionConfirmationId).toBe("zdr-7781");
    expect(r.audit.dataMode).toBe("PHI");
  });

  it.each(["region", "baa_version", "retention_confirmation_id", "provider", "model"])(
    "refuses a PHI-mode call whose attestation is missing %s",
    async (field) => {
      const { gateway } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })], { dataMode: "PHI" });
      const { [field]: _dropped, ...partial } = ATTESTATION as Record<string, string>;
      await expect(
        gateway.complete({ runId: "RUN-1", prompt: PROMPT, vendorAttestation: partial }),
      ).rejects.toMatchObject({ outcome: "REJECTED_ATTESTATION" });
    },
  );

  it("refuses an attestation that is about another provider or model", async () => {
    const { gateway } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })], { dataMode: "PHI" });
    await expect(
      gateway.complete({ runId: "RUN-1", prompt: PROMPT, vendorAttestation: { ...ATTESTATION, model: `${CONFIG.model}-not-the-configured-one` } }),
    ).rejects.toMatchObject({ outcome: "REJECTED_ATTESTATION" });
  });

  it("does not require an attestation in SYNTHETIC mode, but still validates one that is given", async () => {
    const ok = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    await expect(ok.gateway.complete({ runId: "RUN-1", prompt: PROMPT })).resolves.toBeTruthy();
    const bad = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    await expect(
      bad.gateway.complete({ runId: "RUN-1", prompt: PROMPT, vendorAttestation: { provider: "openrouter" } }),
    ).rejects.toMatchObject({ outcome: "REJECTED_ATTESTATION" });
  });
});

describe("rate limits come from config, not from logic", () => {
  it("stops a run at maxCallsPerRun", async () => {
    const { gateway, provider } = gatewayFor(
      [toolCall("get_leg_state", { leg_id: "L-C1-AM" })],
      { rateLimits: { maxCallsPerRun: 2, maxCallsPerStaffRun: 16, maxCallsPerMinute: 99, maxPromptChars: 9999 } },
    );
    await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    provider.reset();
    await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_RATE_LIMIT",
    });
    // A different run has its own budget.
    provider.reset();
    await expect(gateway.complete({ runId: "RUN-2", prompt: PROMPT })).resolves.toBeTruthy();
  });

  it("stops at maxCallsPerMinute and recovers once the window rolls", async () => {
    let clock = Date.UTC(2026, 9, 16, 12, 0, 0);
    const { gateway, provider } = gatewayFor(
      [toolCall("get_leg_state", { leg_id: "L-C1-AM" })],
      { rateLimits: { maxCallsPerRun: 99, maxCallsPerStaffRun: 16, maxCallsPerMinute: 1, maxPromptChars: 9999 } },
      () => clock,
    );
    await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    await expect(gateway.complete({ runId: "RUN-2", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_RATE_LIMIT",
    });
    clock += 60_000;
    provider.reset();
    await expect(gateway.complete({ runId: "RUN-3", prompt: PROMPT })).resolves.toBeTruthy();
  });

  it("refuses an oversized prompt before the provider is called", async () => {
    const { gateway, provider } = gatewayFor(
      [toolCall("get_leg_state", { leg_id: "L-C1-AM" })],
      { rateLimits: { maxCallsPerRun: 9, maxCallsPerStaffRun: 16, maxCallsPerMinute: 9, maxPromptChars: 10 } },
    );
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_PROMPT_TOO_LARGE",
    });
    expect(provider.calls).toEqual([]);
  });
});

describe("per-call audit of hashes only (§11.2)", () => {
  it("writes one row per attempt, accepted or refused", async () => {
    const sink = vi.fn();
    const cfg = config();
    const provider = fakeProvider(
      [toolCall("get_leg_state", { leg_id: "L-C1-AM" }), freeText("sure thing")],
      { vendor: cfg.provider },
    );
    const gateway = createGateway(provider, cfg, { auditSink: sink });
    await gateway.complete({ runId: "RUN-1", prompt: PROMPT });
    await expect(gateway.complete({ runId: "RUN-1", prompt: PROMPT })).rejects.toThrow(GatewayError);
    expect(gateway.auditLog).toHaveLength(2);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(gateway.auditLog.map((r) => r.outcome)).toEqual(["ACCEPTED", "REJECTED_FREE_TEXT"]);
    expect(gateway.auditLog[0]).toMatchObject({
      runId: "RUN-1",
      provider: "openrouter",
      providerKind: "fake",
      model: CONFIG.model,
      zdr: true,
      dataMode: "SYNTHETIC",
      promptHash: sha256Hex(PROMPT),
      tool: "get_leg_state",
      tier: "auto",
    });
    expect(gateway.auditLog[0].responseHash).toMatch(/^[0-9a-f]{64}$/);
    // TZ-independent: the timestamp is stamped in UTC from the injected clock.
    expect(gateway.auditLog[0].at).toMatch(/Z$/);
  });

  it("holds no prompt or response text anywhere", async () => {
    const leaky = `${PROMPT}\nnote=Alma R. asked us to call 561-555-0101 about 2216 Jog Rd`;
    const { gateway } = gatewayFor([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    // The prompt goes through (HIPAA runtime, 2026-10-18); the audit row still keeps none of it.
    await expect(gateway.complete({ runId: "RUN-1", prompt: leaky })).resolves.toBeTruthy();
    const serialized = JSON.stringify(gateway.auditLog);
    for (const fragment of ["Alma", "561-555-0101", "Jog Rd", "T2 leg="]) {
      expect(serialized).not.toContain(fragment);
    }
    // What it does hold: the hash, the classes, the counts.
    expect(serialized).toContain(sha256Hex(leaky));
  });
});
