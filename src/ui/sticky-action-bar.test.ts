import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { border, space, stickyActionBar, tokenCss } from "./tokens";

/**
 * ONE SHARED OFFSET FOR A PAGE'S PINNED ACTION BAR — `--sticky-action-bar-height`.
 *
 * #82 (Ramp iPad) pins Confirm to the floor below 768 (`position: fixed` above the tab bar,
 * src/app/ramp-ipad/arrival/arrival.module.css `.confirmBar`, png/ramp-arrival-390.png `.conf`).
 * The agent chat disc is also pinned to the floor by the *frame*, so without an offset the two
 * share the bottom-right corner of a 390 px window and the disc lands on the one button the whole
 * screen exists for.
 *
 * THE SHAPE OF THE FIX, and it is the half worth testing: it is a **contract**, not a Ramp case.
 * The frame declares a default of 0 (src/ui/tokens.ts `stickyActionBar`), every frame rule that
 * floats something at the bottom adds `var(--sticky-action-bar-height, 0px)`, and a page that
 * pins a bar declares its own height on the document root for as long as it is the page. So:
 *
 *  - nothing in AgentBubble.module.css or AppShell.module.css names the ramp iPad, or knows it
 *    exists — asserted below, because a `[data-page="ramp"]` special case is exactly the thing
 *    this is instead of;
 *  - the ramp iPad names no bubble geometry either;
 *  - the next screen with a pinned Confirm gets the clearance by declaring a height.
 *
 * The number itself is derived from the bar's own CSS rather than measured off a screenshot, and
 * the arithmetic is repeated here so a changed padding cannot quietly move the disc back onto the
 * button. e2e/agent-bubble.spec.ts measures the two boxes in a real browser at 390×844.
 */
const UI = __dirname;
const SRC = path.resolve(UI, "..");
const ARRIVAL = path.join(SRC, "app", "ramp-ipad", "arrival", "arrival.module.css");

const read = (file: string) => readFileSync(file, "utf8");
const px = (v: string) => Number(v.replace("px", ""));

const bubbleCss = read(path.join(UI, "AgentBubble.module.css"));
const shellCss = read(path.join(UI, "AppShell.module.css"));
const arrivalCss = read(ARRIVAL);

/** The <768 half of a stylesheet, which is where everything below lives. */
const phone = (css: string) => css.slice(css.indexOf("@media (max-width: 767px)"));

/* ─────────────────────── the frame's default is zero ─────────────────────── */

describe("the frame declares the property, and its default is nothing", () => {
  it("emits --sticky-action-bar-height: 0px into the one :root block", () => {
    expect(stickyActionBar.none).toBe("0px");
    expect(tokenCss()).toContain("--sticky-action-bar-height:0px");
  });

  /**
   * Every reader writes the fallback as well as the property. A page that declares nothing is the
   * common case, and `var(--x)` with no fallback resolves to the guaranteed-invalid value inside a
   * `calc()` — which would drop the whole `bottom` and put the disc at the window's floor.
   */
  it("is read with an explicit 0px fallback everywhere, so an undeclared page is unchanged", () => {
    const reads = [...`${bubbleCss}${shellCss}`.matchAll(/var\(--sticky-action-bar-height[^)]*\)/g)].map(
      (m) => m[0],
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r).toBe("var(--sticky-action-bar-height, 0px)");
  });
});

/* ─────────────────────── the bubble rides above the bar ─────────────────────── */

describe("the disc's bottom offset includes the page's sticky action bar", () => {
  it("adds it to the tab bar, the bar's hairline, the gap and the safe-area inset at <768", () => {
    expect(phone(bubbleCss)).toMatch(
      /bottom: calc\(\s*var\(--layout-tab-bar-height\) \+ var\(--border-hairline\) \+ var\(--layout-agent-bubble-gap\) \+\s*var\(--sticky-action-bar-height, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\s*\)/,
    );
  });

  it("grows the page's bottom padding by the same length, at both widths", () => {
    // ≥768: the disc's own 88 px clearance plus whatever the page has pinned.
    for (const rule of [".main", ".contentSlot"]) {
      const at = shellCss.indexOf(`${rule} {`);
      expect(at, `${rule} is gone`).toBeGreaterThan(-1);
      const block = shellCss.slice(at, shellCss.indexOf("}", at));
      expect(block).toMatch(
        /padding-bottom: calc\(var\(--layout-agent-bubble-clear-wide\) \+ var\(--sticky-action-bar-height, 0px\)\)/,
      );
    }
    // <768: the phone clearance, which stacks on the tab bar's own padding on `.body`.
    expect(phone(shellCss)).toMatch(
      /padding-bottom: calc\(\s*var\(--layout-agent-bubble-clear-phone\) \+ var\(--sticky-action-bar-height, 0px\)\s*\)/,
    );
  });

  /**
   * THE POINT OF THE WHOLE COMMIT: the frame holds no list of pages. A `[data-page]` selector or
   * the word "ramp" in either of these two files would mean the next screen with a pinned bar
   * needs a second special case here, which is how the live map's controls got under the disc in
   * the first place.
   */
  it("names no page: the frame knows the length, not who declared it", () => {
    for (const [name, css] of [
      ["AgentBubble.module.css", bubbleCss],
      ["AppShell.module.css", shellCss],
    ] as const) {
      expect(css, `${name} names the ramp iPad`).not.toMatch(/ramp-ipad|confirmBar|data-confirm/);
      expect(css).not.toMatch(/\[data-page/);
    }
    /*
     * …and the ramp iPad holds no bubble geometry and no bubble *rule* at all (Vera).
     * It used to hide the closed disc below 768 — the demo ruling of 2026-10-18 10:10 AM ET, taken
     * instead of this very offset because the offset did not exist yet. The offset landed, so the
     * hide went: the disc clears the Confirm bar by the arithmetic below rather than by vanishing.
     */
    const bareArrival = arrivalCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bareArrival).not.toMatch(/agent-bubble/);
    expect(bareArrival).not.toMatch(/display: none/);
  });
});

/* ─────────────────────── the Ramp page declares its height ─────────────────────── */

describe("the ramp iPad's arrival page declares its Confirm bar's height", () => {
  it("sets the property on the document root, and only where the bar is pinned", () => {
    // Not declared above 767: there the bar is back in the flow and 0 is the right answer. Read
    // past the comments, which name the property where they explain it.
    const bare = arrivalCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const before = bare.slice(0, bare.indexOf("@media (max-width: 767px)"));
    expect(before).not.toMatch(/--sticky-action-bar-height/);

    expect(phone(arrivalCss)).toMatch(
      /:global\(:root\) \{\s*--sticky-action-bar-height: calc\(\s*var\(--border-hairline\) \+ var\(--space-3\) \+ var\(--ramp-confirm-height\) \+ var\(--space-3\)\s*\),?\s*;?\s*\}/,
    );
  });

  it("derives it from the bar's own CSS rather than writing a measured number", () => {
    // The button's height is written once and read twice: by the button, and by the sum above.
    expect(arrivalCss).toMatch(/--ramp-confirm-height: 60px/);
    expect(arrivalCss).toMatch(/min-height: var\(--ramp-confirm-height\)/);
    // No literal 77 anywhere: the sum is the sum, so a changed padding moves the disc with it.
    expect(arrivalCss).not.toMatch(/\b77px\b/);
    expect(phone(bubbleCss)).not.toMatch(/\b77px\b/);
  });

  /**
   * THE NUMBER, for the record: `border-top` 1 + `padding` 8 + the button 60 + `padding` 8 = 77.
   * The bar holds exactly one child — VanArrival.tsx renders `.confirm` and nothing beside it —
   * so the `gap` never applies and the height is the padding box plus that button.
   */
  it("is 77 px, and that is 1 + 8 + 60 + 8", () => {
    const CONFIRM = 60;
    const height = px(border.hairline) + px(space["3"]) + CONFIRM + px(space["3"]);
    expect(height).toBe(77);
    expect(px(border.hairline)).toBe(1);
    expect(px(space["3"])).toBe(8);
  });

  /**
   * And the disc clears it at 390×844, which is the founder-visible claim. The bar's box runs
   * y 703–780 (the tab bar's 64 under it); the disc's offset is 64 + 1 + 16 + 77 = 158 from the
   * floor, so it occupies y 630–686. A 17 px gap, and no shared pixel.
   */
  it("puts the disc 17 px above the bar's top edge at 390x844", async () => {
    const { layout } = await import("./tokens");
    const VIEWPORT = 844;
    const bar = px(layout.tabBarHeight);
    const sticky = 77;

    const barTop = VIEWPORT - bar - sticky;
    const discBottom = VIEWPORT - (bar + px(border.hairline) + px(layout.agentBubbleGap) + sticky);
    const discTop = discBottom - px(layout.agentBubbleSize);

    expect(barTop).toBe(703);
    expect(discBottom).toBe(686);
    expect(discTop).toBe(630);
    expect(barTop - discBottom).toBe(17);
    // The two boxes do not intersect, which is what the browser check measures.
    expect(discBottom).toBeLessThan(barTop);
  });

  /** Without the offset the disc would be at y 707–763 — inside the bar. That is the bug. */
  it("would have landed on the bar without it", () => {
    const VIEWPORT = 844;
    const bar = 64;
    const discBottom = VIEWPORT - (bar + 1 + 16);
    expect(discBottom).toBe(763);
    expect(discBottom).toBeGreaterThan(VIEWPORT - bar - 77);
  });
});
