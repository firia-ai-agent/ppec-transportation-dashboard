import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const AT = { pathname: "/today", search: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => AT.pathname,
  useSearchParams: () => new URLSearchParams(AT.search),
}));

import { AgentBubble } from "./AgentBubble";
import { AgentThread, type AgentThreadItem } from "./AgentThread";
import { agentBubble, approval, fill } from "./copy";
import { replyPanel } from "./panel";
import { familyThreadHref } from "@/auth/access";

/**
 * THE THREAD IN THE BUBBLE, and the coral dot on the closed disc — check (c) of the lane.
 *
 * Against Vera's binding mockup:
 *   /workspace/ppec-redesign/mockups/agent-bubble.html         (`.fab .dot`, `.msgs`, `.in`, `.out`)
 *   /workspace/ppec-redesign/png/agent-bubble-closed-1440.png  (the dot on the disc)
 *   /workspace/ppec-redesign/png/agent-bubble-open-1440.png    (the thread, at 400 px)
 *   /workspace/ppec-redesign/png/agent-bubble-closed-390.png
 *   /workspace/ppec-redesign/png/agent-bubble-open-390.png
 * and, for the COMPACT proposal card,
 *   /workspace/ppec-redesign/mockups/family-texts.html         (`.prop`)
 * The full For you card (mockups/approvals.html) is deliberately *not* what this draws.
 */
const UI = __dirname;
const css = readFileSync(path.join(UI, "AgentThread.module.css"), "utf8");
const bubbleCss = readFileSync(path.join(UI, "AgentBubble.module.css"), "utf8");

function thread(items: readonly AgentThreadItem[]): string {
  return renderToStaticMarkup(createElement(AgentThread, { items }));
}

function bubble(props: Parameters<typeof AgentBubble>[0]): string {
  AT.pathname = "/today";
  AT.search = "";
  return renderToStaticMarkup(createElement(AgentBubble, props));
}

const DRIVER: AgentThreadItem = {
  kind: "driver",
  id: "m1",
  name: "Marcus L.",
  van: 1,
  text: "Running 10 min behind on Okeechobee",
};
const STAFF: AgentThreadItem = { kind: "staff", id: "m2", text: "Move Liam D. to Van 2 for the afternoon" };
const PROPOSAL: AgentThreadItem = {
  kind: "proposal",
  id: "p1",
  question: "Move Liam D. to Van 2 for the afternoon?",
};

/* ───────────── (c) the coral dot shows iff a proposal is waiting ───────────── */

describe("(c) the coral dot shows exactly when a proposal is waiting", () => {
  it("draws no dot with nothing waiting", () => {
    const html = bubble({ canDecide: true, waiting: 0 });
    expect(html).toContain("data-agent-bubble");
    expect(html).not.toContain("data-agent-waiting");
    expect(html).toContain(`aria-label="${agentBubble.open}"`);
  });

  it("draws the dot, and says the number in the button's name, with one waiting", () => {
    const html = bubble({ canDecide: true, waiting: 1 });
    expect(html).toContain("data-agent-waiting");
    expect(html).toContain(`aria-label="${fill(agentBubble.openWaiting, { count: 1 })}"`);
  });

  it("draws one dot however many are waiting, and still counts them in the name", () => {
    const html = bubble({ canDecide: true, waiting: 3 });
    expect(html.match(/data-agent-waiting/g)).toHaveLength(1);
    expect(html).toContain(`aria-label="${fill(agentBubble.openWaiting, { count: 3 })}"`);
  });

  /**
   * agent-bubble.html `.fab .dot`: 14 px, coral, with a white ring. Coral is the alert token and
   * is used for nothing else in this app (tokens.ts), and the dot is never the only cue — the
   * count is words in the button's accessible name, which is §3's rule.
   */
  it("is a 14 px coral dot with a white ring, as the mockup draws it", () => {
    const block = bubbleCss.slice(bubbleCss.indexOf(".dot {"), bubbleCss.indexOf("/*\n * OPEN at 1440"));
    expect(block).toMatch(/width: var\(--layout-agent-bubble-dot\)/);
    expect(block).toMatch(/background: var\(--color-alert\)/);
    expect(block).toMatch(/border: var\(--border-hairline\) solid var\(--color-surface\)/);
    expect(block).toMatch(/border-radius: var\(--radius-pill\)/);
  });

  it("is hidden along with the disc, because the disc is what carries it", () => {
    // agent-bubble.html: `body.open .fab{display:none}` — the dot is inside `.fab`.
    const component = readFileSync(path.join(UI, "AgentBubble.tsx"), "utf8");
    const closed = component.slice(component.indexOf("{open ? null : ("), component.indexOf("{open ? ("));
    expect(closed).toMatch(/data-agent-waiting/);
  });
});

/* ───────────────────── the thread, as the mockup draws it ───────────────────── */

describe("the thread is the one in the mockup", () => {
  it("names a driver above a grey bubble: 'Name · Van N'", () => {
    const html = thread([{ kind: "day", label: agentBubble.today }, DRIVER]);
    expect(html).toContain(fill(agentBubble.speaker, { name: "Marcus L.", van: 1 }));
    expect(html).toContain(DRIVER.kind === "driver" ? DRIVER.text : "");
    // png/agent-bubble-open-1440.png: the van is named, never printed as a code.
    expect(html).not.toMatch(/\bV\d\b/);
  });

  it("puts a staff message in a teal bubble on the right and a driver's in grey on the left", () => {
    // `.in{background:#E9E9EB}` → the system's one grey fill; `.out{background:var(--brand)}`.
    const inbound = css.slice(css.indexOf(".inbound {"), css.indexOf(".outbound {"));
    expect(inbound).toMatch(/align-self: flex-start/);
    expect(inbound).toMatch(/background: var\(--color-neutral-bg\)/);
    const outbound = css.slice(css.indexOf(".outbound {"), css.indexOf("/*\n * `.prop`"));
    expect(outbound).toMatch(/align-self: flex-end/);
    expect(outbound).toMatch(/background: var\(--color-brand\)/);
    expect(outbound).toMatch(/color: var\(--color-surface\)/);
  });

  it("shows only what it is given, and says so when that is nothing", () => {
    expect(thread([])).toContain(agentBubble.empty);
    expect(thread([STAFF])).not.toContain(agentBubble.empty);
  });

  it("renders a day separator once, above the group it belongs to", () => {
    const html = thread([{ kind: "day", label: agentBubble.today }, DRIVER, STAFF]);
    expect(html.match(new RegExp(agentBubble.today, "g"))).toHaveLength(1);
  });
});

/* ──────────── the COMPACT proposal card, not the full For you card ──────────── */

describe("a waiting proposal is the compact card from family-texts.html", () => {
  it("is the question as the title, then one amber 'Needs approval' chip", () => {
    const html = thread([PROPOSAL]);
    expect(html).toContain("data-agent-proposal");
    expect(html).toContain(PROPOSAL.kind === "proposal" ? PROPOSAL.question : "");
    expect(html).toContain(agentBubble.needsApproval);
  });

  /**
   * FIRIA, 2026-10-18 9:21 AM ET, overriding the 9:17 reading of the same chip: the chip is
   * **plain text until #75 merges** — a `<span>`, and not a link, a button or anything else that
   * can be pressed or focused.
   *
   * This is not a loosened assertion. The test it replaces asserted the chip was an anchor
   * carrying exactly one `href`, which was a *narrower* claim about the markup and a weaker one
   * about the behaviour; this asserts the words are present AND that there is no anchor, no
   * `href`, no `role="link"`, no `onClick` handler and no `tabIndex` anywhere in the thread — the
   * absence of a whole class of control rather than the presence of one particular one.
   */
  it("is plain text when there is no card behind it: no anchor, no href, no role=link, nothing focusable", () => {
    const html = thread([PROPOSAL, DRIVER, STAFF]);
    // The words are still there — the ruling is about what the words are, not whether they show.
    expect(html).toContain(agentBubble.needsApproval);
    // …and they are in a <span>, which is what renders them.
    expect(html).toMatch(new RegExp(`<span[^>]*>${agentBubble.needsApproval}</span>`));

    expect(html, "the chip is an anchor again").not.toMatch(/<a[\s>]/);
    expect(html, "the chip has a destination again").not.toMatch(/href=/);
    expect(html).not.toMatch(/role="link"/);
    expect(html).not.toMatch(/tabindex=/i);
    expect(html).not.toMatch(/<button|<form/);

    // The compact form is what a proposal with no card behind it draws (no model, a read that
    // failed); the controls belong to the real card only, below.
  });

  /**
   * FIRIA AND VERA, 2026-10-18 9:17 AM ET. The mockup's three actions are OFF the card until #75
   * merges: acting in place is a write and the writer is #75's. This is not a loosened assertion —
   * the old test asserted the three words were present and this asserts they are absent, which is
   * the stronger statement of the two, and it is checked as words *and* as controls.
   */
  it("offers no Approve, Edit or Skip on the compact form — those are the real card's", () => {
    const html = thread([PROPOSAL, DRIVER, STAFF]);
    for (const word of ["Approve", "Edit", "Skip"]) {
      expect(html, `"${word}" is still on the card`).not.toContain(word);
    }
    // Neither as a button nor as a link that merely looks like one: there is no control at all.
    expect(html).not.toMatch(/<button/);
    expect([...html.matchAll(/href="/g)]).toHaveLength(0);
  });

  /**
   * The amber is the `warn` tone of §8 — the pair the board's own hints wear — and the chip is the
   * app's ONE pill (src/ui/Pill.tsx, audit §4.1) rather than a box of its own. It can be, now that
   * it is plain text: while it was a link it had to be an anchor, so AgentThread.module.css
   * carried a second pill-shaped rule and `src/ui/pill.test.ts` had a second offender in it.
   */
  it("is the one pill, wearing the system's amber", () => {
    const html = thread([PROPOSAL]);
    // Pill.tsx's own markers, which is how every other chip in the app is found.
    expect(html).toMatch(/data-tone="warn"/);
    expect(html).toMatch(/data-pill="true"/);
    expect(html).toContain("_pill_");

    // …and this stylesheet has no pill of its own left: no second shape, no focus ring, no hex.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bare).not.toMatch(/\.chip/);
    expect(bare).not.toMatch(/--color-warn-(?:fg|bg)/);
    expect(bare).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  /**
   * mockups/approvals.html is the FULL For you card — a details table and the clock times of what
   * would change. The bubble uses the compact one, so neither may appear here.
   */
  it("carries no details table and no clock time", () => {
    const html = thread([PROPOSAL, DRIVER, STAFF]);
    expect(html).not.toMatch(/<table|<dl\b|<dt\b/);
    expect(html).not.toMatch(/\d{1,2}:\d{2}\s?(?:AM|PM)/i);
  });

  it("holds no decide writer of its own anywhere in the bubble", () => {
    const sources = ["AgentThread.tsx", "AgentBubble.tsx"].map((f) =>
      readFileSync(path.join(UI, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/approvals\/decide|decideApproval|UPDATE ops\./);
    }
  });
});

/*
 * THE REAL CARD, IN THE BUBBLE (founder, 2026-10-18: "the card shows up fully rendered in two
 * places: the bubble and Family texts. It has the draft, one line saying what changes in the plan,
 * and Approve. It's a real card, not a line of text."). #75 merged the writer the 9:17 and 9:21
 * rulings were waiting on, so when the shell hands the thread the queue's own `ProposalView`, the
 * proposal is drawn with Family texts' card component — the same draft, plan line and buttons.
 */
describe("a waiting proposal, with the panel the shell built, is the Family texts panel", () => {
  const CARD = {
    approvalId: "p1",
    threadKey: "C2",
    childLabel: "Noah O.",
    adultName: "Dara O.",
    parentFirstName: "Dara",
    changeLine: "Noah: drop-off moves to 5:00 PM on Van 2.",
    draftedLabel: "",
    stopFrom: null,
    stopTo: "Okeeheelee Park",
    timeFrom: null,
    timeTo: "5:00 PM",
    pickupLabel: "Dara O.",
    checks: [],
    draftText: "PPEC: Hi Dara, yes, we can drop Noah off at 5 today.",
    replyText: "Hi Dara, yes, we can drop Noah off at 5 today.",
    alertText: "Dara asked to move Noah's drop-off to 5 PM.",
    lines: [],
  };
  // The panel the shell builds from the same row (ledger #79): one component everywhere.
  const withCard = () =>
    renderToStaticMarkup(
      createElement(AgentThread, {
        items: [{ kind: "proposal", id: "p1", question: CARD.alertText }],
        panels: [replyPanel(CARD, familyThreadHref(CARD.threadKey))],
      }),
    );

  it("draws the draft, the plan line and Approve — the card, not a chip", () => {
    const html = withCard();
    expect(html).toContain(CARD.draftText);
    expect(html).toContain(CARD.changeLine);
    expect(html).toContain(fill(approval.replyTo, { parent: "Dara" }));
    expect(html).toContain(approval.approveAndSend.replace("&", "&amp;"));
    expect(html).not.toContain(agentBubble.needsApproval);
  });

  it("decides through the actions the shell provides, never a writer of its own", () => {
    const html = withCard();
    expect(html).toMatch(/<form/);
    // Edit opens the thread on Family texts, where the time field lives.
    expect(html).toContain("/family-texts?tab=for-you&amp;thread=C2");
  });
});

