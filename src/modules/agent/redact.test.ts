/**
 * The PHI detectors (`findLeaks`) and `redact()`. The gateway no longer refuses a prompt on them —
 * the agent runtime is HIPAA-compliant (2026-10-18) — so what is tested here is the detectors
 * themselves.
 */
import { describe, expect, it } from "vitest";
import { CHILDREN, EXTERNAL_PEOPLE, FAMILIES } from "@/modules/demo/fixtures/standard";
import { RECORDED_PROMPTS } from "./fixtures/prompts";
import {
  FIXTURE_NAMES,
  findLeaks,
  redact,
  sha256Hex,
} from "./redact";

describe("findLeaks finds nothing in a token-only prompt", () => {
  it.each(RECORDED_PROMPTS.map((p) => [p.note, p.prompt] as const))("accepts the %s prompt", (_note, prompt) => {
    expect(findLeaks(prompt)).toEqual([]);
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

describe("findLeaks detects numbers, addresses and roster names", () => {
  it.each([
    ["E.164", "contact=+15615550101"],
    ["E.164 with separators", "contact=+1-561-555-0101"],
    ["parenthesised area code", "call (561) 555-0102 back"],
    ["dashed NANP", "call 561-555-0103"],
    ["local seven digit", "call 555-0104"],
    ["bare 11-digit", "sms 15615550105 now"],
  ])("refuses a prompt carrying a phone number (%s)", (_label, prompt) => {
    expect(findLeaks(prompt).map((f) => f.kind)).toContain("PHONE");
  });

  it.each([
    ["street suffix", "pickup=2216 Jog Rd"],
    ["full address", "1200 Lake Worth Road, Lake Worth FL 33460"],
    ["unit", "drop at Apt 4B"],
    ["PO box", "mail to P.O. Box 1188"],
    ["state and ZIP", "the center is in FL 33415"],
  ])("refuses a prompt carrying a street address (%s)", (_label, prompt) => {
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
      expect(findLeaks(`child=${name} leg=L-C1-AM`).map((f) => f.kind)).toContain("NAME");
    }
    expect(FIXTURE_NAMES.length).toBeGreaterThan(20);
  });

  it("catches a name whatever its case, and with a trailing initial", () => {
    for (const prompt of ["child=Mia R.", "child=mia r.", "child=MIA", "guardian=Alma R"]) {
      expect(findLeaks(prompt).map((f) => f.kind)).toContain("NAME");
    }
  });
});

describe("a uuid is a token, not a phone number", () => {
  /**
   * Every id this system passes around is a uuid, and roughly one in 170 contains a run that the
   * seven-digit local-number pattern would otherwise claim: in `…-b741-7402edfbcabb` it finds
   * "741-7402" with a letter on each side. Refusing those prompts and blocking those tool calls
   * would be a guard that fails at random, so uuids are excluded from the scan the way
   * `scripts/seed-lint.mjs` excludes them from its own.
   */
  const COLLIDING = "01a13fd0-9612-79ab-b741-7402edfbcabb";

  it("the shape that used to read as a local number is clean, in a prompt and in an argument", () => {
    expect(findLeaks(COLLIDING)).toEqual([]);
    expect(findLeaks(`T2 leg=${COLLIDING} version=1`)).toEqual([]);
    expect(redact(COLLIDING)).toBe(COLLIDING);
  });

  it("holds for a whole prompt full of generated ids", () => {
    // Deterministic stand-ins for a tier-assembly prompt: the generated ones are what made the
    // slice-3 suites flaky before this, at about half a percent of runs per id.
    const ids = [
      "01a13fd0-9613-7a96-a257-9650bb4d4c64",
      "0199e5f0-1234-7000-8000-000000000001",
      "01a00000-999a-7111-b222-3334567890ab",
    ];
    const prompt = ids.map((id, i) => `T2 leg${i}=${id}`).join("\n");
    expect(findLeaks(prompt)).toEqual([]);
    expect(findLeaks(prompt)).toEqual([]);
  });

  it("a real number next to a uuid is still caught, and the uuid survives the redaction", () => {
    const text = `leg=${COLLIDING} contact=+1-561-555-0101`;
    expect(findLeaks(text).map((f) => f.kind)).toEqual(["PHONE"]);
    expect(redact(text)).toBe(`leg=${COLLIDING} contact=[REDACTED:PHONE]`);
  });

  it("counts every class once across the chunks either side of a uuid", () => {
    const text = `call 555-0104 about ${COLLIDING} then 555-0105 for Alma`;
    expect(findLeaks(text)).toEqual([
      { kind: "PHONE", count: 2 },
      { kind: "NAME", count: 1 },
    ]);
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

  it("is idempotent, and leaves nothing a detector would find", () => {
    const dirty = "Alma R. +1-561-555-0101 lives at 2216 Jog Rd, Greenacres FL 33415";
    const once = redact(dirty);
    expect(redact(once)).toBe(once);
    expect(findLeaks(once)).toEqual([]);
  });
});
