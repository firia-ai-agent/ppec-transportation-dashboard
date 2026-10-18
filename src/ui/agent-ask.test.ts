import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AT = { pathname: "/today", search: "" };
vi.mock("next/navigation", () => ({
  usePathname: () => AT.pathname,
  useSearchParams: () => new URLSearchParams(AT.search),
}));

import { AgentBubble } from "./AgentBubble";
import { AgentThread, type AgentThreadItem } from "./AgentThread";
import { addAsk, addNoAnswer, getAsked, resetAsked, sendAsk } from "./agent-ask-state";
import { agentBubble } from "./copy";

/**
 * EVERY ASK SHOWS, RIGHT AWAY — Firia and Vera, 2026-10-18 9:17 AM ET.
 *
 *   (a) after send, the teal bubble with the exact text is in the thread BEFORE the fetch
 *       resolves, and it stays there whatever the response is;
 *   (b) a fetch that rejects, a 503, a 500 and an "unavailable" body each give exactly one grey
 *       "I can't answer right now." under the ask;
 *   (c) the compose field clears on send, and two asks give two bubbles in the order they were
 *       asked.
 *
 * Against Vera's binding mockup — the teal bubble on the right and the grey one on the left are
 * `.out` and `.in` of /workspace/ppec-redesign/mockups/agent-bubble.html, drawn in
 * /workspace/ppec-redesign/png/agent-bubble-open-1440.png and -open-390.png.
 *
 * This repo's vitest runs in node: no DOM, no testing-library. So the order of the two things the
 * compose bar does lives in src/ui/agent-ask-state.ts as a function of its one dependency, and is
 * asserted here by handing it a `post` that never settles — which is literally "before the fetch
 * resolves" — and then rendering the thread the bubble would draw.
 */
const UI = __dirname;

/** The thread the open panel draws, as markup. */
function threadOf(items: readonly AgentThreadItem[]): string {
  return renderToStaticMarkup(createElement(AgentThread, { items }));
}

/** What the mounted bubble draws right now, server thread plus whatever this tab has asked. */
function panel(items: readonly AgentThreadItem[] = []): string {
  AT.pathname = "/today";
  AT.search = "";
  return threadOf([...items, ...getAsked()]);
}

/**
 * The grey line as it reaches the markup: React escapes the apostrophe, so the string compared
 * against the HTML is the copy with that one substitution and never a second copy of the words.
 */
const NO_ANSWER = agentBubble.noAnswer.replace(/'/g, "&#x27;");

const ASK = "Move Liam D. to Van 2 for the afternoon";
const SECOND = "Tell the Okeechobee families we are 10 minutes late";

/** A response, as the route actually shapes one (src/app/api/agent/ask/route.ts). */
function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A request that never comes back — the whole of "before the fetch resolves". */
function pending(): Promise<Response> {
  return new Promise<Response>(() => {});
}

beforeEach(() => {
  resetAsked();
});

/* ───────── (a) the ask is in the thread before anything is known about it ───────── */

describe("(a) the ask is in the thread before the fetch resolves", () => {
  it("puts the exact text in a teal bubble while the request is still in flight", async () => {
    const send = sendAsk(ASK, pending);
    // One turn of the microtask queue: everything `sendAsk` does before its first `await`.
    await Promise.resolve();

    const html = panel();
    expect(html).toContain(ASK);
    // `.out`: teal, on the right. The grey `.in` is a driver or the agent, never the asker.
    const bubble = html.slice(html.indexOf(ASK) - 200, html.indexOf(ASK));
    expect(bubble).toMatch(/outbound/);
    expect(bubble).not.toMatch(/inbound/);
    // Nothing has been answered yet, so nothing is said about an answer.
    expect(html).not.toContain(NO_ANSWER);
    void send;
  });

  it("shows it even when the server thread is empty, instead of the empty line", async () => {
    void sendAsk(ASK, pending);
    await Promise.resolve();
    const html = panel([]);
    expect(html).toContain(ASK);
    expect(html).not.toContain(agentBubble.empty);
  });

  it("keeps it there whatever the response is", async () => {
    await sendAsk(ASK, () => Promise.resolve(response(503, { ok: false })));
    expect(panel()).toContain(ASK);

    resetAsked();
    await sendAsk(ASK, () => Promise.resolve(response(200, { ok: true, outcome: "ran" })));
    expect(panel()).toContain(ASK);
  });

  it("adds the bubble before it awaits anything, in the one function that sends", () => {
    /*
     * The order is the rule, so it is read off the source as well as off the behaviour above: the
     * optimistic insert is the first statement of `sendAsk`, ahead of every `await` in it.
     */
    const source = readFileSync(path.join(UI, "agent-ask-state.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function sendAsk"));
    expect(body.indexOf("addAsk(text)")).toBeLessThan(body.indexOf("await"));
  });
});

/* ───────── (b) one grey line under an ask nobody could answer ───────── */

describe("(b) everything that is not an answer says the same one line", () => {
  /**
   * The four the lane names, and they are four different shapes of the same fact: a network
   * error, a 503, a 500, and a 200 carrying `ok:false` — which is what the route returns for a
   * runner that is not ok, a gateway PROVIDER_ERROR, a missing key, and a preview that wrote
   * nothing (`previewSkip`). The panel does not tell them apart, because the difference between
   * them is a vendor, a key or an outage and none of those is a coordinator's to read.
   */
  const CASES: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
    ["a network error", () => Promise.reject(new Error("network"))],
    ["a 503", () => Promise.resolve(response(503, { ok: false }))],
    ["a 500", () => Promise.resolve(response(500, { ok: false }))],
    ["an unavailable body", () => Promise.resolve(response(200, { ok: false, outcome: "unavailable" }))],
    ["a preview that wrote nothing", () => Promise.resolve(response(200, { ok: false, outcome: "skipped" }))],
    ["a body that is not JSON at all", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ];

  for (const [name, post] of CASES) {
    it(`says it exactly once under the ask after ${name}`, async () => {
      await sendAsk(ASK, post);
      const html = panel();

      // The ask is still there — that is the whole ruling — and the reply is under it.
      expect(html).toContain(ASK);
      expect(html.split(NO_ANSWER)).toHaveLength(2);
      expect(html.indexOf(ASK)).toBeLessThan(html.indexOf(NO_ANSWER));

      // Grey, on the left: it is the agent speaking, with no name above it and no "AI" anywhere.
      const before = html.slice(0, html.indexOf(NO_ANSWER));
      expect(before.slice(-200)).toMatch(/inbound/);
      expect(html).not.toMatch(/\bAI\b/);
    });
  }

  it("says nothing at all when the ask was answered", async () => {
    await sendAsk(ASK, () => Promise.resolve(response(200, { ok: true, outcome: "ran" })));
    const html = panel();
    expect(html).toContain(ASK);
    expect(html).not.toContain(NO_ANSWER);
  });

  it("cannot put the same line under the same ask twice", () => {
    const id = addAsk(ASK);
    addNoAnswer(id);
    addNoAnswer(id);
    expect(getAsked().filter((item) => item.kind === "agent")).toHaveLength(1);
  });

  it("answers the ask it belongs to, not the last one, when two are in flight", async () => {
    const first = addAsk(ASK);
    addAsk(SECOND);
    addNoAnswer(first);
    const html = panel();
    // …under the FIRST, which means above the second ask rather than at the foot of the thread.
    expect(html.indexOf(NO_ANSWER)).toBeLessThan(html.indexOf(SECOND));
  });

  /**
   * NO KEYWORD FALLBACK, and no key anywhere near a log. The degraded mode is one fixed sentence
   * from copy.ts; a reply assembled from the words of the question would be the panel pretending
   * to have understood it, and that is the thing the lane forbids outright.
   */
  it("never parses the ask and never logs anything", () => {
    for (const file of ["agent-ask-state.ts", "AgentCompose.tsx"]) {
      const source = readFileSync(path.join(UI, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(source, `${file} logs`).not.toMatch(/console\./);
      expect(source, `${file} reads a key`).not.toMatch(/API_KEY|apiKey|process\.env/);
      // The ask is sent and stored; it is never matched against, split or searched for words.
      expect(source, `${file} parses the ask`).not.toMatch(/\.match\(|\.includes\(|\.split\(|\.test\(/);
    }
  });
});

/* ───────── (c) the field clears, and two asks are two bubbles in order ───────── */

describe("(c) the field clears and the asks stack up in order", () => {
  it("clears the field on send rather than on a response", () => {
    /*
     * The field is `useState` in a client component and this repo's vitest has no DOM, so the
     * rule is read where it is written: `setText("")` is in the send handler ahead of the await,
     * and is not conditional on what came back. The ask is in the thread by then, so leaving it
     * in the box as well would be the same sentence twice.
     */
    const source = readFileSync(path.join(UI, "AgentCompose.tsx"), "utf8");
    const handler = source.slice(source.indexOf("async function send"), source.indexOf("return ("));
    expect(handler).toMatch(/setText\(""\)/);
    expect(handler.indexOf('setText("")')).toBeLessThan(handler.indexOf("await sendAsk"));
    // Not `if (res.ok) setText("")`, which is what it used to be.
    expect(handler).not.toMatch(/res\.ok|result\.ok/);
  });

  it("gives two asks two bubbles, in the order they were asked", async () => {
    await sendAsk(ASK, () => Promise.resolve(response(200, { ok: true, outcome: "ran" })));
    await sendAsk(SECOND, () => Promise.resolve(response(200, { ok: true, outcome: "ran" })));

    const html = panel();
    expect(html).toContain(ASK);
    expect(html).toContain(SECOND);
    expect(html.indexOf(ASK)).toBeLessThan(html.indexOf(SECOND));
    expect(getAsked()).toHaveLength(2);
  });

  it("keeps the asks under whatever the server thread already held", async () => {
    const driver: AgentThreadItem = {
      kind: "driver",
      id: "m1",
      name: "Marcus L.",
      van: 1,
      text: "Running 10 min behind on Okeechobee",
    };
    void sendAsk(ASK, pending);
    await Promise.resolve();
    const html = panel([{ kind: "day", label: agentBubble.today }, driver]);
    expect(html.indexOf(driver.kind === "driver" ? driver.text : "")).toBeLessThan(html.indexOf(ASK));
  });
});

/* ───────── and the bubble is where they live ───────── */

describe("the asks live in the persistent bubble, not in the page", () => {
  it("renders nothing of them on the server, so the markup the browser hydrates with agrees", () => {
    addAsk(ASK);
    // The bubble is mounted by the shell and read as an external store; the server snapshot is
    // empty, exactly as the open/closed one is always closed (src/ui/agent-bubble-state.ts).
    const source = readFileSync(path.join(UI, "AgentBubble.tsx"), "utf8");
    expect(source).toMatch(/useSyncExternalStore\(subscribeAsked, getAsked, getAskedOnServer\)/);
    const closed = renderToStaticMarkup(
      createElement(AgentBubble, { canDecide: true, waiting: 0, items: [] }),
    );
    expect(closed).not.toContain(ASK);
  });

  it("is not persisted anywhere: an unanswered ask is not a message this app stores", () => {
    const source = readFileSync(path.join(UI, "agent-ask-state.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(source).not.toMatch(/sessionStorage|localStorage|fetch\(|\/api\//);
  });
});
