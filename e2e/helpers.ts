/**
 * The things every browser check needs and none of them should write twice: where a box is,
 * whether two boxes touch, where a screenshot goes, and the two rules that hold on every
 * screen (the DEMO bar is pinned, and no internal code reaches the words).
 *
 * Not a spec file: `testMatch` in playwright.config.ts collects `*.spec.ts`, so this is
 * imported, never run.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { demoBanner, sourceMode } from "../src/ui/copy";

export const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");

/** `[x, y, width, height]` of a laid-out element. Fails when it is not in the layout at all. */
export type Box = { x: number; y: number; width: number; height: number };

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${locator} has no box`).not.toBeNull();
  return box as Box;
}

/** Do two boxes share any pixel? The question every "is it covered?" check reduces to. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

/**
 * A screenshot in artifacts/, and the path to it so the run's log says where it went.
 *
 * The window by default, which is what a review of "what is on screen" wants. `fullPage` is for
 * the shots that have to show the chrome *and* the screen under it in one image — the frame
 * checks at 390 and 1440 px (e2e/one-menu.spec.ts), where the thing being reviewed is that the
 * menu is there at all and the page below it is not hiding behind it.
 */
export async function shot(page: Page, name: string, { fullPage = false } = {}): Promise<string> {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

/**
 * The same internal codes src/ui/no-codes.test.ts bars in the source, run over the text the
 * browser actually rendered. This is the net that needs no judgement about which string
 * literal is copy and which is an identifier.
 */
export const CODE_PATTERNS = [
  /\b(?:SURF|ADR|LOC|AT|NFR|FQ|ASM|EV)-\d+/g,
  /\b(?:PRD|COPY-GUIDE|DESIGN-DIRECTION|MOCKS)\b\s*(?:§|l\.)?/g,
  /\broute\d+(?:-[a-z]+)*\b/g,
];

export async function expectNoInternalCodes(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  const found = CODE_PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0].trim()));
  expect(found, `internal codes on ${page.url()}`).toEqual([]);
}

/**
 * D-5, measured on the real screen: the demo violet paints three things and nothing else.
 *
 * The source assertions (src/ui/tokens.test.ts) keep the token out of every stylesheet but the
 * bar's, the chip's and the demo control's. This is the other half, and the half that cannot be
 * argued with: it reads the *computed* colour of every element the browser laid out and asks
 * where the violet ended up. Anything violet has to be inside the DEMO bar, inside a Simulated
 * source chip, or inside a control that is itself part of the demo (`[data-demo-control]`,
 * src/ui/DemoControls) — which is the whole of the reservation, and is why the violet still
 * means "this is the demo" when a coordinator sees it.
 */
/** `--color-demo-bg` / `--color-src-sim` as the browser computes it. */
export const DEMO_VIOLET = "rgb(109, 40, 217)";
/** `--color-demo-fg`: the bar's ink, and the fill of the option a demo control is set to. */
export const DEMO_INK = "rgb(255, 255, 255)";

export async function expectVioletOnlyOnDemoChrome(page: Page): Promise<void> {
  const strays = await page.evaluate((VIOLET) => {
    const describe = (el: Element): string =>
      `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}`;
    return Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const s = getComputedStyle(el);
        return [
          s.color,
          s.backgroundColor,
          s.borderTopColor,
          s.borderRightColor,
          s.borderBottomColor,
          s.borderLeftColor,
          s.outlineColor,
          s.fill,
          s.stroke,
        ].includes(VIOLET);
      })
      .filter((el) => {
        // The bar: the element that holds the "DEMO" status, and everything under it.
        const bar = document.querySelector('[role="status"][aria-label="DEMO"]')?.parentElement;
        if (bar?.contains(el)) return false;
        // A demo-only control, which wears the bar's fill on purpose (Vera, 2026-10-17).
        if (el.closest("[data-demo-control]") !== null) return false;
        // The §7.1 source chip, wherever it is: a screen, a row, a drawer header.
        return el.closest('[data-token="src-sim"]') === null;
      })
      .map(describe);
  }, DEMO_VIOLET);
  expect(
    strays,
    `the demo violet is painting something that is not the DEMO bar, the Simulated chip or a demo control`,
  ).toEqual([]);
}

/**
 * A demo-only control reads as the demo and not as the screen (Vera's review, 2026-10-17).
 *
 * Measured rather than asserted from the markup: the point of the change is what a coordinator
 * sees, so this reads the computed fill and ink of the control and of the option it is set to.
 * The fill is the DEMO bar's violet, and the chosen option inverts it — which is also why it
 * still reads with the colour off (§3: the check mark is the other cue, and `aria-pressed` the
 * third).
 */
export async function expectDemoControlStyling(control: Locator): Promise<void> {
  const bar = await control.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, ink: s.color };
  });
  expect(bar.background, "a demo control takes the DEMO bar's fill").toBe(DEMO_VIOLET);
  expect(bar.ink, "a demo control takes the DEMO bar's ink").toBe(DEMO_INK);

  const chosen = control.locator('button[aria-pressed="true"]');
  await expect(chosen).toHaveCount(1);
  const option = await chosen.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, ink: s.color };
  });
  expect(option.background, "the chosen option inverts the pair").toBe(DEMO_INK);
  expect(option.ink, "the chosen option inverts the pair").toBe(DEMO_VIOLET);
}

/**
 * ONE Simulated chip in the chrome — Vera's review, 2026-10-17 2:44 PM ET.
 *
 * The §7.1 chip in the violet DEMO bar is the one that says where this screen's data comes
 * from. The app header under it used to say the same thing four more times, as a row of
 * per-adapter pills ("SMS · Simulated", "Teams · Simulated", "GPS · Simulated", "Agent ·
 * Simulated"), with "Times are simulated until the live board is connected." beneath them.
 *
 * What is counted, and what is deliberately not: the chip **in the bar** (exactly one), and any
 * chip **in the app header** (none). The per-record source badges on the board's rows are a
 * different claim — NFR-09 asks for one on every record — so they are left alone; what is
 * barred everywhere is the pill shape the header used, `<adapter> · Simulated`.
 */
export async function expectOneSimulatedChip(page: Page): Promise<void> {
  const seen = await page.evaluate(() => {
    const bar = document.querySelector('[role="status"][aria-label="DEMO"]')?.parentElement ?? null;
    const header = document.querySelector("header");
    return {
      inBar: bar ? bar.querySelectorAll('[data-token="src-sim"]').length : 0,
      inHeader: header ? header.querySelectorAll('[data-token="src-sim"]').length : 0,
      headerText: (header as HTMLElement | null)?.innerText ?? "",
      bodyText: document.body.innerText,
    };
  });
  expect(seen.inBar, `the one §7.1 chip in the DEMO bar on ${page.url()}`).toBe(1);
  expect(seen.inHeader, "the app header is carrying a source chip of its own again").toBe(0);
  expect(seen.headerText, "the app header says 'Simulated' again").not.toMatch(/Simulated/);
  expect(seen.bodyText, "a per-adapter Simulated pill is back").not.toMatch(/·\s*Simulated/);
  expect(seen.bodyText, "the 'Times are simulated' line is back").not.toMatch(/[Tt]imes are simulated/);
}

/**
 * THE HEADER IS ONE ROW — Vera's review, 2026-10-17 2:44 PM ET.
 *
 * It was two: the site name, the scenario clock and the avatar above, four "· Simulated" pills,
 * their note and global search below. "One row" is a fact about boxes, so it is measured as
 * one: every visible child of the header overlaps every other one vertically, which is only
 * true of things side by side, and the whole header is no taller than a single row of 44 px
 * targets with its padding. At 390 px, where the row is tightest, this is the assertion that
 * fails when a readout or a button wraps and pushes the account onto a second line.
 */
export async function expectHeaderIsOneRow(page: Page): Promise<void> {
  const header = await page.evaluate(() => {
    const el = document.querySelector("header");
    if (!el) return null;
    const boxes = Array.from(el.children)
      .map((child) => child.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    return {
      height: el.getBoundingClientRect().height,
      tops: boxes.map((r) => Math.round(r.top)),
      bottoms: boxes.map((r) => Math.round(r.bottom)),
    };
  });
  expect(header, "there is no header on this screen").not.toBeNull();
  const { height, tops, bottoms } = header as { height: number; tops: number[]; bottoms: number[] };
  expect(tops.length, "the header has nothing in it").toBeGreaterThan(1);
  expect(
    Math.max(...tops) < Math.min(...bottoms),
    `the header is stacked, not in a row: tops ${tops.join()} bottoms ${bottoms.join()}`,
  ).toBe(true);
  expect(height, `the header is ${height}px tall, which is more than one row`).toBeLessThanOrEqual(80);
  /*
   * ...and the row fits the window. One row that runs off the right-hand edge is how the
   * account pill went missing at 390 px: present, laid out, and half of it off the screen.
   */
  const overflowing = await page.evaluate(() => {
    const el = document.querySelector("header");
    if (!el) return [];
    return Array.from(el.querySelectorAll("*"))
      .filter((child) => {
        const r = child.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1;
      })
      .map((child) => `${child.tagName.toLowerCase()}: ${(child.textContent ?? "").trim().slice(0, 30)}`);
  });
  expect(overflowing, "the header runs off the right-hand edge of the window").toEqual([]);
}

/** Every page: the one DEMO bar, and it is on screen at the bottom of the page too (NFR-09). */
export async function expectDemoBarPinned(page: Page): Promise<void> {
  const bar = page.getByRole("status", { name: demoBanner.ariaLabel });
  await expect(bar).toBeVisible();
  /*
   * §7.1 / NFR-09: the screen-level source chip rides in the bar's trailing cell, so "every
   * screen has the bar" and "every screen has the Simulated chip" are one assertion. Located by
   * the token it is painted with, which is also the only thing on the screen allowed to be
   * violet (see expectVioletOnlyOnDemoChrome).
   */
  const chip = page.locator('[data-token="src-sim"]').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(sourceMode.SIMULATED);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await expect(bar).toBeInViewport();
  const box = await boxOf(bar);
  expect(box.y, "the DEMO bar is still at the top of the window after a scroll").toBeLessThan(40);
  await page.evaluate(() => window.scrollTo(0, 0));
}
