/**
 * The keyword fallback (PRD §18.1 l.1200: "LLM down → keyword parser (ABSENT/SICK/YES/READY/STOP)
 * + inbox triage banner").
 *
 * Two claims worth holding down. First, it classifies: the five keywords land on the severity and
 * category a human would expect, and `STOP` outranks whatever else the message says. Second, and
 * more important, it **does not act**: whatever it reads, the only call it can emit is
 * `escalate_exception`, which sends nothing and mutates no transport state. A degraded mode that
 * guessed a cancellation from five characters of SMS would be worse than a rate limit.
 */
import { describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "../config";
import { createGateway } from "../gateway";
import { wrapUntrusted } from "../policy";
import { sha256Hex } from "../redact";
import { KEYWORD_RULES, classifyKeywords, keywordProvider, keywordResponse, untrustedBodies } from "./keyword";

const CONFIG = loadAgentConfig({});

/** A §11.1 prompt with one T3 block, which is the only place family text lives. */
const promptWith = (sms: string): string =>
  [
    "role=transport_coordinator_agent",
    "T1 site=S1 family=F1 child=C1 scopes=CANCEL_LEG",
    "T2 leg=L-C1-AM state=SCHEDULED version=3",
    `T3 ${wrapUntrusted(sms)}`,
    "T4 channel=SMS locale=en-US",
    "task=choose exactly one tool call",
  ].join("\n");

const call = (prompt: string) => ({
  endpoint: CONFIG.endpointAllowList[0],
  model: CONFIG.model,
  zdr: CONFIG.zdr,
  dataMode: CONFIG.dataMode,
  prompt,
  tools: [],
  promptHash: sha256Hex(prompt),
});

describe("keyword parser: the five PRD keywords", () => {
  it.each([
    ["staying home sick today", "SICK", "AMBER"],
    ["he will be absent", "ABSENT", "AMBER"],
    ["not coming today", "ABSENT", "AMBER"],
    ["yes", "YES", "INFO"],
    ["yep confirmed", "YES", "INFO"],
    ["ready", "READY", "INFO"],
    ["we are waiting outside", "READY", "INFO"],
    ["STOP", "STOP", "RED"],
    ["stop", "STOP", "RED"],
  ])("classifies %j as %s", (sms, keyword, severity) => {
    expect(classifyKeywords(promptWith(sms))).toMatchObject({ keyword, severity });
  });

  it("STOP outranks every other keyword in the same message", () => {
    // An opt-out is not negotiable against whatever else the text happens to say.
    expect(classifyKeywords(promptWith("he's sick, stop texting me")).keyword).toBe("STOP");
    expect(classifyKeywords(promptWith("yes but stop")).keyword).toBe("STOP");
    // And its triage item is the strict one, because consent is messaging/consent.ts's to apply.
    expect(classifyKeywords(promptWith("stop"))).toMatchObject({ severity: "RED", category: "POLICY_BLOCK" });
  });

  it("a text matching nothing is still an escalation, marked for a human read", () => {
    const match = classifyKeywords(promptWith("the van driver was lovely today, thank you"));
    expect(match.keyword).toBeNull();
    expect(match).toMatchObject({ severity: "AMBER", category: "UNKNOWN_SENDER", nextStep: "STAFF_REVIEW" });
  });

  it("every rule is reachable and carries a complete triage item", () => {
    // A rule with no severity or no next step would produce a call the gateway then refuses.
    for (const rule of KEYWORD_RULES) {
      expect(rule.severity).toMatch(/^(?:RED|AMBER|INFO)$/);
      expect(rule.nextStep).not.toBe("");
      expect(rule.category).not.toBe("");
    }
    expect(KEYWORD_RULES.map((r) => r.code)).toEqual(["STOP", "ABSENT", "SICK", "READY", "YES"]);
  });
});

describe("keyword parser: it reads only the untrusted T3 blocks", () => {
  it("extracts each wrapped body, in order", () => {
    const prompt = `T3 ${wrapUntrusted("first")}\nT3 ${wrapUntrusted("second")}`;
    expect(untrustedBodies(prompt)).toEqual(["first", "second"]);
  });

  it("does not parse the scaffolding around them", () => {
    // `state=SCHEDULED`, a tool name or a T2 line must not be able to trip a keyword.
    expect(untrustedBodies(promptWith("nothing here"))).toEqual(["nothing here"]);
    expect(classifyKeywords("T2 leg=L-C1-AM state=STOPPED ready=yes absent=yes").keyword).toBeNull();
    expect(classifyKeywords("task=choose exactly one tool call").keyword).toBeNull();
  });

  it("a prompt with no family text has nothing to classify", () => {
    expect(classifyKeywords("T1 site=S1").keyword).toBeNull();
    expect(classifyKeywords(promptWith("   ")).keyword).toBeNull();
  });
});

describe("keyword parser: it escalates and never acts", () => {
  it("emits exactly one escalate_exception call, whatever it read", () => {
    for (const sms of ["staying home sick", "yes", "STOP", "something else entirely", ""]) {
      const body = keywordResponse(promptWith(sms));
      expect(body.tool_calls).toHaveLength(1);
      expect(body.tool_calls![0].name).toBe("escalate_exception");
      expect(body.finish_reason).toBe("keyword_fallback");
    }
  });

  it("never calls a tool that sends or mutates transport state", () => {
    // The named ones are the tempting mis-designs: a keyword must not cancel a leg or close an ack.
    const forbidden = ["cancel_attendance_or_leg", "record_acknowledgment", "send_followup", "report_boarding"];
    for (const sms of ["staying home sick", "yes ready", "absent", "stop"]) {
      expect(forbidden).not.toContain(keywordResponse(promptWith(sms)).tool_calls![0].name);
    }
  });

  it("puts no word of the family's message in its output", () => {
    // TEST-SEC-01's rule holds on the degraded path too: the summary names a code, not the text.
    const sms = "Tommy is staying home, call me on 561-555-0100";
    const serialized = JSON.stringify(keywordResponse(promptWith(sms)));
    expect(serialized).not.toContain("Tommy");
    expect(serialized).not.toContain("561-555-0100");
    expect(serialized).toContain("SICK");
  });

  it("its call passes the real gateway, so the fallback is audited like any other turn", async () => {
    const provider = keywordProvider(CONFIG);
    const gateway = createGateway(provider, CONFIG);
    const prompt = promptWith("staying home sick today");
    const result = await gateway.complete({ runId: "RUN-KW", prompt });
    expect(result.call).toMatchObject({ tool: "escalate_exception", tier: "auto" });
    expect(gateway.auditLog.at(-1)).toMatchObject({ outcome: "ACCEPTED", providerKind: "keyword" });
    // The fallback is not a second, unaudited way for the agent to act.
    expect(gateway.auditLog).toHaveLength(1);
    expect(JSON.stringify(gateway.auditLog)).not.toContain("staying home sick");
  });

  it("records what it classified and never the text it classified", async () => {
    const provider = keywordProvider(CONFIG);
    await provider.invoke(call(promptWith("he is sick")));
    await provider.invoke(call(promptWith("stop")));
    expect(provider.matches.map((m) => m.keyword)).toEqual(["SICK", "STOP"]);
    expect(JSON.stringify(provider.matches)).not.toContain("he is sick");
  });

  it("reaches no network of its own", async () => {
    const attempted = vi.fn(() => {
      throw new Error("the keyword fallback attempted a network call");
    });
    vi.stubGlobal("fetch", attempted);
    try {
      const provider = keywordProvider(CONFIG);
      await provider.invoke(call(promptWith("staying home sick")));
      expect(attempted).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("keyword parser: a negated informational match degrades to a staff read", () => {
  it.each([
    "not ready",
    "he isn't ready yet",
    "she is no longer waiting",
    "we aren't outside",
    "nope",
    "no",
  ])("does not read %j as an INFO item", (sms) => {
    // Reading these as READY/YES would under-triage a child who is not where the van expects
    // them. They fall through to the no-match item instead: AMBER, and a staff read.
    const match = classifyKeywords(promptWith(sms));
    expect(match.keyword).not.toBe("READY");
    expect(match.keyword).not.toBe("YES");
    expect(match.severity).toBe("AMBER");
  });

  it("a clause boundary ends the negation's reach", () => {
    expect(classifyKeywords(promptWith("not today. ready now")).keyword).toBe("READY");
    expect(classifyKeywords(promptWith("cant talk, yes to the van")).keyword).toBe("YES");
  });

  it("does not weaken the rules that must not be negatable", () => {
    // "don't stop texting me" is still about an opt-out and still belongs in front of a human,
    // and "not sick" is still a message worth a staff read rather than a silent INFO.
    expect(classifyKeywords(promptWith("dont stop texting me")).keyword).toBe("STOP");
    expect(classifyKeywords(promptWith("he is not sick, just late")).keyword).toBe("SICK");
    expect(classifyKeywords(promptWith("not absent today")).keyword).toBe("ABSENT");
  });

  it("the plain affirmatives still classify", () => {
    // Guards against the negation check swallowing the happy path.
    expect(classifyKeywords(promptWith("ready")).keyword).toBe("READY");
    expect(classifyKeywords(promptWith("yes")).keyword).toBe("YES");
    expect(classifyKeywords(promptWith("we are waiting outside")).keyword).toBe("READY");
  });
});
