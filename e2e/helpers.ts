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

export async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
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
 * D-5, measured on the real screen: the demo violet paints two things and nothing else.
 *
 * The source assertions (src/ui/tokens.test.ts) keep the token out of every stylesheet but the
 * bar's and the chip's. This is the other half, and the half that cannot be argued with: it
 * reads the *computed* colour of every element the browser laid out and asks where the violet
 * ended up. Anything violet has to be inside the DEMO bar or inside a Simulated source chip —
 * which is the whole of the reservation, and is why the violet still means "this is the demo"
 * when a coordinator sees it.
 */
export async function expectVioletOnlyOnDemoChrome(page: Page): Promise<void> {
  const strays = await page.evaluate(() => {
    const VIOLET = "rgb(109, 40, 217)";
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
        // The §7.1 source chip, wherever it is: a screen, a row, a drawer header.
        return el.closest('[data-token="src-sim"]') === null;
      })
      .map(describe);
  });
  expect(strays, `the demo violet is painting something that is not the DEMO bar or the Simulated chip`).toEqual([]);
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
