import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextsScreen } from "@/app/(app)/family-texts/TextsScreen";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";
import type { StaleNoteView } from "@/modules/actions/confirm-view";
import { approval, confirmCopy, fill, refusal } from "./copy";

/** A stale agent plan card's note on For you (Vera, PR 124), rendered over the real screen. */
const note: StaleNoteView = {
  approvalId: "00000000-0000-7000-8000-000000000124",
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

describe("For you with a stale agent plan card (Vera, PR 124)", () => {
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
