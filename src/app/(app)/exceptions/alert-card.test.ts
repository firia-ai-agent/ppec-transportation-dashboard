/**
 * The alert card and the rail's count, rendered.
 *
 * The data half of the founder's 2026-10-17 rule is held down by
 * `modules/agent/model-unavailable.test.ts`; this is the half a coordinator actually looks at.
 * What it asserts, and what a deliberately broken card would fail on:
 *
 *  - the sentence reaches the screen **as the server composed it**, with the names in it;
 *  - the family's own words are on screen **verbatim**, not shortened and not summarized;
 *  - both controls are there, and both lead to this page with the alert named — so "opening it"
 *    is what marks it taken;
 *  - there is **no way to dismiss** a card: the only states are waiting and being handled;
 *  - the failure state says "we couldn't read the board", never "nothing is waiting";
 *  - the count is a **number with words**, never colour alone (§9), and it renders nothing at 0;
 *  - the front desk gets no count, because `/exceptions` is not in their row of the access table
 *    and so the rail has no destination to hang one on.
 *
 * `renderToStaticMarkup` on the real components, in the shape `src/ui/shell.test.ts` established:
 * no DOM and no browser here, so the CSS rules (the red left edge, the pill) are asserted by
 * reading the stylesheet, which proves they are written rather than that a browser applies them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assistantUnavailable, fill, nav } from "@/ui/copy";
import { navItemsFor } from "@/ui/nav-items";
import { NavBadge } from "@/ui/NavBadge";
import type { AssistantAlert } from "@/modules/agent/staff-alert";
import { AlertCards } from "./AlertCards";

const UI = path.resolve(__dirname, "..", "..", "..", "ui");

/** React escapes `'` in text nodes, so a copy string has to be escaped to be found in markup. */
const esc = (text: string) => text.replace(/'/g, "&#x27;").replace(/&(?!#x27;)/g, "&amp;");

const WORDS = "hi, can Noah be dropped off later today? we are running behind";

const alert = (over: Partial<AssistantAlert> = {}): AssistantAlert => ({
  id: "00000000-0000-7000-8000-00000000a1e1",
  state: "OPEN",
  sentence: "Dara O. texted about Noah's drop-off. The assistant couldn't read it. Reply yourself.",
  theirWords: WORDS,
  threadId: "00000000-0000-7000-8000-00000000d1d1",
  messageId: "00000000-0000-7000-8000-00000000d1d2",
  beingHandled: false,
  ...over,
});

const render = (props: Parameters<typeof AlertCards>[0]) =>
  renderToStaticMarkup(createElement(AlertCards, props));

const cards = (over: Partial<Parameters<typeof AlertCards>[0]> = {}) =>
  render({ alerts: [alert()], thread: null, showReplyNote: false, unreadable: false, ...over });

describe("the needs-a-person card", () => {
  it("prints the sentence the server composed, with the people named", () => {
    const html = cards();
    expect(html).toContain(esc(alert().sentence));
    expect(html).toContain(esc(assistantUnavailable.heading));
  });

  it("prints the family's words verbatim, under a label that says whose they are", () => {
    const html = cards();
    expect(html).toContain(esc(assistantUnavailable.theirWords));
    expect(html).toContain(esc(WORDS));
    // Not shortened: the whole sentence, to its last word.
    expect(html).toContain("running behind");
    expect(html).not.toContain("…");
  });

  it("offers Open text and Reply, both leading to this page with the alert named", () => {
    const html = cards();
    expect(html).toContain(esc(assistantUnavailable.openText));
    expect(html).toContain(esc(assistantUnavailable.reply));
    expect(html).toContain(`/exceptions?open=${alert().id}`);
    expect(html).toContain(`/exceptions?open=${alert().id}&amp;reply=1`);
  });

  it("has no way to dismiss, snooze or close a card", () => {
    const html = cards().toLowerCase();
    for (const word of ["dismiss", "snooze", "close", "ignore", "resolve"]) {
      expect(html, word).not.toContain(word);
    }
  });

  it("says it is being handled once somebody has opened it, and still shows it", () => {
    const html = cards({ alerts: [alert({ state: "IN_PROGRESS", beingHandled: true })] });
    expect(html).toContain(esc(assistantUnavailable.openedBy));
    expect(html).toContain(esc(alert().sentence));
  });

  it("shows the thread when one is open, and says there is no reply box yet", () => {
    const html = cards({
      thread: { alertId: alert().id, messages: [{ id: "m1", at: "2026-10-15T16:00:00.000Z", body: WORDS }] },
      showReplyNote: true,
    });
    expect(html).toContain(esc(assistantUnavailable.threadHeading));
    expect(html).toContain(esc(assistantUnavailable.noReplyBox));
  });

  it("an empty board says so; an unreadable board says something different", () => {
    const empty = cards({ alerts: [] });
    expect(empty).toContain(esc(assistantUnavailable.none));
    expect(empty).not.toContain(esc(assistantUnavailable.unreadable));

    // The distinction that matters: "nothing is waiting" is a claim about the families, and it
    // must not be made when the truth is "we could not read the board".
    const broken = cards({ alerts: [], unreadable: true });
    expect(broken).toContain(esc(assistantUnavailable.unreadable));
    expect(broken).not.toContain(esc(assistantUnavailable.none));
  });

  it("says the rule on screen, so it is not only in a commit message", () => {
    expect(cards()).toContain(esc(assistantUnavailable.rule));
  });

  it("carries the RED severity on the card's edge, not as a filled block", () => {
    const css = readFileSync(path.join(__dirname, "alerts.module.css"), "utf8");
    expect(css).toMatch(/border-left:\s*var\(--space-1\)\s+solid\s+var\(--color-crit-fg\)/);
  });
});

describe("the rail's count", () => {
  const badge = (count: number) => renderToStaticMarkup(createElement(NavBadge, { count }));

  it("is a number and a sentence, never colour alone (§9)", () => {
    const html = badge(3);
    expect(html).toContain(">3<");
    expect(html).toContain(esc(fill(assistantUnavailable.badgeLabel, { count: 3 })));
    expect(html).toContain("srOnly");
  });

  it("renders nothing at all when nothing is waiting", () => {
    expect(badge(0)).toBe("");
    expect(badge(-1)).toBe("");
  });

  it("uses the contrast pair the §8 table already documents for RED", () => {
    const css = readFileSync(path.join(UI, "NavBadge.module.css"), "utf8");
    expect(css).toContain("var(--color-crit-bg)");
    expect(css).toContain("var(--color-crit-fg)");
  });

  it("hangs on Exceptions & Approvals in the rail and in the drawer, and nowhere else", () => {
    for (const file of ["NavRail.tsx", "MobileNav.tsx"]) {
      const source = readFileSync(path.join(UI, file), "utf8");
      expect(source, file).toMatch(/item\.href === "\/exceptions" \? <NavBadge count=\{alertCount\} \/> : null/);
      // One mount per file: a second would be a count on another destination.
      expect([...source.matchAll(/<NavBadge\b/g)], file).toHaveLength(1);
    }
  });
});

describe("the front desk gets neither the card nor the count", () => {
  it("has no /exceptions destination in the rail, so there is nothing to hang a count on", () => {
    const hrefs = navItemsFor("FRONT_DESK").map((i) => i.href);
    expect(hrefs).not.toContain("/exceptions");
    // And the two console roles do, which is what makes the assertion above mean something.
    for (const role of ["DIRECTOR", "COORDINATOR"] as const) {
      expect(navItemsFor(role).map((i) => i.href), role).toContain("/exceptions");
      expect(navItemsFor(role).map((i) => i.label), role).toContain(nav.exceptions);
    }
  });

  it("gets no destination at all that could carry it, signed in or not", () => {
    expect(navItemsFor(null).map((i) => i.href)).not.toContain("/exceptions");
  });
});
