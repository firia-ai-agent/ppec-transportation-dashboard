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
    return {
      inBar: bar ? bar.querySelectorAll('[data-token="src-sim"]').length : 0,
      // There is no app header any more (audit §2 item 1); a chip outside the bar is a chip in
      // a *screen*, which is what the count below is about.
      headers: document.querySelectorAll("header").length,
      bodyText: document.body.innerText,
    };
  });
  expect(seen.inBar, `the one §7.1 chip in the DEMO bar on ${page.url()}`).toBe(1);
  expect(seen.headers, "the app header is back, and carrying chrome again").toBe(0);
  expect(seen.bodyText, "a per-adapter Simulated pill is back").not.toMatch(/·\s*Simulated/);
  expect(seen.bodyText, "the 'Times are simulated' line is back").not.toMatch(/[Tt]imes are simulated/);
}

/**
 * THE PAGE HEADER BAR, AND NO APP HEADER — Vera's audit §2 items 1 and 5; Firia, 2026-10-17
 * 8:36 PM ET.
 *
 * This used to measure that the white app header was a single row. There is no app header: the
 * 96 px band with the product's name in it and the account pill at its far right is deleted at
 * every width, because the rail carries both and what was left was an empty band over a rail the
 * mockup draws running full height.
 *
 * What is measured instead is the bar that replaced it, as boxes rather than as markup: the
 * screen's title sits in the top 64 px of the content column, there is exactly one of it, and
 * nothing in the bar runs off the right-hand edge of the window — which is how the account pill
 * went missing at 390 px on the old header: present, laid out, and half of it off the screen.
 */
export async function expectPageHeaderBar(page: Page): Promise<void> {
  await expect(page.locator("header"), "the app header is back").toHaveCount(0);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title, "no title in the page header bar").toHaveCount(1);
  const box = await boxOf(title);
  // Under the 32 px DEMO bar, and inside the 64 px bar below it.
  expect(Math.round(box.y), `the title is at y=${Math.round(box.y)}, not in the header bar`)
    .toBeGreaterThanOrEqual(32);
  expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(32 + 64);
  const overflowing = await page.evaluate(() => {
    const bar = document.querySelector("h1")?.parentElement;
    if (!bar) return [];
    return Array.from(bar.querySelectorAll("*"))
      .filter((child) => {
        const r = child.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1;
      })
      .map((child) => `${child.tagName.toLowerCase()}: ${(child.textContent ?? "").trim().slice(0, 30)}`);
  });
  expect(overflowing, "the page header bar runs off the right-hand edge of the window").toEqual([]);
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
