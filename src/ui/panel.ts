/**
 * THE AGENT PANEL'S ONE SHAPE (ledger #79): anything the agent proposes, as a person reads it.
 *
 * A reply to a family and a change to the day were two cards with two components; they are one
 * panel now, drawn by `AgentPanel` wherever it appears — the bubble, Family texts' For you, the
 * family's own thread, a leg's drawer. Each kind of row becomes this shape here, once:
 *
 *  - `title` — what the panel is for ("Reply to Dara", "Change the afternoon plan");
 *  - `note` — the agent's own sentence, when it wrote one;
 *  - `lines` — what Approve does to the day, generated from the plan;
 *  - `message` — the words a family would get, and whether Edit may change them.
 *
 * One row behind it, so a panel raised anywhere shows everywhere and is gone everywhere once
 * decided. Pure: no React, no database.
 */
import type { ProposalView } from "@/app/(app)/family-texts/conversations";
import type { ConfirmView } from "@/modules/actions/confirm-view";
import { approval, confirmCopy, fill } from "./copy";

export type PanelView = {
  readonly id: string;
  /** Which decision path the press takes: a family reply, or a change confirmed as an action. */
  readonly kind: "reply" | "confirm";
  readonly title: string;
  /** What a screen reader hears the panel as. */
  readonly label: string;
  readonly note: string | null;
  readonly lines: readonly string[];
  readonly message: { readonly text: string; readonly editable: string | null } | null;
  /** The family thread this panel belongs to, where Edit opens. Null when it has none. */
  readonly threadHref: string | null;
  /**
   * What the refusing button says, and it names what it refuses: "Don't send" for a reply, the
   * card's own verb for a change (Vera). On the panel rather than decided inside it,
   * so the one component draws both kinds without knowing either.
   */
  readonly decline: string;
};

/** A reply to a family, with the change it makes to the ride. */
export function replyPanel(p: ProposalView, threadHref: string): PanelView {
  return {
    id: p.approvalId,
    kind: "reply",
    title: fill(approval.replyTo, { parent: p.parentFirstName }),
    label: fill(approval.cardLabel, { adult: p.adultName }),
    note: null,
    lines: p.lines.length > 0 ? p.lines : p.changeLine ? [p.changeLine] : [],
    message: { text: p.draftText === "" ? approval.draftFailed : p.draftText, editable: p.replyText },
    threadHref,
    decline: approval.dontSend,
  };
}

/** A change the agent prepared for a person to confirm. */
export function confirmPanel(c: ConfirmView): PanelView {
  return {
    id: c.approvalId,
    kind: "confirm",
    title: c.impact.length > 0 ? c.summary : confirmCopy.heading,
    label: confirmCopy.heading,
    // The model's own sentence when it wrote one; the action's line when nothing else says what it does.
    note: c.note ?? (c.impact.length === 0 ? c.summary : null),
    lines: c.impact,
    message: null,
    threadHref: null,
    decline: c.decline,
  };
}
