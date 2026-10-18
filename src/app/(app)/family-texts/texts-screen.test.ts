/**
 * THE REBUILT FAMILY TEXTS SCREEN, rendered.
 *
 * `renderToStaticMarkup` over the real components, with the real view model over the real demo
 * day — no browser, no database, no model. What it holds down is the set of rules a screen that
 * quotes parents and sends on their behalf has to keep, each of them one of Firia's gates:
 *
 *  - **gate 3** no model- or system-written free text reaches a parent without approval: the
 *    thread's outgoing bubbles are either templated follow-ups or the drafted reply inside a card
 *    that has an Approve on it, and the compose bar's Send *is* that approval;
 *  - **gate 4** "Auto · Delivered" appears on templated follow-ups and nowhere else;
 *  - **gate 5** with no model reachable, no proposal card renders and the "needs a person" alert
 *    is what the "For you" tab shows instead;
 *  - **gate 6** no provider name and no raw status or enum in any bubble or any visible text;
 *  - **gate 8**, the courtesy half: the front desk is shown no "For you" tab. (The guard half —
 *    the server refusing them — is `front-desk-cannot-approve.test.ts`, because a hidden control
 *    is not a guard.)
 *
 * It also holds the structure Vera's audit asked for: two panes at the desktop width with the
 * card inside the thread, the list and the thread as two views on the phone, one title and **no**
 * explanatory sentence under it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { demoChangeRequests } from "@/modules/demo/change-request";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
import type { AssistantAlert } from "@/modules/agent/staff-alert";
import { approval, assistantUnavailable, familyTexts } from "@/ui/copy";
import type { ThreadContext } from "@/app/(app)/family-texts/context";
import { TextsScreen } from "./TextsScreen";
import {
  conversationRows,
  proposalFromDemo,
  runsOf,
  threadView,
  type ProposalView,
  type TabKey,
} from "./conversations";
import type { DecisionState } from "./actions";
import type { Thread } from "./thread";

const day = demoDay();
const texts = demoLateDropoffs(day);
const requests = demoChangeRequests(day);
const selected = texts[texts.length - 1];
const request = requests[0];

/** The thread as the log-free path builds it: the day's own texts, projected. */
const projected: Thread = {
  source: "scenario",
  bubbles: texts
    .filter((t) => t.childKey === selected.childKey)
    .map((t) => ({
      id: t.childKey,
      direction: "OUT" as const,
      author: "AUTO" as const,
      timeLabel: "3:52 PM",
      body: t.body,
      delivery: null,
      reachedPhone: true,
    })),
};

/** The action is never called in a static render; it is here to satisfy the prop. */
const decide = async (): Promise<DecisionState> => ({ status: "idle" });

function render(a: {
  tab?: TabKey;
  assistantReachable?: boolean;
  alerts?: readonly AssistantAlert[];
  showForYouTab?: boolean;
  threadOpen?: boolean;
  proposals?: readonly ProposalView[];
  /** The third pane (approvals.html `aside.ctx`), when a case is about it. */
  context?: ThreadContext | null;
  /** The Edit state, which is the only state with a time field on the card. */
  editing?: boolean;
  request?: typeof request | undefined;
}): string {
  const reachable = a.assistantReachable ?? true;
  const mayApprove = a.showForYouTab ?? true;
  const asked = "request" in a ? a.request : request;
  return renderToStaticMarkup(
    createElement(TextsScreen, {
      tab: a.tab ?? "all",
      rows: conversationRows(texts, asked ? requests : []),
      thread: threadView({
        selected,
        thread: projected,
        request: asked,
        day,
        assistantReachable: reachable,
        mayApprove,
      }),
      proposals: a.proposals ?? (mayApprove ? [proposalFromDemo(request)] : []),
      alerts: a.alerts ?? [],
      alertsUnreadable: false,
      assistantReachable: reachable,
      // The third pane is the page's read of the day; these cases are about the other two.
      context: a.context ?? null,
      editing: a.editing ?? false,
      editedTime: null,
      threadOpen: a.threadOpen ?? false,
      decide,
      showForYouTab: mayApprove,
    }),
  );
}

/**
 * The words a person reads: markup stripped and the entities React escapes decoded again.
 *
 * Without the decode an apostrophe is the thing that breaks these assertions rather than the
 * screen — "Your child's van" is `child&#x27;s` in the markup — and a test that can only assert
 * on sentences with no punctuation in them is not asserting on the copy.
 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/** One alert, shaped as `openAssistantAlerts` returns one. */
const ALERT: AssistantAlert = {
  id: "alert-1",
  state: "OPEN",
  sentence: "Dara O. texted about Noah's drop-off. The assistant couldn't read it. Reply yourself.",
  theirWords: "Can you drop Noah at 5 instead?",
  threadId: "thread-1",
  messageId: "message-1",
  beingHandled: false,
};

describe("the screen's shape", () => {
  it("draws no title of its own, and no sentence under the frame's", () => {
    const html = render({});
    /*
     * Since #74 the title is the frame's: one 64 px page header bar above every screen, with the
     * h1 in it and the words read from the access table (src/ui/PageHeader.tsx,
     * src/ui/page-title.ts). So this screen's body adds no heading at all — a second one would
     * be two titles on one page, which is what the browser check caught.
     */
    expect(html.match(/<h1/g) ?? []).toHaveLength(0);
    // The placeholder's helper line and its bare "For you" link are both gone (Vera 3.5, item 1).
    expect(html).not.toContain(familyTexts.intro);
    expect(html).not.toContain("Every text this day sent to a family");
  });

  it("renders both panes, with the thread beside the list", () => {
    const html = textOf(render({}));
    // The list carries a row per family the day texted, each with the adult, the child and a time.
    for (const row of conversationRows(texts, requests)) {
      expect(html).toContain(row.adultName);
      expect(html).toContain(row.childFirstName);
      expect(html).toContain(row.initials);
    }
    // And the thread pane is there, with the family's own words in it.
    expect(html).toContain(request.parentText);
  });

  it("marks which pane the phone is on from the URL, not from a script", () => {
    expect(render({ threadOpen: false })).toContain('data-view="list"');
    expect(render({ threadOpen: true })).toContain('data-view="thread"');
    // The back link is markup at both widths; CSS shows it only on the phone.
    expect(render({ threadOpen: true })).toContain(familyTexts.backToList);
  });

  it("puts the approve card inside the thread", () => {
    /*
     * On the markup rather than the text, because the compose bar's Send is an icon with its
     * name read and not drawn (family-texts.html `.cmp .send`: a 36 px teal disc with
     * `aria-label="Send"`). Its position in the document is what this is about either way.
     */
    const html = render({});
    const thread = html.indexOf(request.parentText);
    const card = html.indexOf(approval.changeDropoff);
    const compose = html.indexOf(`aria-label="${familyTexts.composeAction}"`);
    expect(thread).toBeGreaterThan(-1);
    expect(compose).toBeGreaterThan(-1);
    // The card is after the bubbles and before the compose bar: inside the thread, not beside it.
    expect(card).toBeGreaterThan(thread);
    expect(compose).toBeGreaterThan(card);
  });

  it("has exactly one compose bar", () => {
    const html = render({});
    // The bar itself, by its own class: one per screen (Vera 3.5 — "**One** compose bar").
    expect(html.match(/class="[^"]*_compose_[^"]*"/g) ?? []).toHaveLength(1);
  });
});

describe("gate 4: Auto · Delivered is earned", () => {
  it("labels a templated follow-up and nothing else", () => {
    const runs = runsOf(
      [
        { id: "a", direction: "OUT", author: "AUTO", timeLabel: "3:52 PM", body: "x", delivery: null, reachedPhone: true },
        { id: "b", direction: "IN", author: "PARENT", timeLabel: "3:58 PM", body: "y", delivery: null, reachedPhone: true },
        { id: "c", direction: "OUT", author: "STAFF", timeLabel: "4:10 PM", body: "z", delivery: null, reachedPhone: true },
      ],
      day.label,
    );
    expect(runs.map((r) => r.meta)).toEqual([familyTexts.autoDelivered, null, null]);
  });

  it("puts that label on the day's own text in the rendered thread, once", () => {
    const html = textOf(render({}));
    expect(html.split(familyTexts.autoDelivered).length - 1).toBe(1);
  });

  it("never labels the approved reply as auto", () => {
    const html = textOf(render({}));
    const draft = html.indexOf(request.draftText);
    const auto = html.indexOf(familyTexts.autoDelivered);
    expect(draft).toBeGreaterThan(-1);
    // The auto label is above the parent's reply; the drafted text is below it, in the card.
    expect(auto).toBeLessThan(draft);
  });
});

describe("gate 3: nothing model-written reaches a parent unapproved", () => {
  it("shows the drafted reply only inside a card that has an Approve on it", () => {
    const html = textOf(render({}));
    expect(html).toContain(request.draftText);
    expect(html).toContain(approval.approveAndSend);
    expect(html).toContain(approval.dontSend);
    // And the card says the family has heard nothing yet.
    expect(html).toContain(approval.nothingUntilApproved);
  });

  it("offers no way to type free text to a family", () => {
    const html = render({});
    // The compose field is read-only: it shows the words Send would approve, and takes none.
    expect(html).toMatch(/id="compose"[^>]*readonly/i);
  });

  it("says so plainly when there is nothing for Send to approve", () => {
    const html = textOf(render({ request: undefined, proposals: [] }));
    expect(html).toContain(familyTexts.composeNoProposal);
    expect(html).not.toContain(approval.changeDropoff);
  });
});

describe("gate 5: no model, no card", () => {
  it("renders no proposal card at all and shows the needs-a-person alert instead", () => {
    const html = textOf(render({ tab: "for-you", assistantReachable: false, alerts: [ALERT] }));
    expect(html).not.toContain(approval.changeDropoff);
    expect(html).not.toContain(approval.approveAndSend);
    expect(html).toContain(assistantUnavailable.heading);
    expect(html).toContain(ALERT.sentence);
    expect(html).toContain(ALERT.theirWords);
    // The rule, on screen rather than only in a commit message.
    expect(html).toContain(assistantUnavailable.rule);
  });

  it("drops the card out of the thread too, not only out of the tab", () => {
    const html = textOf(render({ assistantReachable: false }));
    expect(html).not.toContain(approval.changeDropoff);
    // The texts that went out still show: they did go out.
    expect(html).toContain(familyTexts.autoDelivered);
  });

  it("keeps the alert at the top of the For you tab, above every card", () => {
    const html = textOf(render({ tab: "for-you", alerts: [ALERT] }));
    expect(html.indexOf(assistantUnavailable.heading)).toBeLessThan(html.indexOf(approval.changeDropoff));
  });
});

describe("gate 6: no provider name and no raw state anywhere on the screen", () => {
  const BANNED = [
    /\bTwilio\b/i,
    /\bOpenRouter\b/i,
    /\bQUEUED\b/,
    /\bDELIVERED\b/,
    /\bASSISTANT_UNAVAILABLE\b/,
    /\bDROPOFF_CHANGE\b/,
    /\bAPPROVED\b(?![^<]*value=)/,
    /\bFRONT_DESK\b/,
  ];

  it("says none of them, in any state of the screen", () => {
    for (const html of [
      render({}),
      render({ tab: "for-you" }),
      render({ tab: "for-you", assistantReachable: false, alerts: [ALERT] }),
    ]) {
      const text = textOf(html);
      for (const pattern of BANNED) {
        expect(text, pattern.source).not.toMatch(pattern);
      }
    }
  });
});

describe("gate 8, the courtesy half: the front desk sees no For you tab", () => {
  it("renders the tab for a role that may approve", () => {
    expect(render({ showForYouTab: true })).toContain(familyTexts.tabForYou);
  });

  it("renders no tab, and no card, for a role that may not", () => {
    const html = textOf(render({ showForYouTab: false, proposals: [] }));
    expect(html).not.toContain(familyTexts.tabForYou);
    expect(html).not.toContain(approval.approveAndSend);
  });

  it("falls back to the whole list when that role asks for the tab by URL", () => {
    // `?tab=for-you` with no right to it renders the list, never the queue.
    const html = textOf(render({ tab: "for-you", showForYouTab: false, proposals: [] }));
    expect(html).not.toContain(approval.changeDropoff);
    expect(html).toContain(conversationRows(texts, requests)[0].adultName);
  });
});
