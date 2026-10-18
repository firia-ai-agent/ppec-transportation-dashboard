import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { API } from "@/auth/access";
import { DAY_VANS } from "@/config/vans";
import { ConfirmRestart } from "./ConfirmRestart";
import { demoDay, flow } from "./copy";
import { restartStep, savedPlanToday, sendDemoReset } from "./restart-confirm";

/**
 * ASK BEFORE A RESET THROWS A PLAN AWAY (Vera's copy, 2026-10-18; founder-approved).
 *
 * Four claims, and all four are about a request: the dialog is shown **only** when a plan is
 * saved for today, "Keep plan" sends nothing, "Restart" sends the existing `POST` and no new
 * endpoint, and every string on the dialog is Vera's verbatim.
 *
 * The decision is a function rather than two components' worth of `useState` for exactly this
 * reason — `send` is the only route to the request, so "Keep plan sends no fetch" is a property
 * of the module and not a thing a browser has to be asked about. The dialog itself is checked as
 * markup, which is how every other screen in this repo is checked (no DOM in these workers).
 */

const UI = path.resolve(__dirname);
const read = (file: string) => readFileSync(path.join(UI, file), "utf8");
/** Comments are notes to the next engineer, not something a screen says or renders. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

/** A `fetch` that records what it was asked for and answers however the test says. */
function spyFetch(answer: (url: string) => { ok: boolean; body?: unknown }) {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const { ok, body } = answer(url);
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body ?? null,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("when the question is asked", () => {
  it("asks only when a plan is saved for today", () => {
    expect(restartStep("PRESS", true)).toEqual({ step: "ASKING", send: false });
    // Nothing saved is nothing to warn about: the press behaves exactly as it did before.
    expect(restartStep("PRESS", false)).toEqual({ step: "SENDING", send: true });
  });

  it("sends nothing on Keep plan, whatever the day looks like", () => {
    for (const saved of [true, false]) {
      expect(restartStep("KEEP", saved)).toEqual({ step: "IDLE", send: false });
    }
  });

  it("sends the reset on Restart", () => {
    expect(restartStep("RESTART", true)).toEqual({ step: "SENDING", send: true });
  });

  /** Escape is Keep plan — the same answer, so it is the same row of the same function. */
  it("has one way to the request, and the safe answer is not on it", () => {
    const sends = (["PRESS", "KEEP", "RESTART"] as const).filter(
      (event) => restartStep(event, true).send,
    );
    expect(sends).toEqual(["RESTART"]);
  });
});

describe("the request itself", () => {
  it("is the reset the app already has, posted once", async () => {
    const { impl, calls } = spyFetch(() => ({ ok: true }));
    await expect(sendDemoReset(impl)).resolves.toBe(true);
    expect(calls).toEqual([{ url: API.demoReset, method: "POST" }]);
  });

  it("says so when the server refuses, and invents no second endpoint", async () => {
    const { impl, calls } = spyFetch(() => ({ ok: false }));
    await expect(sendDemoReset(impl)).resolves.toBe(false);
    expect(calls.map((call) => call.url)).toEqual([API.demoReset]);
  });

  /** Keep plan, end to end: the module's own answer, and not one request made. */
  it("is never reached by Keep plan", async () => {
    const { impl, calls } = spyFetch(() => ({ ok: true }));
    const answer = restartStep("KEEP", true);
    if (answer.send) await sendDemoReset(impl);
    expect(answer.send).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("'is a plan saved for today'", () => {
  it("reads both legs through the board route, and nothing else", async () => {
    const { impl, calls } = spyFetch(() => ({ ok: true, body: { version: 0 } }));
    await expect(savedPlanToday(impl)).resolves.toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls.map((call) => call.url).sort()).toEqual([
      `${API.planBoard}?leg=am`,
      `${API.planBoard}?leg=pm`,
    ]);
  });

  it("is true when either leg has a saved version", async () => {
    for (const [am, pm] of [
      [1, 0],
      [0, 3],
      [2, 2],
    ]) {
      const { impl } = spyFetch((url) => ({
        ok: true,
        body: { version: url.endsWith("am") ? am : pm },
      }));
      await expect(savedPlanToday(impl)).resolves.toBe(true);
    }
  });

  /** "Nobody knows" in front of something irreversible is a reason to ask, not to skip. */
  it("asks when the read could not be made", async () => {
    const refused = spyFetch(() => ({ ok: false }));
    await expect(savedPlanToday(refused.impl)).resolves.toBe(true);
    const threw = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(savedPlanToday(threw)).resolves.toBe(true);
  });
});

/**
 * HOW MANY VANS THE QUESTION IS ABOUT — Veri's S2 on #79.
 *
 * "all 3 vans" was typed into copy.ts, so the one irreversible question in the app was also the
 * only place that still knew how big the fleet was. The sentence is a function of a count now,
 * and the count comes from the van data each caller already holds: `day.vans` on the board, and
 * the vans-on-the-road list the layout reads for the bar (src/config/vans.ts `DAY_VANS`, which is
 * what both day sources build a day's vans from).
 */
describe("the body counts the day's vans", () => {
  const dialog = (vanCount: number) =>
    renderToStaticMarkup(
      createElement(ConfirmRestart, { onKeep: () => {}, onRestart: () => {}, vanCount }),
    );

  it("names one van, two vans and three", () => {
    // Not "all 1 vans" and not "all 2 vans": neither is English, and the dialog is a sentence.
    expect(demoDay.confirm.body(1)).toBe("This clears the saved plan for the van.");
    expect(demoDay.confirm.body(2)).toBe("This clears the saved plan for both vans.");
    expect(demoDay.confirm.body(3)).toBe("This clears the saved plan for all 3 vans.");
    // And on up, from the count alone: a fourth van cannot leave the line claiming three.
    expect(demoDay.confirm.body(4)).toBe("This clears the saved plan for all 4 vans.");
  });

  /** A day with no vans still loses its saved plan, and says so without counting to zero. */
  it("counts nothing on a day with no vans", () => {
    expect(demoDay.confirm.body(0)).toBe("This clears the saved plan.");
    expect(demoDay.confirm.body(-1)).toBe("This clears the saved plan.");
    expect(demoDay.confirm.body(0)).not.toMatch(/\d/);
  });

  it("is the sentence the dialog draws, for the count it was handed", () => {
    expect(dialog(1)).toContain(demoDay.confirm.body(1));
    expect(dialog(2)).toContain(demoDay.confirm.body(2));
    expect(dialog(3)).toContain(demoDay.confirm.body(3));
    // One sentence at a time: the count it was given, and not one of the others.
    expect(dialog(2)).not.toContain(demoDay.confirm.body(3));
  });

  /**
   * And both callers take that count from their van data rather than writing one down. Read as
   * source, because neither caller can be rendered in a worker (both read the router) — the same
   * reason the two tests below this one read files.
   */
  it("is handed the van data's own count by both controls", () => {
    const bar = code(read("DemoRestart.tsx"));
    const board = code(
      readFileSync(path.resolve(__dirname, "..", "app", "plan-routes", "board", "PlanBoard.tsx"), "utf8"),
    );
    // The board: this day's own columns, which is what the dialog's sentence is about.
    expect(board).toMatch(/vanCount=\{day\.vans\.length\}/);
    // The bar: chrome in the root layout, so the count is read there and handed down.
    expect(bar).toMatch(/vanCount=\{vanCount\}/);
    expect(code(read("DemoBanner.tsx"))).toMatch(/<DemoRestart vanCount=\{vanCount\} \/>/);
    expect(code(read("DemoBar.tsx"))).toMatch(/vanCount=\{DAY_VANS\.length\}/);
    // Nobody writes the fleet size down any more, in a sentence or in a prop.
    for (const [name, source] of [
      ["DemoRestart.tsx", bar],
      ["PlanBoard.tsx", board],
      ["ConfirmRestart.tsx", code(read("ConfirmRestart.tsx"))],
      ["DemoBanner.tsx", code(read("DemoBanner.tsx"))],
    ] as const) {
      expect(source, name).not.toMatch(/all 3 vans|vanCount=\{\d/);
    }
  });
});

describe("the dialog, in Vera's words", () => {
  const html = renderToStaticMarkup(
    createElement(ConfirmRestart, {
      onKeep: () => {},
      onRestart: () => {},
      // The fleet the demo centre runs, from the config both day sources read: three.
      vanCount: DAY_VANS.length,
    }),
  );

  it("reads exactly what she wrote", () => {
    expect(demoDay.confirm.title).toBe("Restart today?");
    expect(demoDay.confirm.body(DAY_VANS.length)).toBe("This clears the saved plan for all 3 vans.");
    expect(demoDay.confirm.keep).toBe("Keep plan");
    expect(demoDay.confirm.restart).toBe("Restart");
    for (const line of [
      demoDay.confirm.title,
      demoDay.confirm.body(DAY_VANS.length),
      demoDay.confirm.keep,
      demoDay.confirm.restart,
    ]) {
      expect(html).toContain(line);
    }
  });

  it("is a modal dialog, titled and described by its own two lines", () => {
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="restart-confirm-title"/);
    expect(html).toMatch(/aria-describedby="restart-confirm-body"/);
  });

  it("puts the safe answer first, as the primary, with the focus on it", () => {
    // By hook, not by label: "Restart" is also the first word of the title above them.
    const keep = html.indexOf("data-restart-keep");
    const restart = html.indexOf("data-restart-go");
    expect(keep).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(-1);
    // First in the source, so the tab order is the reading order (§9).
    expect(keep).toBeLessThan(restart);
    expect(html).toMatch(/data-variant="primary"[^>]*data-restart-keep=""/);
    expect(html).toMatch(/autofocus/i);
    // And the coral one is the destructive one, never the default.
    expect(html).toMatch(/data-variant="alert"[^>]*data-restart-go=""/);
  });

  it("Escape is Keep plan, and the component sends nothing itself", () => {
    const source = read("ConfirmRestart.tsx");
    expect(source).toMatch(/event\.key !== "Escape"/);
    expect(source).toMatch(/onKeep\(\);/);
    // No request lives in here: the caller owns it (restart-confirm.ts owns the decision).
    expect(source).not.toMatch(/fetch\(|sendDemoReset/);
  });
});

/**
 * TWO CONTROLS, ONE QUESTION, AND THEY DO NOT SIT TOGETHER.
 *
 * "Restart demo day" is an outlined pill on the DEMO bar's violet (src/ui/DemoRestart.module.css,
 * which says why it wears the bar's pair); "Start demo day" is the underlined word inside the
 * board's own banner sentence (board.module.css `.bannerButton`). Different trees, different
 * stylesheets, nothing adjacent, and nothing alike — which is the separation the review asked
 * for, held here so a later tidy-up cannot put them side by side in one row.
 */
describe("the two restart controls stay apart", () => {
  it("share the dialog and the decision, and nothing else", () => {
    const bar = read("DemoRestart.tsx");
    const board = readFileSync(
      path.resolve(__dirname, "..", "app", "plan-routes", "board", "PlanBoard.tsx"),
      "utf8",
    );
    for (const source of [bar, board]) {
      expect(source).toContain("ConfirmRestart");
      expect(source).toContain("restartStep");
      expect(source).toContain("sendDemoReset");
      // Neither writes the reset's address or builds the request itself any more.
      expect(source).not.toMatch(/API\.demoReset/);
    }
  });

  it("are drawn in different stylesheets, and the bar's is not on the board", () => {
    expect(read("DemoRestart.module.css")).toMatch(/--color-demo-fg/);
    const boardCss = readFileSync(
      path.resolve(__dirname, "..", "app", "plan-routes", "board", "board.module.css"),
      "utf8",
    );
    expect(boardCss).not.toMatch(/--color-demo-/);
    // The board's own control is the banner's word, not a button beside the bar's pill.
    expect(boardCss).toMatch(/\.bannerButton \{[^}]*text-decoration: underline/);
    expect(read("DemoRestart.module.css")).not.toMatch(/\.button \{[^}]*text-decoration/);
  });

  it("is still the bar's one control, and does not draw the board's", () => {
    // Read as source, with the comments stripped: `DemoRestart` reads the router, so it cannot
    // be rendered in a worker (the same reason src/ui/shell.test.ts reads these files).
    const bar = code(read("DemoRestart.tsx"));
    expect(bar).toContain("demoDay.restart");
    // The board's word is the board's: the bar draws one control and has always drawn one.
    expect(bar).not.toContain(flow.action.startDemo);
    expect(bar).not.toContain("flow.action");
  });
});
