import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The bubble is a client component: it asks `next/navigation` where it is. There is no router in
 * node, so this stands in for one. Each suite sets the two values it needs through `AT`, which
 * is how "hidden on For you" is driven without a browser.
 */
const AT = { pathname: "/today", search: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => AT.pathname,
  useSearchParams: () => new URLSearchParams(AT.search),
}));

import { AgentBubble } from "./AgentBubble";
import {
  AGENT_BUBBLE_OPEN_KEY,
  agentBubbleHidden,
  getAgentBubbleOpenOnServer,
  readAgentBubbleOpen,
  setAgentBubbleOpen,
  subscribeAgentBubbleOpen,
  writeAgentBubbleOpen,
  type OpenStore,
} from "./agent-bubble-state";
import { agentBubble, fill } from "./copy";
import { navItems } from "./nav-items";
import {
  APPROVAL_ROLES,
  FAMILY_TEXTS_FOR_YOU,
  FOR_YOU_TAB,
  PAGES,
  ROLE_LADDER,
  canOpenForYou,
} from "@/auth/access";

/**
 * THE AGENT CHAT BUBBLE, against Vera's binding mockup:
 *   /workspace/ppec-redesign/mockups/agent-bubble.html  (`#open` shows the panel)
 *   /workspace/ppec-redesign/png/agent-bubble-closed-1440.png
 *   /workspace/ppec-redesign/png/agent-bubble-open-1440.png
 *   /workspace/ppec-redesign/png/agent-bubble-closed-390.png
 *   /workspace/ppec-redesign/png/agent-bubble-open-390.png
 * and, for the compact proposal card the thread uses,
 *   /workspace/ppec-redesign/mockups/family-texts.html  (`.prop`)
 *
 * Three of the six checks the lane asks for live here — (a) it is on every app route, (b) it is
 * hidden on Family texts → For you and for anyone who may not decide, (f) its open/closed state
 * survives a navigation between tabs. The other three (the coral dot, the pending proposal, the
 * staff alert) are in agent-bubble-thread.test.ts and agent-bubble-ask.db.test.ts.
 *
 * vitest runs in node with no DOM (vitest.config.ts: `src/**\/*.test.ts`, no jsdom), so the rules
 * that live in CSS and the mount points that live in a layout are read off the source — the same
 * method as src/ui/one-menu.test.ts, and for the same reason. The browser half is
 * e2e/agent-bubble.spec.ts.
 */
const UI = __dirname;
const SRC = path.resolve(UI, "..");
const REPO = path.resolve(SRC, "..");
const APP = path.join(SRC, "app");

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf8");
}

/** A file with its comments taken out: what it *does*, rather than what it says about itself. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function render(props: Parameters<typeof AgentBubble>[0]): string {
  return renderToStaticMarkup(createElement(AgentBubble, props));
}

/* ─────────────────── (a) it is on every app route ─────────────────── */

/**
 * Every `layout.tsx` Next would apply to a page, nearest first. Copied in shape from
 * one-menu.test.ts: this is the chain that decides whether a route has chrome at all.
 */
function layoutChainOf(pageFile: string): string[] {
  const chain: string[] = [];
  let dir = path.dirname(pageFile);
  for (;;) {
    const candidate = path.join(dir, "layout.tsx");
    try {
      readFileSync(candidate, "utf8");
      chain.push(candidate);
    } catch {
      /* no layout at this level */
    }
    if (dir === APP) break;
    dir = path.dirname(dir);
  }
  return chain;
}

function pageFileOf(href: string): string {
  const row = PAGES.find((p) => p.kind === "page" && p.path === href);
  expect(row, `no row in the access table for ${href}`).toBeDefined();
  return path.join(REPO, (row as { file: string }).file);
}

describe("(a) the bubble is on every app route", () => {
  /**
   * The founder's ask is "from any screen", so this is a property and not a list of four
   * layouts: **every layout that mounts the console shell gets the bubble, because the shell is
   * the thing that mounts it.** A fifth route added next week passes without anyone remembering.
   */
  it("is mounted by ConsoleShell, which is what every app route's layout renders", () => {
    const shell = code(read(UI, "ConsoleShell.tsx"));
    expect(shell).toMatch(/<AgentBubble\s+canDecide=\{canDecide\}/);
    // …and `canDecide` is `canOpenForYou`, asked once, on the server, in this one file.
    expect(shell).toMatch(/const canDecide = canOpenForYou\(caller\);/);
  });

  it("is mounted exactly once in the whole app, so changing tab cannot close it", () => {
    const mounts = [...walkSources(UI), ...walkSources(APP)]
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => /<AgentBubble\b/.test(code(readFileSync(f, "utf8"))));
    expect(mounts.map((f) => path.relative(SRC, f))).toEqual(["ui/ConsoleShell.tsx"]);
  });

  it("reaches every destination on the menu, through that one mount", () => {
    // The five menu rows are the enumeration (src/ui/nav-items.ts), and the access table says
    // which file each one is. Nothing here lists a route by hand.
    const destinations = navItems.filter((i) => i.inMenu).map((i) => i.href);
    expect(destinations.length).toBeGreaterThanOrEqual(5);
    for (const href of destinations) {
      const mounting = layoutChainOf(pageFileOf(href)).filter((f) =>
        /<ConsoleShell\b/.test(read(f)),
      );
      expect(mounting.length, `${href} has no layout mounting the console shell`).toBe(1);
    }
  });

  it("draws the closed disc: a button with the copy's name on it and no visible label", () => {
    AT.pathname = "/today";
    AT.search = "";
    const html = render({ canDecide: true });
    expect(html).toContain(`aria-label="${agentBubble.open}"`);
    // png/agent-bubble-closed-1440.png: an icon, and no words beside it.
    expect(html).not.toContain(">Agent<");
  });

  it("opens a dialog titled Agent, and hides the disc while it is open", () => {
    // agent-bubble.html: `body.open .pnl{display:flex} body.open .fab{display:none}`.
    const component = code(read(UI, "AgentBubble.tsx"));
    expect(component).toMatch(/\{open \? null : \(/);
    expect(component).toMatch(/role="dialog"/);
    expect(component).toMatch(/aria-label=\{agentBubble\.title\}/);
  });
});

/** Every .ts/.tsx under a directory. */
function walkSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkSources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/* ───── (b) hidden on For you, and for anyone who may not decide ───── */

describe("(b) the bubble is hidden where it must not be", () => {
  /**
   * Family texts → For you *is* the bubble's thread. A floating copy of a screen on top of the
   * screen is two places to approve one thing, so the disc is not drawn there.
   */
  it("draws nothing on Family texts → For you", () => {
    AT.pathname = "/family-texts";
    AT.search = `tab=${FOR_YOU_TAB}`;
    expect(render({ canDecide: true })).toBe("");
    // …and the address it is keyed off is the one in the access table, not a second copy.
    expect(FAMILY_TEXTS_FOR_YOU).toBe(`/family-texts?tab=${FOR_YOU_TAB}`);
  });

  it("is still drawn on the other Family texts tabs", () => {
    AT.pathname = "/family-texts";
    AT.search = "";
    expect(render({ canDecide: true })).not.toBe("");
    AT.search = "tab=sent";
    expect(render({ canDecide: true })).not.toBe("");
  });

  /**
   * The bubble shows proposals waiting for a decision, so the roles that may not decide must not
   * see it at all — on the live map and the ramp iPad, which is all the front desk has. The
   * boolean comes from `canOpenForYou`, the same function the For you page guards itself with
   * (src/app/(app)/family-texts/page.tsx), so widening one widens both and neither drifts.
   *
   * This is a visibility rule on top of a server rule, never instead of one.
   */
  it("draws nothing for a role that cannot open For you, on any screen", () => {
    for (const role of ROLE_LADDER) {
      const canDecide = canOpenForYou({ kind: "STAFF", role });
      expect(canDecide, role).toBe(APPROVAL_ROLES.includes(role));
      for (const pathname of ["/today", "/plan-routes", "/live-map", "/ramp-ipad"]) {
        AT.pathname = pathname;
        AT.search = "";
        const html = render({ canDecide });
        if (canDecide) expect(html, `${role} on ${pathname}`).not.toBe("");
        else expect(html, `${role} on ${pathname}`).toBe("");
      }
    }
  });

  it("draws nothing for a caller with no role and for an anonymous one", () => {
    AT.pathname = "/today";
    AT.search = "";
    expect(canOpenForYou({ kind: "NO_ROLE", userId: "u" })).toBe(false);
    expect(canOpenForYou({ kind: "ANONYMOUS" })).toBe(false);
    expect(render({ canDecide: false })).toBe("");
  });

  it("decides both rules in one pure function, so nothing else can hold a second opinion", () => {
    expect(agentBubbleHidden({ pathname: "/today", tab: null, canDecide: true })).toBe(false);
    expect(agentBubbleHidden({ pathname: "/family-texts", tab: FOR_YOU_TAB, canDecide: true })).toBe(true);
    expect(agentBubbleHidden({ pathname: "/today", tab: null, canDecide: false })).toBe(true);
  });
});

/* ───────── (f) the state survives a navigation between tabs ───────── */

/** A `sessionStorage` stand-in: the two methods the module touches, over a Map. */
function fakeStore(): OpenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("(f) the open/closed state survives navigation between tabs", () => {
  /**
   * The primary mechanism is structural: the bubble is mounted by the shell, the shell is in the
   * persistent layout, and a client-side navigation between Today, Plan routes, Live map, Ramp
   * iPad and Family texts replaces the page *inside* it. React therefore keeps the component and
   * its `useState`, and nothing has to be persisted at all.
   */
  it("keeps its state outside the page, in the shell that does not remount", () => {
    const component = code(read(UI, "AgentBubble.tsx"));
    // One value, read as an external store — not seeded per page and not in the URL, which
    // every link on the page would rewrite.
    expect(component).toMatch(/useSyncExternalStore\(\s*subscribeAgentBubbleOpen/);
    expect(component).not.toMatch(/router\.(?:push|replace)|useState/);
    // And the mount is in ConsoleShell, which the layouts render (suite (a) above).
    expect(code(read(UI, "ConsoleShell.tsx"))).toMatch(/<AgentBubble\b/);
  });

  it("notifies its subscribers when the panel is opened or closed", () => {
    // What React re-renders on. A store nobody is told about is a panel that never reopens.
    let fired = 0;
    const unsubscribe = subscribeAgentBubbleOpen(() => void (fired += 1));
    setAgentBubbleOpen(true);
    setAgentBubbleOpen(false);
    expect(fired).toBe(2);
    unsubscribe();
    setAgentBubbleOpen(true);
    expect(fired).toBe(2);
  });

  it("renders closed on the server, whatever the browser last chose", () => {
    // The server has no session storage, and markup the browser has to take back is a flicker.
    expect(getAgentBubbleOpenOnServer()).toBe(false);
    AT.pathname = "/today";
    AT.search = "";
    expect(render({ canDecide: true })).toContain('data-state="closed"');
  });

  /**
   * The second half, for the navigation React cannot keep: a full document load. One key, one of
   * two strings, in sessionStorage — nothing about a person or a child.
   */
  it("remembers open across a full load, and forgets it when closed", () => {
    const store = fakeStore();
    expect(readAgentBubbleOpen(store)).toBe(false);
    writeAgentBubbleOpen(store, true);
    expect(store.map.get(AGENT_BUBBLE_OPEN_KEY)).toBe("1");
    expect(readAgentBubbleOpen(store)).toBe(true);
    writeAgentBubbleOpen(store, false);
    expect(readAgentBubbleOpen(store)).toBe(false);
  });

  it("survives a storage that throws, and a server render with no storage at all", () => {
    const throwing: OpenStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readAgentBubbleOpen(throwing)).toBe(false);
    expect(() => writeAgentBubbleOpen(throwing, true)).not.toThrow();
    expect(readAgentBubbleOpen(undefined)).toBe(false);
    expect(() => writeAgentBubbleOpen(undefined, true)).not.toThrow();
  });
});

/* ───────────────────── the mockup's own numbers ───────────────────── */

describe("the closed disc sits where the mockup puts it", () => {
  const css = read(UI, "AgentBubble.module.css");

  /** agent-bubble.html `.fab`: 56 px, teal, `right:16px; bottom:16px`, a pill radius. */
  it("is a 56 px teal disc 16 px off the bottom-right corner", () => {
    const block = css.slice(css.indexOf(".bubble {"), css.indexOf(".bubble:focus-visible"));
    expect(block).toMatch(/position: fixed/);
    expect(block).toMatch(/right: var\(--layout-agent-bubble-gap\)/);
    expect(block).toMatch(/bottom: var\(--layout-agent-bubble-gap\)/);
    expect(block).toMatch(/width: var\(--layout-agent-bubble-size\)/);
    expect(block).toMatch(/background: var\(--color-brand\)/);
    expect(block).toMatch(/border-radius: var\(--radius-pill\)/);
  });

  /**
   * `.fab{bottom:80px}` below 767 — "64px tab bar + 16px", says the mockup's own comment. Ours
   * adds the device's safe-area inset, because the bar pads itself by it
   * (src/ui/TabBar.module.css) and a flat 80 would put the disc on an iPhone's home bar.
   */
  it("sits 16 px above the tab bar, plus the safe-area inset, below 768", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(phone).toMatch(
      /bottom: calc\(\s*var\(--layout-tab-bar-height\) \+ var\(--layout-agent-bubble-gap\) \+ env\(safe-area-inset-bottom, 0px\)\s*\)/,
    );
  });

  /** `.pnl`: 400 px, under the DEMO bar, and **no dark overlay** anywhere in the file. */
  it("opens as a 400 px panel under the DEMO bar, with no scrim", () => {
    const block = css.slice(css.indexOf(".panel {"), css.indexOf(".head {"));
    expect(block).toMatch(/top: var\(--layout-demo-banner-height\)/);
    expect(block).toMatch(/width: var\(--layout-agent-panel-width\)/);
    expect(css).not.toMatch(/\.overlay|\.scrim|backdrop-filter/);
  });

  /** `.pnl` below 767: `width:auto; left:0; border-left:0` — a full sheet over the tab bar. */
  it("becomes a full sheet at 390", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
    const block = phone.slice(phone.indexOf(".panel {"), phone.indexOf(".head {"));
    expect(block).toMatch(/left: 0/);
    expect(block).toMatch(/width: auto/);
    expect(block).toMatch(/border-left: 0/);
  });

  /** `.cls` is 44 px in the mockup, which is also §9's console target. */
  it("closes with a 44 px X", () => {
    const block = css.slice(css.indexOf(".close {"), css.indexOf(".close:focus-visible"));
    expect(block).toMatch(/width: var\(--target-console\)/);
    expect(block).toMatch(/height: var\(--target-console\)/);
  });

  /**
   * The page is padded so its last row — and the live map's zoom controls — scroll clear of the
   * disc: 88 px at 1440 (16 + 56 + 16) and, on a phone, 80 px *on top of* the tab bar's 64, which
   * is the 144 px the spec asks for at 390.
   */
  it("pads the page clear of the disc at both widths", () => {
    const shell = read(UI, "AppShell.module.css");
    expect(shell).toMatch(/\.main \{[^}]*padding-bottom: var\(--layout-agent-bubble-clear-wide\)/);
    expect(shell).toMatch(/\.contentSlot \{[^}]*padding-bottom: var\(--layout-agent-bubble-clear-wide\)/);
    const phone = shell.slice(shell.indexOf("@media (max-width: 767px)"));
    expect(phone).toMatch(/padding-bottom: var\(--layout-agent-bubble-clear-phone\)/);
  });

  /** The arithmetic, in one place, so a changed disc size cannot leave the padding behind. */
  it("derives those two clearances from the disc and the gap", async () => {
    const { layout } = await import("./tokens");
    const px = (v: string) => Number(v.replace("px", ""));
    expect(px(layout.agentBubbleSize)).toBe(56);
    expect(px(layout.agentBubbleGap)).toBe(16);
    expect(px(layout.agentBubbleClearWide)).toBe(
      px(layout.agentBubbleGap) + px(layout.agentBubbleSize) + px(layout.agentBubbleGap),
    );
    // On a phone the air above the disc is 8 px, so the stack is 64 + 16 + 56 + 8 = 144.
    expect(px(layout.tabBarHeight) + px(layout.agentBubbleClearPhone)).toBe(144);
    expect(px(layout.agentPanelWidth)).toBe(400);
  });
});

describe("the copy is the copy module's, and says nothing it may not", () => {
  it("names the button from copy.ts, with the count in the name when there is one", () => {
    AT.pathname = "/today";
    AT.search = "";
    expect(render({ canDecide: true, waiting: 2 })).toContain(
      `aria-label="${fill(agentBubble.openWaiting, { count: 2 })}"`,
    );
  });

  it("holds no vendor, no model and no 'AI' anywhere in its words", () => {
    for (const [key, value] of Object.entries(agentBubble)) {
      expect(value, key).not.toMatch(/\bAI\b|GPT|OpenRouter|Claude|Anthropic|model/i);
    }
  });

  it("puts every string the bubble renders in copy.ts", () => {
    // No bare words in the component: everything it shows is `agentBubble.*`.
    const jsxText = [...code(read(UI, "AgentBubble.tsx")).matchAll(/>([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*)</g)];
    expect(jsxText.map((m) => m[1].trim()).filter(Boolean)).toEqual([]);
  });
});
