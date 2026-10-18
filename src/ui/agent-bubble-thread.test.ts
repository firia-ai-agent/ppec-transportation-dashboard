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
import { agentBubble, fill } from "./copy";
import { FAMILY_TEXTS_FOR_YOU } from "@/auth/access";

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
  it("is the question as the title, then Approve · Edit · Skip in one row", () => {
    const html = thread([PROPOSAL]);
    expect(html).toContain("data-agent-proposal");
    expect(html).toContain(PROPOSAL.kind === "proposal" ? PROPOSAL.question : "");
    expect(html).toContain(agentBubble.approve);
    expect(html).toContain(agentBubble.edit);
    expect(html).toContain(agentBubble.skip);
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

  /**
   * NOTHING AUTO-APPLIES, and on this branch nothing can: there is no decide write path on main
   * (it is being rebuilt on #75), so the three actions are links to the one place a decision is
   * made and recorded — Family texts → For you, which carries its own server guard. The bubble is
   * only drawn for somebody `canOpenForYou` allows, so this is never a door they cannot open.
   */
  it("takes a decision to For you rather than writing one from here", () => {
    const html = thread([PROPOSAL]);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([FAMILY_TEXTS_FOR_YOU, FAMILY_TEXTS_FOR_YOU, FAMILY_TEXTS_FOR_YOU]);
    // No form, no button, no action: a decision from here would be a write this branch has not got.
    expect(html).not.toMatch(/<form|<button/);
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
