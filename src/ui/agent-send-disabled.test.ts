import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { ComposeBar } from "./AgentCompose";
import { canSendAsk, getAsked, resetAsked, sendAsk } from "./agent-ask-state";
import { agentBubble } from "./copy";
import { color } from "./tokens";

/**
 * THE SEND BUTTON IS GREY UNTIL THERE IS SOMETHING TO SEND.
 *
 * The round teal disc at the foot of the panel (mockups/agent-bubble.html `.cmp .snd`, drawn in
 * png/agent-bubble-open-1440.png and -open-390.png) is `disabled` while the field is empty or
 * holds nothing but whitespace, and teal the moment there is a word in it.
 *
 * WHY. A bright teal button over an empty field is an offer the app cannot keep: `askAgent`
 * writes nothing for an empty ask, so pressing it would put a teal bubble of nothing in the thread
 * and one grey "I can't answer right now." under it — the panel answering a question nobody asked.
 * Whitespace is the same case wearing a disguise: three spaces look exactly like none.
 *
 * HOW IT IS TESTED WITHOUT A BROWSER. This repo's vitest runs in node — no DOM, no
 * testing-library — so the bar is a pure component taking the text as a prop
 * (`ComposeBar`, src/ui/AgentCompose.tsx) and each state below is a real render of real markup
 * rather than a source grep. The one predicate all three readers share is `canSendAsk`, and the
 * fetch guard is asserted against `sendAsk` itself, which is the function that holds the `post`.
 */
const UI = __dirname;

const bar = (text: string, sending = false): string =>
  renderToStaticMarkup(
    createElement(ComposeBar, { text, sending, onChangeText: () => {}, onSubmit: () => {} }),
  );

/** The send button's own tag, found by the accessible name copy.ts gives it. */
function sendButton(html: string): string {
  const at = html.indexOf(`aria-label="${agentBubble.send}"`);
  expect(at, "the send button is not in the markup at all").toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", at) + 1);
}

beforeEach(() => resetAsked());

/* ──────────────── the three states, as rendered markup ──────────────── */

describe("the send button is grey with nothing to send and teal with something", () => {
  it("is disabled over an empty field", () => {
    const button = sendButton(bar(""));
    expect(button).toContain("disabled");
    expect(button).toContain('aria-disabled="true"');
  });

  it("is disabled over whitespace only, which looks exactly like empty", () => {
    for (const blank of ["   ", "\t", "\n", " \n\t  "]) {
      const button = sendButton(bar(blank));
      expect(button, `"${JSON.stringify(blank)}" left the button live`).toContain("disabled");
      expect(button).toContain('aria-disabled="true"');
    }
  });

  it("is enabled the moment there is a word in the field", () => {
    const button = sendButton(bar("hi"));
    // The bare `disabled` attribute is gone — matched as an attribute, so `aria-disabled` cannot
    // be mistaken for it.
    expect(button).not.toMatch(/\sdisabled[\s=>]/);
    expect(button).toContain('aria-disabled="false"');
    // The words are what count, not where they sit in the field.
    expect(sendButton(bar("  hi  "))).toContain('aria-disabled="false"');
    expect(sendButton(bar("  hi  "))).not.toMatch(/\sdisabled[\s=>]/);
  });

  it("is disabled again while a request is in flight, so one ask cannot become two", () => {
    const button = sendButton(bar("hi", true));
    expect(button).toContain("disabled");
    expect(button).toContain('aria-disabled="true"');
  });

  /** The field itself is never disabled: a person may keep typing into it. */
  it("greys the button and not the field", () => {
    const html = bar("");
    const field = html.slice(html.indexOf("<input"), html.indexOf(">", html.indexOf("<input")) + 1);
    expect(field).not.toContain("disabled");
  });
});

/* ──────────────── the one predicate the three readers share ──────────────── */

describe("one predicate decides it, so the button and the sender cannot disagree", () => {
  it("is false for empty and for whitespace, true for words", () => {
    expect(canSendAsk("")).toBe(false);
    expect(canSendAsk("   ")).toBe(false);
    expect(canSendAsk("\n\t ")).toBe(false);
    expect(canSendAsk("hi")).toBe(true);
    expect(canSendAsk("  hi  ")).toBe(true);
  });

  it("is what the button, the submit handler and the sender all read", () => {
    const source = readFileSync(path.join(UI, "AgentCompose.tsx"), "utf8");
    // The button's two attributes are the same value, so they cannot drift apart.
    expect(source).toMatch(/const blocked = !canSendAsk\(text\) \|\| sending;/);
    expect(source).toMatch(/disabled=\{blocked\}/);
    expect(source).toMatch(/aria-disabled=\{blocked\}/);
    // …and the submit handler asks it too, because Enter does not ask the button.
    const handler = source.slice(source.indexOf("async function send"), source.indexOf("return <ComposeBar"));
    expect(handler).toMatch(/if \(!canSendAsk\(text\) \|\| sending\) return;/);
  });
});

/* ──────────────── and nothing is sent while it is grey ──────────────── */

describe("pressing Enter or clicking while it is grey sends nothing", () => {
  /**
   * The fetch lives behind `sendAsk`, so the refusal is asserted there: it is the one place a
   * request can be made, and a disabled button is not the only way in — Enter in a one-field form
   * is a submit, and a browser will fire it.
   */
  it("makes no request for an empty or whitespace-only ask, and no bubble either", async () => {
    const calls: string[] = [];
    const post = (text: string) => {
      calls.push(text);
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    for (const blank of ["", "   ", "\n", "\t  "]) {
      await sendAsk(blank, post);
    }

    expect(calls, "an empty ask reached the network").toEqual([]);
    expect(getAsked(), "an empty ask put a bubble in the thread").toEqual([]);
  });

  it("still sends the moment there is something to send", async () => {
    const calls: string[] = [];
    await sendAsk("hi", (text) => {
      calls.push(text);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, outcome: "ran" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    expect(calls).toEqual(["hi"]);
    expect(getAsked()).toHaveLength(1);
  });
});

/* ──────────────── the grey is the system's, and it is a token ──────────────── */

describe("the grey is §4.2's disabled pair, from tokens.ts", () => {
  it("takes both colours from a token and writes no hex", () => {
    const css = readFileSync(path.join(UI, "AgentCompose.module.css"), "utf8");
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = bare.slice(bare.indexOf(".send:disabled"), bare.indexOf("@media"));
    expect(block).toMatch(/background: var\(--color-disabled-bg\)/);
    expect(block).toMatch(/color: var\(--color-disabled-fg\)/);
    expect(bare).not.toMatch(/#[0-9a-f]{3,8}/i);
    // The pair exists in tokens.ts, which is the only file a colour may be written in.
    expect(color["disabled-bg"]).toBeTruthy();
    expect(color["disabled-fg"]).toBeTruthy();
  });

  /** And no new words were needed, which is why copy.ts gained nothing in this commit. */
  it("says nothing new — every word in the bar is still one of copy.ts's", () => {
    const source = readFileSync(path.join(UI, "AgentCompose.tsx"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    // The three things the bar says, and all three come from the one block.
    expect(source).toMatch(/aria-label=\{agentBubble\.send\}/);
    expect(source).toMatch(/aria-label=\{agentBubble\.ask\}/);
    expect(source).toMatch(/placeholder=\{agentBubble\.ask\}/);
    // No sentence about why it is grey: the empty field is the reason and it is already visible.
    // So the component renders no literal of its own — no `>words<` and no `={"words"}`.
    expect(source).not.toMatch(/>[^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*</);
    expect(source).not.toMatch(/=\{"[^"]*[A-Za-z]/);
  });
});
