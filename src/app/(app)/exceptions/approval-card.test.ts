/**
 * THE WORDS ON THE APPROVAL CARD (Vera's verdict, 2026-10-17 12:59 PM ET).
 *
 * She settled this card string by string, and each one is a rule rather than a preference — so
 * each one is pinned here, rendered rather than described, because the whole point of the screen is
 * that a coordinator reads the text a family will get and believes nothing has been sent yet.
 *
 * What is asserted, in her order:
 *  1. the **exact text** the family would get, as words, not a description of a change;
 *  2. "The family hears nothing until you approve", **above both buttons** — the fear a person
 *     brings to this screen is that reading it already sent something, so position is part of the
 *     string's job and is checked as position;
 *  3. the three buttons, verbatim: "Approve and send", "Edit", "Don't send";
 *  4. on a draft that cannot be rendered, "Couldn't draft a reply. Write one yourself or try
 *     again." — and both decision buttons gone, because there is nothing to approve if nobody can
 *     see what would be sent.
 *
 * `useActionState` returns its initial state in a static render, which is exactly the state this
 * card is in before anybody presses anything — so the card under test is the real one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { approval as approvalCopy, fill, board } from "@/ui/copy";
import { renderTemplate } from "@/modules/messaging/templates";
import type { PendingApproval } from "@/modules/approvals/decide";
import { ApprovalCard } from "./ApprovalCard";

/** React escapes an apostrophe in text; Vera's copy has several ("Don't send"). */
const esc = (text: string): string => text.replace(/'/g, "&#x27;");

const VARS = { legDate: "2026-10-14", eta: "17:00", stopLabel: "OKEE-PARK" };
const ITEM: PendingApproval = {
  id: "01900000-0000-7000-8000-0000000000a1",
  childLabel: "Noah O.",
  serviceDate: "2026-10-14",
  direction: "PM",
  text: renderTemplate("dropoff.changed", VARS),
  templateId: "dropoff.changed",
  vars: VARS,
  requestedTime: "17:00",
  stopToken: "OKEE-PARK",
  rationaleCode: "PARENT_REQUEST",
};

const BODIES = { "17:00": ITEM.text, "17:15": renderTemplate("dropoff.changed", { ...VARS, eta: "17:15" }) };

/** The decision, as the page hands it in. Never called here: this suite is about the words. */
const decide = async () => ({ status: "idle" }) as const;

const html = (item: PendingApproval = ITEM, bodies: Readonly<Record<string, string>> = BODIES): string =>
  renderToStaticMarkup(createElement(ApprovalCard, { item, bodyFor: bodies, decide }));

describe("what a coordinator reads", () => {
  it("leads with the exact text the family would get", () => {
    const markup = html();
    expect(markup).toContain(esc(approvalCopy.exactTextHeading));
    // The words themselves, through the outbox's own renderer — a real place and a 12-hour clock.
    expect(markup).toContain("New drop-off around 5:00 PM at Okeeheelee Park");
    // No child's name in the body a family receives (Veri #12)…
    const bubbleStart = markup.indexOf("New drop-off");
    expect(markup.slice(bubbleStart, bubbleStart + 200)).not.toContain("Noah");
    // …while the card's own heading names them, because a coordinator is the one reading it.
    expect(markup).toContain(
      esc(fill(approvalCopy.cardHeading, { child: "Noah O.", ride: board.pmSpoken })),
    );
  });

  it("says the family hears nothing, above both buttons", () => {
    const markup = html();
    const line = markup.indexOf(esc(approvalCopy.nothingUntilApproved));
    expect(line, "the reassurance is on the card").toBeGreaterThan(-1);
    // Position is part of the string's job: it must come before either decision.
    expect(line).toBeLessThan(markup.indexOf(esc(approvalCopy.approveAndSend)));
    expect(line).toBeLessThan(markup.indexOf(esc(approvalCopy.dontSend)));
  });

  it("offers Vera's three buttons, word for word", () => {
    const markup = html();
    for (const label of [approvalCopy.approveAndSend, approvalCopy.edit, approvalCopy.dontSend]) {
      expect(markup, label).toContain(esc(label));
    }
    // And says what happens, not what the system calls it: no "Reject", no bare "Approve".
    expect(markup).not.toMatch(/>\s*Reject\s*</);
    expect(markup).not.toMatch(/>\s*Decline\s*</);
  });

  it("says the family's reason in words, never the code behind it", () => {
    const markup = html();
    expect(markup).toContain(esc(approvalCopy.reasons.PARENT_REQUEST));
    expect(markup).not.toContain("PARENT_REQUEST");
    // A code this screen has no sentence for reads as the general case, still never as the code.
    const odd = html({ ...ITEM, rationaleCode: "SOMETHING_NEW" });
    expect(odd).toContain(esc(approvalCopy.reasons.OTHER));
    expect(odd).not.toContain("SOMETHING_NEW");
  });

  /**
   * The model could not draft a reply, or the stored vars no longer render. A person writes one
   * instead — and there is nothing to approve, so neither decision is offered.
   */
  it("says so when there is no text, and withdraws both decisions", () => {
    const markup = html({ ...ITEM, text: "" }, {});
    expect(markup).toContain(esc(approvalCopy.draftFailed));
    expect(markup).not.toContain(esc(approvalCopy.approveAndSend));
    expect(markup).not.toContain(esc(approvalCopy.dontSend));
  });

  /** State is never carried by colour alone (§9): every outcome on this card is a sentence. */
  it("carries no state in markup a greyscale screenshot would lose", () => {
    const markup = html();
    // The card is the §3 neutral frame: no severity tone class, no colour attribute.
    expect(markup).not.toMatch(/style="[^"]*color/i);
    expect(markup).not.toMatch(/data-severity/);
  });
});
