import { describe, expect, it } from "vitest";
import { sayClock } from "@/domain/eta/eta";
import { demoChildToken } from "@/modules/demo/fixtures/standard";
import { replyTextIssue } from "@/modules/messaging/reply-text";
import { familyTexts, fill } from "@/ui/copy";
import { dropoffAlertWords, dropoffReplyWords } from "./alert-words";

/**
 * THE WORDS ON A WAITING DROP-OFF PROPOSAL, when the model's own are not usable.
 *
 * The card is Vera's (/workspace/ppec-redesign/mockups/family-texts.html `.prop`, and the thread
 * card in /workspace/ppec-redesign/mockups/agent-bubble.html): a parent's name, the message as a
 * bubble, and the controls. **The bubble is never empty** — a card whose words are blank is a
 * coordinator being asked to approve nothing — and until this, a reply the gateway's shape check
 * refused took the whole proposal down with it: no approval row, no task, nothing on any board.
 *
 * So the fallback here is the same move the alert line already made, and the row says which of the
 * two wrote it. Nothing in either sentence is read out of what the family typed.
 */

/** Noah O. — the child the founder's copy names, by the token the operational tables hold. */
const CHILD_TOKEN = demoChildToken("C2");
const AT_FIVE = "17:00";

describe("the reply on a drop-off proposal", () => {
  it("is the model's own sentence when it wrote one that can be sent", () => {
    const written = dropoffReplyWords({
      // The prompt is token-only, so the model writes the people as tokens and they come back as
      // the first names the family uses.
      reply: "Hi F2, yes, we'll drop C2 off at 5 today. Thanks for letting us know.",
      childToken: CHILD_TOKEN,
      requestedTime: AT_FIVE,
    });

    expect(written.modelWritten).toBe(true);
    expect(written.reason).toBeNull();
    expect(written.text).toBe("Hi Dara, yes, we'll drop Noah off at 5 today. Thanks for letting us know.");
  });

  it.each([
    ["nothing at all", undefined, "no reply written"],
    ["an empty string", "   ", "no reply written"],
    ["a token this roster cannot name", "Hi F2, yes, C47 will be dropped at 5.", "not in names"],
    ["a phone number", "Hi F2, call us on 561-555-0177 if anything changes.", "contains a phone number"],
    ["a link", "Hi F2, track the van at https://example.com/track", "contains a url"],
    ["the machine's own prefix", "PPEC: yes, five works.", "contains a machine prefix"],
  ])("falls back to the copy line, and says why, for %s", (_label, reply, reason) => {
    const drafted = dropoffReplyWords({ reply, childToken: CHILD_TOKEN, requestedTime: AT_FIVE });

    expect(drafted.modelWritten).toBe(false);
    expect(drafted.reason).toBe(reason);
    expect(drafted.text).toBe(
      fill(familyTexts.dropoffReplyFallback, {
        parentName: "Dara",
        childName: "Noah",
        eta: sayClock(AT_FIVE)!,
      }),
    );
    // The reason is a class for the log, and it never carries the value it refused.
    expect(drafted.reason).not.toContain("561");
    expect(drafted.reason).not.toContain("example");
  });

  it("is never empty, and is always sendable, whatever the row holds", () => {
    const rows = [
      { reply: undefined, childToken: CHILD_TOKEN, requestedTime: AT_FIVE },
      // Only the place moves: there is no time to put in the named line.
      { reply: undefined, childToken: CHILD_TOKEN, requestedTime: null },
      // A child no fixture accounts for: nobody to name, so the line names nobody.
      { reply: undefined, childToken: "0199a1b2-c3d4-7000-8000-00000000abcd", requestedTime: AT_FIVE },
    ];

    for (const row of rows) {
      const drafted = dropoffReplyWords(row);
      expect(drafted.text).not.toBe("");
      // Held to exactly the shape the model's own sentence is held to, by the same checker the
      // outbox's egress door uses (`messaging/reply-text.ts`).
      expect(replyTextIssue(drafted.text)).toBeNull();
      expect(drafted.modelWritten).toBe(false);
    }
    // The two rows with nothing to name land on the plain line rather than on a gap or a token.
    expect(dropoffReplyWords(rows[1]).text).toBe(familyTexts.dropoffReplyFallbackPlain);
    expect(dropoffReplyWords(rows[2]).text).toBe(familyTexts.dropoffReplyFallbackPlain);
  });

  it("says nothing about the build on the card: the fallback is words, never a chip", () => {
    const drafted = dropoffReplyWords({ reply: "PPEC: no.", childToken: CHILD_TOKEN, requestedTime: AT_FIVE });
    // Whether the model wrote it is a fact for the log, and the only thing the card can render is
    // `text` — there is no label, no flag and no second sentence on the object a screen reads.
    expect(Object.keys(drafted).sort()).toEqual(["modelWritten", "reason", "text"]);
    expect(drafted.text).not.toContain("copy");
    expect(drafted.text).not.toContain("assistant");
  });
});

describe("the alert line on the same proposal", () => {
  it("falls back to the named line rather than leaving the proposal wordless", () => {
    // A sentence with a token nobody can name: the card must not read "C47 asked…", and it must
    // not vanish either.
    const words = dropoffAlertWords({
      alertText: "C47's family asked for a different drop-off time.",
      childToken: CHILD_TOKEN,
      requestedTime: AT_FIVE,
    });

    expect(words).toBe("Dara asked to move Noah's drop-off to 5. Your reply is ready.");
  });
});
