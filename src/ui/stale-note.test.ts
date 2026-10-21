import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextsScreen } from "@/app/(app)/family-texts/TextsScreen";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";
import type { StaleNoteView } from "@/modules/actions/confirm-view";
import styles from "@/app/(app)/family-texts/texts.module.css";
import { approval, confirmCopy, fill, refusal } from "./copy";
import { AgentPanel } from "./AgentPanel";
import { PanelActionsProvider } from "./PanelActions";
import { stalePanel } from "./panel";

/** A stale agent plan card's note on For you (Vera), rendered over the real screen. */
const note: StaleNoteView = {
  approvalId: "00000000-0000-7000-8000-000000000124",
  title: "Move Noah to Van 1, afternoon.",
  says: fill(refusal.says.STALE_CARD, { child: "Noah" }),
  fix: { label: refusal.fix.planRoutes, href: PLAN_ROUTES_PATH },
};
const noop = async () => {};
const screen = (staleNotes: readonly StaleNoteView[]) =>
  renderToStaticMarkup(
    createElement(TextsScreen, {
      tab: "for-you", rows: [], thread: null, proposals: [], alerts: [], alertsUnreadable: false, assistantReachable: true,
      context: null, editingId: null, threadOpen: false, decide: noop as never, takeAlert: noop as never, showForYouTab: true,
      staleNotes, staleNoteActions: { dismiss: noop, open: noop },
    }),
  );

describe("For you with a stale agent plan card (Vera)", () => {
  it("renders the note — the line, Open Plan routes, Dismiss — and never an Approve", () => {
    const html = screen([note]);
    expect(html).toContain("Noah&#x27;s plan changed after this card was written.");
    expect(html).toContain("Open Plan routes");
    expect(html).toContain(confirmCopy.staleNoteDismiss);
    expect(html).toContain(`data-stale-note="${note.approvalId}"`);
    expect(html).not.toContain(confirmCopy.confirm);
    expect(html).not.toMatch(/\b422\b|STALE_CARD|basis_version/);
  });

  it("shows no empty state while a note is there, and the empty state once nothing is left", () => {
    expect(screen([note])).not.toContain(approval.none);
    expect(screen([])).toContain(approval.none);
  });
});

/**
 * THE NOTE IS A CARD, NOT A REFUSAL (Vera's second pass). It was drawn in `.refusedLine` — the
 * crit-tone panel a refused *press* leaves — with two browser-default buttons under it. A card the
 * board moved past is news, not an error, so it takes the proposal card's own classes: the white
 * surface with the teal hairline, the teal primary button, and the quiet text button beside it.
 */
describe("the note is drawn as a card, in the panel's own styles", () => {
  const html = screen([note]);
  const classesOf = (tag: string) => [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, "g"))].map((m) => m[1]);

  it("is the proposal card's box and head, never the refusal tone", () => {
    expect(classesOf("section")).toContain(styles.card);
    expect(classesOf("h3")).toContain(styles.cardTitle);
    expect(html).toContain(styles.cardHead);
    expect(html).not.toContain(styles.refusedLine);
  });

  it("gives Open Plan routes the teal button and Dismiss the quiet one — neither unstyled", () => {
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toMatch(/class="/);
    expect(buttons.find((b) => b.includes("data-open-plan-routes"))).toContain(styles.primary);
    expect(buttons.find((b) => b.includes("data-dismiss"))).toContain(styles.quiet);
    expect(html).toContain(styles.actions);
  });
});

/**
 * ONE CARD, NOT TWO (Vera). The stale card keeps its own bold line, and the note sits inside that
 * same card where Approve and Don't move would be — on For you and in the bubble alike.
 */
describe("a stale card carries its note inside itself", () => {
  const one = (html: string) => {
    const sections = [...html.matchAll(/<section[^>]*>[\s\S]*?<\/section>/g)].map((m) => m[0]);
    expect(sections).toHaveLength(1);
    return sections[0];
  };
  const noWayToApprove = (card: string) => {
    expect(card).not.toContain(`>${confirmCopy.confirm}<`);
    expect(card).not.toContain(confirmCopy.dont.moveChild);
    expect(card).not.toMatch(/name="decision"/);
  };

  it("on For you: the move is the bold title and the note is in the same card, with no Approve", () => {
    const card = one(screen([note]));
    expect(card).toMatch(/<h3[^>]*>Move Noah to Van 1, afternoon\.<\/h3>/);
    expect(card).toContain("Noah&#x27;s plan changed after this card was written.");
    expect(card).toContain("Open Plan routes");
    noWayToApprove(card);
  });

  it("in the bubble: the same one card, its note in place of the buttons", () => {
    const html = renderToStaticMarkup(
      createElement(PanelActionsProvider, {
        actions: { decide: noop as never, confirm: noop as never, dismissStale: noop, openStale: noop },
        children: createElement(AgentPanel, { panel: stalePanel(note) }),
      }),
    );
    const card = one(html);
    expect(card).toContain(`data-stale-note="${note.approvalId}"`);
    expect(card).toMatch(/<h3[^>]*>Move Noah to Van 1, afternoon\.<\/h3>/);
    expect(card).toContain("Noah&#x27;s plan changed after this card was written.");
    expect(card).toContain(confirmCopy.staleNoteDismiss);
    noWayToApprove(card);
  });
});
