import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/today",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: () => {} }),
}));

import { AgentPanel } from "./AgentPanel";
import { confirmPanel, replyPanel, type PanelView } from "./panel";
import { approval, confirmCopy } from "./copy";

/**
 * THE BUTTON THAT REFUSES A CARD SAYS WHAT IT REFUSES (Vera).
 *
 * It read "Don't" beside "Approve": a word, not an answer, on the one control whose whole job is to
 * be unambiguous. The verb now comes from the card's own tool and travels on the panel, so the one
 * component draws a reply's "Don't send" and a move's "Don't move" without holding a list of tools.
 */
const confirmView = (decline: string) => ({
  approvalId: "00000000-0000-7000-8000-000000000124",
  summary: "Move Noah to Van 3 on the afternoon plan and save it.",
  note: null,
  decline,
  impact: [] as string[],
});

const render = (panel: PanelView) => renderToStaticMarkup(createElement(AgentPanel, { panel }));

describe("the panel's Don't button", () => {
  it("carries the card's own verb for a change", () => {
    const panel = confirmPanel(confirmView("Don't move"));
    expect(panel.decline).toBe("Don't move");
    const html = render(panel);
    expect(html).toContain("Don&#x27;t move");
    // The bare word, as its own label, is gone.
    expect(html).not.toMatch(/>Don&#x27;t<\//);
  });

  it("says Don't send on a reply, which is the same rule", () => {
    const panel = replyPanel(
      {
        approvalId: "00000000-0000-7000-8000-000000000125",
        parentFirstName: "Dara",
        adultName: "Dara O.",
        draftText: "We can do 5pm.",
        replyText: "We can do 5pm.",
        changeLine: null,
        lines: [],
      } as never,
      "/family-texts?tab=for-you&thread=c2",
    );
    expect(panel.decline).toBe(approval.dontSend);
    expect(render(panel)).toContain("Don&#x27;t send");
  });

  it("names a tool it does not know rather than falling back to nothing", () => {
    expect(render(confirmPanel(confirmView(confirmCopy.dont.generic)))).toContain("Don&#x27;t make the change");
  });
});
