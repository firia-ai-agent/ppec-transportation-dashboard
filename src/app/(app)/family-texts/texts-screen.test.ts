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
import { beforeAll, describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { formatClock } from "@/domain/eta/eta";
import { demoChangeRequests } from "@/modules/demo/change-request";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
import type { AssistantAlert } from "@/modules/agent/staff-alert";
import { SEND_FOOTER } from "@/modules/messaging/templates";
import { approval, assistantUnavailable, familyTexts, fill } from "@/ui/copy";
import type { ThreadContext } from "@/app/(app)/family-texts/context";
import { childTokenOf, stopByKey, childByKey } from "@/modules/demo/fixtures/standard";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { DROPOFF_REPLY_TEMPLATE } from "@/modules/approvals/dropoff-change";
import type { Exec } from "@/db/exec";
import { TextsScreen } from "./TextsScreen";
import { approvalQueue } from "./queue";
import {
  conversationRows,
  openThreadOf,
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
      atMs: t.atMs,
      body: t.body,
      delivery: null,
      reachedPhone: true,
    })),
};

/**
 * The same thread once the family has answered: their text is a message row like any other, read
 * back by the thread reader — never a bubble the screen appends from a fixture.
 */
const answered: Thread = {
  ...projected,
  bubbles: [
    ...projected.bubbles,
    {
      id: "inbound-1",
      direction: "IN" as const,
      author: "PARENT" as const,
      timeLabel: "4:01 PM",
      atMs: selected.atMs + 9 * 60_000,
      body: request.parentText,
      delivery: null,
      reachedPhone: true,
    },
  ],
};

const SITE = "00000000-0000-7000-8000-0000000000a1";

/**
 * THE CARD UNDER TEST COMES FROM A ROW, not from a fixture (Firia's S1-2, 11:00 PM ET).
 *
 * One `ops.approval_request` row in the exact shape the demo seed writes
 * (src/modules/demo/approval-seed.ts) and the agent's own writer writes
 * (agent/run/exec/proposals.ts `dropoffChange`), handed to the **real** `approvalQueue` over a
 * stub `Exec`. So what this file renders is the production mapping from a row to a card — the
 * ticks included, which are computed rather than returned — and a change to that mapping shows up
 * here rather than passing because the test built its own view object.
 */
const SEEDED_ROW = {
  id: request.approvalId,
  site_id: SITE,
  decided_at: null,
  created_at: new Date(request.draftedAtMs),
  display_name: request.childLabel,
  proposal: {
    kind: DROPOFF_CHANGE_KIND,
    leg_id: "00000000-0000-7000-8000-0000000000f1",
    child_token: childTokenOf(request.childKey),
    service_date: day.iso,
    direction: "PM",
    plan_run_version_basis: 0,
    requested_dropoff_time: request.requestedHhmm,
    stop_token: stopByKey(childByKey(request.childKey)!.stopKey!).smsToken,
    rationale_code: "PARENT_REQUEST",
    template_id: request.templateId,
    vars: request.vars,
  },
};

/** `pendingApprovals`'s query, answered with the one row above and nothing else. */
const oneRow: Exec = { query: async () => ({ rows: [SEEDED_ROW] as never[] }) };

/**
 * THE SAME ROW WITH A MODEL-WRITTEN REPLY ON IT (PPE-97) — `dropoff.reply`, whose body is
 * `"PPEC: {replyText}"` and whose one var is the sentence itself.
 *
 * The row above carries the fixed-copy template, which is what the log-free demo projection
 * builds; this is what the agent's own writer and the demo seed write
 * (`agent/run/exec/proposals.ts`, `demo/approval-seed.ts`), and it is the only flavour with an
 * editable reply on it. Both are rendered below, because "which cards offer the field" is half of
 * what the ruling settles.
 */
const DRAFTED_REPLY = "Hi Dara, yes, we'll drop Noah off at 5 today. Thanks for letting us know!";
const REPLY_ROW = {
  ...SEEDED_ROW,
  proposal: {
    ...SEEDED_ROW.proposal,
    template_id: DROPOFF_REPLY_TEMPLATE,
    reply_text: DRAFTED_REPLY,
    vars: { ...SEEDED_ROW.proposal.vars, replyText: DRAFTED_REPLY },
  },
};
const replyRow: Exec = { query: async () => ({ rows: [REPLY_ROW] as never[] }) };

let PROPOSAL: ProposalView;
let REPLY_PROPOSAL: ProposalView;
beforeAll(async () => {
  PROPOSAL = (await approvalQueue({ db: oneRow, siteIds: [SITE], day, editedTime: null }))[0];
  REPLY_PROPOSAL = (await approvalQueue({ db: replyRow, siteIds: [SITE], day, editedTime: null }))[0];
});

/** The action is never called in a static render; it is here to satisfy the prop. */
const decide = async (): Promise<DecisionState> => ({ status: "idle" });
/**
 * The take-alert POST, as a prop. A render never calls it — which is the point of S1-4 and is
 * asserted in `alert-taken-on-post.test.ts`; here it is just the shape the screen needs.
 */
const takeAlertSpy = async () => {};

function render(a: {
  tab?: TabKey;
  assistantReachable?: boolean;
  alerts?: readonly AssistantAlert[];
  showForYouTab?: boolean;
  threadOpen?: boolean;
  proposals?: readonly ProposalView[];
  /** The third pane (approvals.html `aside.ctx`), when a case is about it. */
  context?: ThreadContext | null;
  /** The Edit state, which is the only state with a field on the card. */
  editing?: boolean;
  /** Which card: the fixed-copy row by default, or the model-written reply (PPE-97). */
  proposal?: ProposalView;
  request?: typeof request | undefined;
}): string {
  const reachable = a.assistantReachable ?? true;
  const mayApprove = a.showForYouTab ?? true;
  const asked = "request" in a ? a.request : request;
  const card = a.proposal ?? PROPOSAL;
  /*
   * ONE READ, as the page makes it (#B5): the rows preview the threads the pane renders, so a row
   * and the conversation beside it cannot be two different answers about what was last said.
   */
  const open = asked ? answered : projected;
  const threads = new Map([[selected.childKey, open]]);
  return renderToStaticMarkup(
    createElement(TextsScreen, {
      tab: a.tab ?? "all",
      rows: conversationRows(texts, asked && mayApprove ? [card] : [], threads),
      thread: threadView({
        selected,
        thread: open,
        // The card in the thread is the queue's own row, matched on the thread it belongs to —
        // which is the whole of "the badge and the card come from the same rows" (S1-2).
        proposal: asked && mayApprove ? card : null,
        day,
        assistantReachable: reachable,
        mayApprove,
      }),
      proposals: a.proposals ?? (mayApprove && asked ? [card] : []),
      alerts: a.alerts ?? [],
      alertsUnreadable: false,
      assistantReachable: reachable,
      // The third pane is the page's read of the day; these cases are about the other two.
      context: a.context ?? null,
      editing: a.editing ?? false,
      editedTime: null,
      threadOpen: a.threadOpen ?? false,
      decide,
      takeAlert: takeAlertSpy,
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
  // The words the module builds for this row (`agent/staff-alert.ts` `toAlert`): one line, from
  // the rows alone.
  sentence: fill(assistantUnavailable.card, {
    adult: "Dara O.",
    child: "Noah",
    leg: assistantUnavailable.legWord.PM,
  }),
  adultName: "Dara O.",
  theirWords: "Can you drop Noah at 5 instead?",
  threadId: "thread-1",
  /** Noah's own token, so the tab can open *this* family's thread (`openThreadOf`). */
  childToken: childTokenOf("C2"),
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
    for (const row of conversationRows(texts, [PROPOSAL])) {
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
    /*
     * The card, by its own accessible name: on the markup, "Approve & send" is `&amp;`, and the
     * card has no heading of its own to look for any more (Vera, 7:51 AM ET) — it is the
     * parent's name, the message as a bubble, and the three buttons.
     */
    const card = html.indexOf(
      `aria-label="${fill(approval.cardLabel, { adult: conversationRows(texts, [PROPOSAL])[0].adultName })}"`,
    );
    const compose = html.indexOf(`aria-label="${familyTexts.composeAction}"`);
    expect(thread).toBeGreaterThan(-1);
    expect(compose).toBeGreaterThan(-1);
    // The card is after the bubbles and before the compose bar: inside the thread, not beside it.
    expect(card).toBeGreaterThan(thread);
    expect(compose).toBeGreaterThan(card);
  });

  /**
   * THE STOP/HELP FOOTER IS NEVER ON A STAFF SCREEN (Firia, 2026-10-17 10:51 PM ET, which
   * supersedes the 11:00 PM "muted line under the draft" wording).
   *
   * `SEND_FOOTER` (src/modules/messaging/templates.ts:57) is appended by `renderForSend` at send
   * time and by nothing else, so the sentence exists on a family's phone and nowhere a person
   * reads: not in a bubble, not under the draft, not anywhere on the card. The assertion is on
   * the whole screen rather than on the card alone, because "not on the card" would pass while
   * the same line sat in a bubble two inches above it.
   */
  it("shows the 10DLC footer nowhere a person reads — not in a bubble, not on the card", () => {
    for (const html of [render({}), render({ tab: "for-you" }), render({ editing: true })]) {
      expect(textOf(html)).not.toContain(SEND_FOOTER);
      // And not the label that used to introduce it either: the line is gone, not relabelled.
      expect(textOf(html)).not.toContain("Added when it sends");
    }
    // The message itself is still on the card — in its bubble, which has no heading over it any
    // more (Vera, 7:51 AM ET) — so the absence above is about the footer alone.
    expect(textOf(render({}))).toContain(approval.approveAndSend);
  });

  it("has exactly one compose bar", () => {
    const html = render({});
    // The bar itself, by its own class: one per screen (Vera 3.5 — "**One** compose bar").
    expect(html.match(/class="[^"]*_compose_[^"]*"/g) ?? []).toHaveLength(1);
  });
});

/* ───────────────── PPE-97: the whole draft reply is editable, and Approve sends it ───────────────── */

/**
 * The founder's ruling of 2026-10-18, on the card in mockups/family-texts.html (and on the same
 * card as it is drawn inside mockups/agent-bubble.html): **the coordinator can edit the whole
 * draft reply text, and Approve sends exactly the edited text.**
 *
 * This is the screen's half of it. The rules the ruling puts on the *decision* — the same safety
 * refusals and the 320-character cap, server-side, inside the Approvals decision function — are
 * `modules/approvals/edited-reply.test.ts`, over rows. What has to be true of the markup is
 * narrower and just as load-bearing:
 *
 *  - the field holds the **whole reply**, prefilled with the sentence a person would rewrite;
 *  - it is **inside the form that approves**, because "the edit + Approve press is the approval"
 *    is a fact about which form the textarea is in and nothing else;
 *  - the **plan line** beside it is still built from the proposal;
 *  - and there is still no second Approve on screen that would send the draft instead.
 */
describe("PPE-97: the draft reply is a field, and the press that approves carries it", () => {
  /** The card's own markup, sliced out of the screen so a `<form>` can be read whole. */
  function cardOf(html: string): string {
    const start = html.indexOf('aria-label="Proposed reply');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("puts the whole drafted sentence in the field, without the template's own prefix", () => {
    const html = render({ editing: true, proposal: REPLY_PROPOSAL });
    expect(html).toContain('name="replyText"');
    // Prefilled with the sentence. NOT with "PPEC: …", which `messaging/reply-text.ts` refuses —
    // a box holding the rendered body would hand back a refusal nobody earned.
    expect(textOf(html)).toContain(DRAFTED_REPLY);
    expect(html).not.toMatch(/<textarea[^>]*>PPEC:/);
    expect(textOf(html)).toContain(approval.editTextLabel);
  });

  it("has that field inside the form that approves — one press, one approval", () => {
    const card = cardOf(render({ editing: true, proposal: REPLY_PROPOSAL }));
    const forms = card.match(/<form[\s\S]*?<\/form>/g) ?? [];
    const withField = forms.filter((f) => f.includes('name="replyText"'));
    expect(withField).toHaveLength(1);
    /*
     * The one form holding the words is the one holding the decision: the hidden approval id, the
     * Approve button and the Don't send button. So the typed sentence is submitted by the button
     * that decides — there is no save-the-draft press in between and nothing is stored between
     * the two.
     */
    expect(withField[0]).toContain('value="APPROVED"');
    expect(withField[0]).toContain('value="DECLINED"');
    expect(withField[0]).toContain('name="approval"');
    // And it is a POST to the action, never the GET the time field uses.
    expect(withField[0]).not.toMatch(/method="get"/);
  });

  it("offers no field on a card whose words are the centre's fixed copy", () => {
    // `dropoff.changed` has no prose var: its body is copy, not a draft (`decide.editableReply`).
    expect(PROPOSAL.draftReplyText).toBeNull();
    const html = render({ editing: true });
    expect(html).not.toContain('name="replyText"');
    // The time field is still there: that card is editable in the one way it always was.
    expect(textOf(html)).toContain(approval.editTimeLabel);
  });

  it("shows no field at all until Edit is pressed", () => {
    const html = render({ proposal: REPLY_PROPOSAL });
    expect(html).not.toContain('name="replyText"');
    expect(html).toContain(approval.edit);
  });

  it("keeps the plan line beside it, built from the proposal and not from the draft", () => {
    const html = textOf(render({ editing: true, proposal: REPLY_PROPOSAL }));
    // The same line the card carries in every other state, off the proposal's own time and the
    // placement the plan holds (`queue.ts`). Rewriting the sentence changes nothing about it.
    expect(REPLY_PROPOSAL.changeLine).not.toBe("");
    expect(html).toContain(REPLY_PROPOSAL.changeLine);
  });

  it("leaves the compose bar's Send out of it, so the draft cannot go out under a rewrite", () => {
    /*
     * The bar's Send *is* an Approve of the words it shows (gate 3) and those words are the
     * agent's draft — it cannot carry what is in the card's field. While the card holds an
     * editable reply the bar is inert, so the only live Approve on the screen is the one the
     * typed words are submitted with.
     */
    const html = render({ editing: true, proposal: REPLY_PROPOSAL });
    expect(html).toMatch(/id="compose"[^>]*disabled/);
    expect(html).not.toMatch(/id="compose"[^>]*value="PPEC/);
    // Still exactly one bar, and still exactly one Approve control on the card.
    expect(html.match(/class="[^"]*_compose_[^"]*"/g) ?? []).toHaveLength(1);
    // One Approve *control*. (The inert bar still carries a hidden `decision` field, which is
    // not a control: its own Send is disabled and it has no approval id to send.)
    expect(html.match(/<button[^>]*value="APPROVED"/g) ?? []).toHaveLength(1);
  });

  it("is still the one write path: every control posts the same action", () => {
    const card = cardOf(render({ editing: true, proposal: REPLY_PROPOSAL }));
    // Two forms on the card in this state: the decision (POST, with the words) and the time
    // field's own navigation (GET). No third, and no form with an action of its own.
    const forms = card.match(/<form[^>]*>/g) ?? [];
    expect(forms).toHaveLength(2);
    expect(forms.filter((f) => f.includes('method="get"'))).toHaveLength(1);
  });
});

describe("gate 4: Auto · Delivered is earned", () => {
  it("labels a templated follow-up and nothing else", () => {
    const runs = runsOf(
      [
        { id: "a", direction: "OUT", author: "AUTO", timeLabel: "3:52 PM", atMs: 0, body: "x", delivery: null, reachedPhone: true },
        { id: "b", direction: "IN", author: "PARENT", timeLabel: "3:58 PM", atMs: 0, body: "y", delivery: null, reachedPhone: true },
        { id: "c", direction: "OUT", author: "STAFF", timeLabel: "4:10 PM", atMs: 0, body: "z", delivery: null, reachedPhone: true },
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
    // The drafted reply as the APPROVAL ROW renders it (S1-2): `bodyOf` over the row's own
    // template and vars, naming the child the way the sent text names them ("Noah O.").
    const draft = html.indexOf(PROPOSAL.draftText);
    const auto = html.indexOf(familyTexts.autoDelivered);
    expect(draft).toBeGreaterThan(-1);
    // The auto label is above the parent's reply; the drafted text is below it, in the card.
    expect(auto).toBeLessThan(draft);
  });
});

describe("gate 3: nothing model-written reaches a parent unapproved", () => {
  it("shows the drafted reply only inside a card that has an Approve on it", () => {
    const html = textOf(render({}));
    expect(html).toContain(PROPOSAL.draftText);
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

  it("adds no line under the compose bar when there is nothing for Send to approve (Vera, bdfaa8e)", () => {
    const html = textOf(render({ request: undefined, proposals: [] }));
    expect(html).not.toContain("Not connected yet");
    expect(html).not.toContain(approval.approveAndSend);
  });
});

describe("gate 5: no model, no card", () => {
  it("renders no proposal card at all and shows the needs-a-person alert instead", () => {
    const html = textOf(render({ tab: "for-you", assistantReachable: false, alerts: [ALERT] }));
    expect(html).not.toContain(approval.approveAndSend);
    expect(html).toContain(assistantUnavailable.heading);
    expect(html).toContain(ALERT.sentence);
    expect(html).toContain(ALERT.theirWords);
  });

  /**
   * THE CARD IS ONE LINE AND ONE CONTROL (founder, 2026-10-18, on the production screenshot).
   *
   * It carried three sentences — two of which the heading and the button already said — and a
   * fourth about the build itself ("When the assistant can't reach its model… It never guesses"),
   * under a card about a family who is waiting.
   */
  it("says who texted and about which ride, in one line, and offers to answer them", () => {
    const html = textOf(render({ tab: "for-you", assistantReachable: false, alerts: [ALERT] }));

    // One line, built from the rows: the adult, the child, the ride. And nothing about what they
    // asked for — nothing read the message, which is why this card exists at all.
    expect(html).toContain("Dara O. texted about Noah's drop-off.");
    expect(html).not.toContain("The assistant couldn't read it");
    expect(html).not.toContain("It never guesses");
    expect(html).not.toContain("Reply yourself");

    // Their own words are still there, verbatim: they are what says "at 5".
    expect(html).toContain(ALERT.theirWords);

    // And one control, named for what pressing it does.
    expect(html).toContain(fill(assistantUnavailable.reply, { adult: ALERT.adultName }));
    expect(html).not.toContain(assistantUnavailable.take);
  });

  it("carries the thread the alert is about, so one press takes the alert and opens it", () => {
    const html = render({ tab: "for-you", assistantReachable: false, alerts: [ALERT] });
    // A POST, never a link: a render — or a prefetch — must not claim an alert (S1-4).
    expect(html).toMatch(/name="alert" value="alert-1"/);
    expect(html).toMatch(/name="thread" value="C2"/);
  });

  it("offers the claim alone when today's list has no thread for that family", () => {
    const html = textOf(
      render({
        tab: "for-you",
        assistantReachable: false,
        alerts: [{ ...ALERT, childToken: null }],
      }),
    );
    expect(html).toContain(assistantUnavailable.take);
    expect(html).not.toContain(fill(assistantUnavailable.reply, { adult: ALERT.adultName }));
  });

  it("drops the card out of the thread too, not only out of the tab", () => {
    const html = textOf(render({ assistantReachable: false }));
    expect(html).not.toContain(approval.approveAndSend);
    // The texts that went out still show: they did go out.
    expect(html).toContain(familyTexts.autoDelivered);
  });

  it("keeps the alert at the top of the For you tab, above every card", () => {
    const html = textOf(render({ tab: "for-you", alerts: [ALERT] }));
    expect(html.indexOf(assistantUnavailable.heading)).toBeLessThan(html.indexOf(approval.approveAndSend));
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
    expect(html).not.toContain(approval.approveAndSend);
    expect(html).toContain(conversationRows(texts, [PROPOSAL])[0].adultName);
  });
});

/* ───────────────────── which thread the screen opens on (mockups/family-texts.html) ───────────────────── */

/**
 * The thread pane shows one conversation, and the mockup draws it beside whatever the tab is
 * asking a person to deal with (/workspace/ppec-redesign/mockups/family-texts.html, and
 * approvals.html where `.th.on` is the family with something waiting).
 *
 * On production this went wrong in the one state that matters: the For you tab had a "needs a
 * person" alert about Dara at the top of it, and the pane beside it was open on Rosa — the newest
 * thread — so the screen was asking about one family and showing another.
 */
describe("the thread the tab opens on", () => {
  /** The alert carries the child's own token; the day's threads are keyed by the fixture child. */
  const alertAbout = (childKey: string) => [{ childToken: childTokenOf(childKey) }];
  const noon = texts[texts.length - 1];

  it("opens the thread the URL names, whatever else is waiting", () => {
    const asked = texts[0];
    const open = openThreadOf(texts, {
      askedThread: asked.childKey,
      proposals: [PROPOSAL],
      alerts: alertAbout(noon.childKey),
    });
    expect(open?.childKey).toBe(asked.childKey);
  });

  it("opens the thread an alert is about rather than the newest one", () => {
    const alerted = texts.find((t) => t.childKey !== texts[0].childKey)!;
    const open = openThreadOf(texts, { proposals: [], alerts: alertAbout(alerted.childKey) });

    expect(open?.childKey).toBe(alerted.childKey);
    expect(open?.childKey).not.toBe(texts[0].childKey);
  });

  it("still opens a thread with a decision waiting on it first: the card lives inside it", () => {
    const alerted = texts.find((t) => t.childKey !== PROPOSAL.threadKey)!;
    const open = openThreadOf(texts, { proposals: [PROPOSAL], alerts: alertAbout(alerted.childKey) });
    expect(open?.childKey).toBe(PROPOSAL.threadKey);
  });

  it("falls back to the newest thread when nothing is waiting and nothing is alerting", () => {
    expect(openThreadOf(texts, { proposals: [], alerts: [] })?.childKey).toBe(texts[0].childKey);
    // An alert about a child this day has no thread for changes nothing, and names nobody wrongly.
    expect(openThreadOf(texts, { proposals: [], alerts: [{ childToken: null }] })?.childKey).toBe(
      texts[0].childKey,
    );
  });

  it("has no thread to open on a day with no family texts at all", () => {
    expect(openThreadOf([], { proposals: [], alerts: alertAbout("C2") })).toBeNull();
  });
});

/* ──────────── the list and the thread read one source (mockups/family-texts.html) ──────────── */

/**
 * The mockup's list row is a preview *of the conversation beside it* — the same message, the same
 * time (/workspace/ppec-redesign/mockups/family-texts.html `.th .pv`). On production they were two
 * different reads: the row previewed the demo day's projected text ("PPEC: Noah's van home is
 * running about 10 minutes late", 4:08 PM) while the pane rendered the message log, whose only
 * message on that thread was Dara's own, at 12:57. One screen, two sources, two answers about what
 * was last said to a family.
 */
describe("a row previews the thread it opens", () => {
  const newest = answered.bubbles[answered.bubbles.length - 1];
  const threads = new Map([[selected.childKey, answered]]);

  it("shows that thread's newest message, and its time", () => {
    const [row] = conversationRows([selected], [], threads);

    expect(row.preview).toBe(newest.body);
    expect(row.timeLabel).toBe(formatClock(newest.atMs));
    // Which is **not** the day's own projected text, the thing it used to show over this thread.
    expect(row.preview).not.toBe(selected.body);
  });

  it("falls back to the day's own text when there is no thread to read", () => {
    // A deployment that has not run the day yet, or a laptop with no database: the row and the
    // pane are both the projection, which is still one source.
    const [row] = conversationRows([selected], []);
    expect(row.preview).toBe(selected.body);
    expect(row.timeLabel).toBe(formatClock(selected.atMs));
  });

  it("still previews the model's line where a proposal is waiting on that thread", () => {
    // The one case the newest message does not win: a decision is waiting, and what the row has
    // to say is what it is about (`agent/alert-words.ts` writes this line onto the row).
    const waiting = texts.find((t) => t.childKey === PROPOSAL.threadKey)!;
    const asked = { ...PROPOSAL, alertText: "Dara asked to move Noah's drop-off to 5." };
    const [row] = conversationRows([waiting], [asked], new Map([[waiting.childKey, answered]]));

    expect(row.preview).toBe(asked.alertText);
    // …and a row whose proposal carries no line falls back to the thread, not to a blank preview.
    const [plain] = conversationRows([waiting], [PROPOSAL], new Map([[waiting.childKey, answered]]));
    expect(plain.preview).toBe(newest.body);
  });
});
