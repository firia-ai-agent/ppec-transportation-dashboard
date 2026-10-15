/**
 * TEST-SEC-01 (PRD §18.3 l.1334) at the unit level: the prompt guard fails closed on E.164
 * numbers, street-address patterns and untokenized names, and logs a hash and nothing else.
 */
import { describe, expect, it } from "vitest";
import { CHILDREN, EXTERNAL_PEOPLE, FAMILIES } from "@/modules/demo/fixtures/standard";
import { RECORDED_PROMPTS } from "./fixtures/prompts";
import {
  FIXTURE_NAMES,
  PromptLeakError,
  findLeaks,
  redact,
  sha256Hex,
  validatePromptTokensOnly,
} from "./redact";

describe("TEST-SEC-01: validatePromptTokensOnly accepts token-only prompts", () => {
  it.each(RECORDED_PROMPTS.map((p) => [p.note, p.prompt] as const))("accepts the %s prompt", (_note, prompt) => {
    expect(validatePromptTokensOnly(prompt)).toBe(sha256Hex(prompt));
  });

  it.each([
    "T2 leg=L-C1-AM state=SCHEDULED version=3 am_window=08:00",
    "child=C1 family=F1 thread=TH-F1 ack=ACK-1 task=TK-1",
    "eta=08:12 window=08:12-08:22 stop=GA-LIBRARY date=2026-10-16",
    "leg=01900000-0000-7000-8000-00240000000a version=11",
  ])("accepts %s", (prompt) => {
    expect(findLeaks(prompt)).toEqual([]);
  });
});

describe("TEST-SEC-01: validatePromptTokensOnly fails closed", () => {
  it.each([
    ["E.164", "contact=+15615550101"],
    ["E.164 with separators", "contact=+1-561-555-0101"],
    ["parenthesised area code", "call (561) 555-0102 back"],
    ["dashed NANP", "call 561-555-0103"],
    ["local seven digit", "call 555-0104"],
    ["bare 11-digit", "sms 15615550105 now"],
  ])("refuses a prompt carrying a phone number (%s)", (_label, prompt) => {
    expect(() => validatePromptTokensOnly(prompt)).toThrow(PromptLeakError);
    expect(findLeaks(prompt).map((f) => f.kind)).toContain("PHONE");
  });

  it.each([
    ["street suffix", "pickup=2216 Jog Rd"],
    ["full address", "1200 Lake Worth Road, Lake Worth FL 33460"],
    ["unit", "drop at Apt 4B"],
    ["PO box", "mail to P.O. Box 1188"],
    ["state and ZIP", "the center is in FL 33415"],
  ])("refuses a prompt carrying a street address (%s)", (_label, prompt) => {
    expect(() => validatePromptTokensOnly(prompt)).toThrow(PromptLeakError);
    expect(findLeaks(prompt).map((f) => f.kind)).toContain("ADDRESS");
  });

  it("refuses a prompt carrying any name on the synthetic roster", () => {
    // The roster is the name list on purpose: in P1 every person is a fixture, so any human name
    // in a prompt is a name the tokenizer should have replaced.
    const everyName = [
      ...FAMILIES.map((f) => f.guardian.firstName),
      ...CHILDREN.map((c) => c.firstName),
      ...EXTERNAL_PEOPLE.map((p) => p.firstName),
    ];
    for (const name of everyName) {
      expect(() => validatePromptTokensOnly(`child=${name} leg=L-C1-AM`)).toThrow(PromptLeakError);
    }
    expect(FIXTURE_NAMES.length).toBeGreaterThan(20);
  });

  it("catches a name whatever its case, and with a trailing initial", () => {
    for (const prompt of ["child=Mia R.", "child=mia r.", "child=MIA", "guardian=Alma R"]) {
      expect(findLeaks(prompt).map((f) => f.kind)).toContain("NAME");
    }
  });

  it("logs the hash and the classes only — never the prompt", () => {
    const prompt = "guardian=Alma R. phone=+1-561-555-0101 pickup=2216 Jog Rd";
    try {
      validatePromptTokensOnly(prompt);
      expect.unreachable();
    } catch (e) {
      const err = e as PromptLeakError;
      expect(err.promptHash).toBe(sha256Hex(prompt));
      expect(err.findings.map((f) => f.kind).sort()).toEqual(["ADDRESS", "NAME", "PHONE"]);
      for (const secret of ["Alma", "561", "Jog Rd", "+1"]) expect(err.message).not.toContain(secret);
      // Nor does the thrown object as a whole, which is what a logger would serialize.
      expect(JSON.stringify({ message: err.message, hash: err.promptHash, findings: err.findings })).not.toContain("Alma");
    }
  });
});

describe("redact()", () => {
  it("replaces each class with its placeholder", () => {
    expect(redact("text Alma at (561) 555-0102 about 2216 Jog Rd")).toBe(
      "text [REDACTED:NAME] at [REDACTED:PHONE] about [REDACTED:ADDRESS]",
    );
  });

  it("leaves tokens, codes, times and dates alone", () => {
    const safe = "C1 L-C1-AM FULL_DAY ILLNESS 2026-10-16 08:12 GA-LIBRARY v3";
    expect(redact(safe)).toBe(safe);
  });

  it("is idempotent, and its output passes the prompt guard", () => {
    const dirty = "Alma R. +1-561-555-0101 lives at 2216 Jog Rd, Greenacres FL 33415";
    const once = redact(dirty);
    expect(redact(once)).toBe(once);
    expect(findLeaks(once)).toEqual([]);
    expect(() => validatePromptTokensOnly(once)).not.toThrow();
  });
});
