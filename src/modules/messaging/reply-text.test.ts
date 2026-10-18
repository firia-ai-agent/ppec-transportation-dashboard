/**
 * PPE-105 S3 (b): A PHONE NUMBER WRITTEN OUT IN WORDS IS STILL A PHONE NUMBER.
 *
 * `reply-text.ts` is the one shape a model's own prose has to have before it may reach a family
 * (the staff-approval path, Firia 2026-10-18 11:04 AM ET), and every digit rule it had was a rule
 * about *digits*. "five six one five five five oh one seven seven" walked through all of them, and
 * so did a line that mixed the two ("561 five five five 0177") — which is the obvious next move
 * for anything trying to get a number past a filter.
 *
 * The two halves of this file are the two ways that rule can be wrong, and the second matters as
 * much as the first: a check that refuses "we'll be there at five" would take the ordinary reply
 * away from every family, so each refusal below is paired with the ordinary sentence nearest it.
 *
 * No database and no imports beyond the module: this is a pure shape check and it is meant to
 * stay one.
 */
import { describe, expect, it } from "vitest";
import { familyTexts } from "@/ui/copy";
import { REPLY_TEXT_MAX, isReplyText, replyTextIssue } from "./reply-text";

describe("a phone number spelled out in words", () => {
  const SPELLED = [
    "Call me on five six one five five five oh one seven seven",
    "reach us at five, six, one, five, five, five, zero, one, seven, seven",
    // The local seven, without the area code: still a number.
    "my cell is five five five oh one seven seven",
    // Hyphenated the way a person writes one out.
    "five-six-one-five-five-five-zero-one-seven-seven",
  ];

  it.each(SPELLED)("refuses %j", (text) => {
    expect(replyTextIssue(text)).toBe("contains a phone number");
    expect(isReplyText(text)).toBe(false);
  });

  it("refuses a line that mixes digits and words", () => {
    for (const text of [
      "text 561 five five five 0177 instead",
      "it is 5615 five five 0177",
      "call five six one 5550177",
    ]) {
      expect({ text, issue: replyTextIssue(text) }).toEqual({ text, issue: "contains a phone number" });
    }
  });

  it("says what is wrong and never the value", () => {
    const issue = replyTextIssue("Call me on five six one five five five oh one seven seven");
    expect(issue).not.toMatch(/five|561|\d/);
  });

  it("reads full-width digits as digits, as every other rule here does", () => {
    // NFKC runs first, so a mixed full-width line meets the same count.
    expect(replyTextIssue("call five six one ５５５ 0177")).toBe("contains a phone number");
  });
});

describe("…and the ordinary sentences it must not take away", () => {
  const ORDINARY = [
    "Hi Dara, yes, we'll drop Noah off at five today. Thanks for letting us know!",
    "Yes — we can do five instead of four.",
    "We'll be there at five thirty, right after the last stop.",
    "Noah is one of six riders on that van today.",
    "Five o'clock works. See you then!",
    "That's fine for Tuesday and Thursday, both at five.",
    "He was one of two children waiting, and we have him now.",
  ];

  it.each(ORDINARY)("allows %j", (text) => {
    expect(replyTextIssue(text)).toBeNull();
  });

  /**
   * The copy this module polices is held to its own rule (`alert-words.fallbackReply` checks the
   * filled line before it uses it), so a new rule that refused the fallback would silently empty
   * the card it is the floor of.
   */
  it("leaves the reply fallbacks this app actually sends alone", () => {
    expect(replyTextIssue(familyTexts.dropoffReplyFallbackPlain)).toBeNull();
    expect(
      replyTextIssue(
        familyTexts.dropoffReplyFallback
          .replace("{parentName}", "Dara")
          .replace("{childName}", "Noah")
          .replace("{eta}", "5"),
      ),
    ).toBeNull();
  });

  it("still answers the rules it already had", () => {
    expect(replyTextIssue("")).toBe("empty");
    expect(replyTextIssue(7)).toBe("not text");
    expect(replyTextIssue("x".repeat(REPLY_TEXT_MAX + 1))).toBe(`longer than ${REPLY_TEXT_MAX} characters`);
    expect(replyTextIssue("call 561-555-0177")).toBe("contains a phone number");
    expect(replyTextIssue("PPEC: yes")).toBe("contains a machine prefix");
    expect(replyTextIssue("see example dot com")).toBe("contains a url");
    expect(replyTextIssue("reason PARENT_REQUEST")).toBe("contains a internal code");
  });
});
