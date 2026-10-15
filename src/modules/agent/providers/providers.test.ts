/**
 * The two providers slice 1 ships (deterministic fake, cassette replay) and the typed placeholder
 * it does not. The real-vendor path has no HTTP body on purpose: ADR-000 #4 has the founder supply
 * the key, and nothing in this slice — build, CI or test — may need one to pass.
 */
import { describe, expect, it } from "vitest";
import cassetteJson from "../fixtures/recorded-standard.json";
import { RECORDED_PROMPTS } from "../fixtures/prompts";
import { loadAgentConfig } from "../config";
import { createGateway } from "../gateway";
import { sha256Hex } from "../redact";
import { ProviderError } from "./provider";
import { fakeProvider, freeText, toolCall } from "./fake";
import { CassetteMissError, cassetteFrom, cassetteKey, loadCassette, recordedProvider } from "./recorded";
import { RemoteProviderNotEnabled, remoteProvider } from "./remote";

const CONFIG = loadAgentConfig({});
const PROMPT = "T1 site=S1 family=F1 child=C1\nT2 leg=L-C1-AM version=3";

describe("FakeProvider", () => {
  it("replays its script in order and records hashes only", async () => {
    const provider = fakeProvider([
      toolCall("get_leg_state", { leg_id: "L-C1-AM" }),
      toolCall("escalate_exception", {
        severity: "INFO",
        category: "ACK_OVERDUE",
        leg_id: "L-C1-AM",
        summary: "no reply yet",
        next_step_code: "STAFF_REVIEW",
      }),
    ]);
    const gateway = createGateway(provider, CONFIG);
    expect((await gateway.complete({ runId: "RUN-1", prompt: PROMPT })).call.tool).toBe("get_leg_state");
    expect((await gateway.complete({ runId: "RUN-1", prompt: PROMPT })).call.tool).toBe("escalate_exception");
    expect(provider.calls.map((c) => c.promptHash)).toEqual([sha256Hex(PROMPT), sha256Hex(PROMPT)]);
    expect(JSON.stringify(provider.calls)).not.toContain("site=S1");
  });

  it("is deterministic: the same script gives the same answers every time", async () => {
    const script = [toolCall("get_leg_state", { leg_id: "L-C1-AM" })];
    const once = await createGateway(fakeProvider(script), CONFIG).complete({ runId: "A", prompt: PROMPT });
    const twice = await createGateway(fakeProvider(script), CONFIG).complete({ runId: "A", prompt: PROMPT });
    expect(twice.responseHash).toBe(once.responseHash);
    expect(twice.call).toEqual(once.call);
  });

  it("throws when the script runs out, unless asked to repeat the last response", async () => {
    const strict = fakeProvider([freeText("only one")]);
    await strict.invoke(call(strict.endpoint));
    await expect(strict.invoke(call(strict.endpoint))).rejects.toThrow(ProviderError);
    const loose = fakeProvider([toolCall("get_leg_state", { leg_id: "L-C1-AM" })], { repeatLast: true });
    await loose.invoke(call(loose.endpoint));
    await expect(loose.invoke(call(loose.endpoint))).resolves.toMatchObject({ finish_reason: "tool_calls" });
  });

  it("reset() rewinds the script and clears the call log", async () => {
    const provider = fakeProvider([toolCall("get_leg_state", { leg_id: "L-C1-AM" })]);
    await provider.invoke(call(provider.endpoint));
    provider.reset();
    expect(provider.calls).toEqual([]);
    await expect(provider.invoke(call(provider.endpoint))).resolves.toBeTruthy();
  });
});

describe("RecordedProvider", () => {
  it("replays the checked-in cassette for each recorded prompt", async () => {
    const cassette = loadCassette(cassetteJson);
    const provider = recordedProvider(cassette);
    const gateway = createGateway(provider, CONFIG);
    const tools = await Promise.all(
      RECORDED_PROMPTS.map(async (p) => (await gateway.complete({ runId: p.note, prompt: p.prompt })).call.tool),
    );
    expect(tools).toEqual(["cancel_attendance_or_leg", "request_clarification"]);
    expect(provider.hits).toEqual(RECORDED_PROMPTS.map((p) => cassetteKey(p.prompt)));
  });

  it("keys on the prompt hash, so the cassette file holds no prompt text", () => {
    const serialized = JSON.stringify(cassetteJson);
    for (const p of RECORDED_PROMPTS) {
      expect(serialized).toContain(cassetteKey(p.prompt));
      expect(serialized).not.toContain("T1 site=S1");
    }
  });

  it("throws on a missing fixture rather than inventing or calling out", async () => {
    const provider = recordedProvider(cassetteFrom([{ prompt: PROMPT, response: toolCall("get_leg_state", { leg_id: "L-C1-AM" }) }]));
    await expect(provider.invoke({ ...call(provider.endpoint), prompt: "drifted", promptHash: sha256Hex("drifted") }))
      .rejects.toThrow(CassetteMissError);
  });

  it("names only the hash in the miss, never the prompt", async () => {
    const provider = recordedProvider(cassetteFrom([{ prompt: PROMPT, response: freeText("x") }]));
    const drifted = "T1 site=S1 family=F9 secret=do-not-log";
    try {
      await provider.invoke({ ...call(provider.endpoint), prompt: drifted, promptHash: sha256Hex(drifted) });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain(sha256Hex(drifted));
      expect(String(e)).not.toContain("do-not-log");
    }
  });

  it("refuses a malformed or duplicate-keyed cassette", () => {
    expect(() => loadCassette({ entries: [] })).toThrow(ProviderError);
    expect(() => loadCassette({ entries: [{ prompt_sha256: "nope", response: {} }] })).toThrow(ProviderError);
    const dup = { prompt_sha256: sha256Hex(PROMPT), note: "", response: {} };
    expect(() => loadCassette({ entries: [dup, dup] })).toThrow(ProviderError);
  });
});

/** A placeholder key, so the wiring gate opens and `invoke()` is what refuses. Never a real one. */
const KEY_ENV = { [CONFIG.apiKeyEnvVar]: "test-key" };

describe("remote provider placeholder", () => {
  it("is typed, declares the key by env var name, and refuses to run in slice 1", async () => {
    const provider = remoteProvider(CONFIG, KEY_ENV);
    expect(provider.kind).toBe("remote");
    expect(provider.vendor).toBe("openrouter");
    expect(provider.endpoint).toBe(CONFIG.endpointAllowList[0]);
    expect(provider.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    await expect(provider.invoke(call(provider.endpoint))).rejects.toThrow(RemoteProviderNotEnabled);
  });

  it("names the env var in the refusal and never a key value", async () => {
    const provider = remoteProvider(CONFIG, KEY_ENV);
    await expect(provider.invoke(call(provider.endpoint))).rejects.toThrow(/\$OPENROUTER_API_KEY/);
    await expect(provider.invoke(call(provider.endpoint))).rejects.not.toThrow(/test-key/);
  });
});

/** A minimal ProviderCall, for the adapter-level tests that bypass the gateway. */
function call(endpoint: string) {
  return {
    endpoint,
    model: CONFIG.model,
    zdr: CONFIG.zdr,
    dataMode: CONFIG.dataMode,
    prompt: PROMPT,
    tools: [],
    promptHash: sha256Hex(PROMPT),
  };
}
