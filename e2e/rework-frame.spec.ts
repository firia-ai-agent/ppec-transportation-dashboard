/**
 * THE REWORKED FRAME, MEASURED — every screen this role can reach, at the phone width and at
 * the founder's laptop.
 *
 * Vera's walk of PR #71 at 4bdd034 is the list this file answers, item by item, on a real
 * browser rather than in the source:
 *  - `/family-texts` answered 404 from a menu that linked to it — so nothing on the menu may
 *    404, and the three addresses that were missing are walked as well;
 *  - the menu itself had to be on every one of them, in the shape that width draws (the rail at
 *    1440, the bottom tab bar at 390) and with no hamburger anywhere;
 *  - "Simulated" was on the board 57 times and on the live map 4 — one visible chip per screen,
 *    and it is the one in the DEMO bar;
 *  - "Wed, Oct 14" was at the top of a board being looked at on the 17th;
 *  - "Restart demo day" must be in the DEMO bar and must not exist at all for the front desk;
 *  - Today's step strip has to be three cards that each open a screen this role can open;
 *  - and the thing the whole redesign is about: leaving a screen and coming back without the
 *    browser being the only way around — which is checked here by using the browser's Back
 *    button *deliberately* and finding the frame still there.
 *
 * One run is one role: `E2E_DEMO_ROLE` is read by the server process (playwright.config.ts), so
 * this file adapts to the role it was started as and the three roles are three runs. What it
 * walks is that role's own menu, from the same `navItemsFor` the rail filters with.
 *
 * No database and no credentials: the test-only synthetic session grants a role and nothing
 * else, and is refused outright on any deployment.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { StaffRole } from "../src/auth/core";
import { deriveReadiness, unreadFacts } from "../src/domain/day/readiness";
import { legAt, serviceDateAt } from "../src/domain/day/day-facts";
import { demoDay, flow, nav, sourceMode } from "../src/ui/copy";
import { menuBadgeFor } from "../src/ui/menu-badge";
import { MENU_SIZE, navItemsFor } from "../src/ui/nav-items";
import { stepsFor } from "../src/ui/step-strip";
import { APPROVAL_ROLES, MOVED_PAGES, homePathFor, pageOutcome } from "../src/auth/access";
import { ARTIFACTS, expectDemoBarPinned, frameHeaders } from "./helpers";

/** The role playwright.config.ts started the server as. Its default is the director. */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/**
 * This role's menu — and below 768 the bar carries every item of it, one tab each (Firia,
 * 2026-10-17 8:36 PM ET). There is no overflow and no "More": the menu is five items at every
 * width, so `TABS` is the menu.
 */
const MENU = navItemsFor(ROLE);
const TABS = MENU;

/**
 * The addresses walked on top of the menu. `/whoami` rendered with no frame at all on the
 * founder's walk; `/family-texts` was a 404 behind a menu item. `/approvals` is not in this list
 * any more — it is a permanent redirect to the tab it is (§9.2), and the redirects have a test
 * of their own below, where the status line is what is being read.
 */
const EXTRA = ["/whoami", "/family-texts"];

const ROUTES = [...MENU.map((item) => item.href), ...EXTRA];

const WIDTHS = [390, 1440] as const;

/**
 * The day this run's server reads, which is no day at all: the synthetic session is a role with
 * no site behind it (src/auth/caller.ts), so the readiness loader has nothing to read a centre's
 * rows for and answers with the unread day — Needed, Needed, Locked
 * (src/domain/day/day-facts.ts). Derived here through the same function the server uses rather
 * than written out, so this file cannot drift from it, and deterministic by the shape of the
 * session rather than by an environment variable a deployment could set.
 */
const READINESS = deriveReadiness(unreadFacts(serviceDateAt(), legAt()));
const STEPS = stepsFor(ROLE, READINESS);

const slug = (href: string) => href.replace(/^\//, "") || "home";

/** This run's screenshots, one folder, named `<role>-<route>-<width>.png`. */
async function shotOf(page: Page, href: string, width: number): Promise<string> {
  const dir = path.join(ARTIFACTS, "rework-frame");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ROLE.toLowerCase()}-${slug(href)}-${width}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * Text a person can actually see, matched.
 *
 * `innerText` is the wrong instrument for this: the §7.1 source chip and the board's per-record
 * sources write "Source: Simulated" for a screen reader in a clipped `.srOnly` span, and a
 * count taken off `innerText` reads those as being on the screen. So this walks the text nodes
 * and drops any inside an `.srOnly`, inside a `display: none` box (the bar's "Synthetic data"
 * below 768, the rail at phone width) or in a box the layout gave no size to.
 *
 * `aria-hidden` is deliberately *not* a reason to skip: the source chip's visible label is
 * aria-hidden precisely because the screen-reader text beside it already says it, so an
 * aria-hidden subtree is often the half a person actually reads. What is being counted here is
 * what the eye sees, which is the opposite question from what a screen reader hears.
 */
async function visibleMatches(page: Page, pattern: string): Promise<string[]> {
  return page.evaluate((source) => {
    const re = new RegExp(source, "g");
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.textContent ?? "";
      const found = text.match(re);
      if (!found) continue;
      let el: HTMLElement | null = node.parentElement;
      let hidden = false;
      while (el) {
        if (el.classList.contains("srOnly")) {
          hidden = true;
          break;
        }
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          hidden = true;
          break;
        }
        el = el.parentElement;
      }
      if (!hidden && (node.parentElement?.getClientRects().length ?? 0) > 0) out.push(...found);
    }
    return out;
  }, pattern);
}

/**
 * The frame, at this width: one brand, one identity, the menu this width draws — and not the
 * other one — and nothing to open to find it. Returns the menu, because every caller's next
 * question is about what is in it.
 */
async function expectFrame(page: Page, width: number, where: string) {
  const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
  const brand = page.locator("[data-rail-brand]");
  const railAccount = page.locator("[data-rail-account]");
  const pageAccount = page.locator("[data-page-account]");
  /*
   * NO APP HEADER, AT ANY WIDTH (audit §2 items 1, 3 and 5). The 96 px white band with the
   * product's name in it and the "Dana ⌄" pill at its far right is deleted: the brand is the
   * block at the head of the rail, the account is the block at its foot, and the screen's title
   * is the 64 px page header bar inside the content column.
   */
  expect(await frameHeaders(page), `an app header on ${where} at ${width}`).toEqual([]);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title, `no page title on ${where} at ${width}`).toBeVisible();
  expect(
    await title.evaluate((el) => Math.round(el.getBoundingClientRect().top)),
    `the title is not in the page header bar on ${where}`,
  ).toBeLessThan(32 + 64);
  /*
   * WHERE THE IDENTITY IS, and that there is one of it (REDESIGN-SPEC §9.2, audit §2 item 5).
   * At 768 and up the rail carries it — the block at its foot, beside the brand block at its
   * head. Below 768 the rail is a tab bar with no room for a name, so the account is the 36 px
   * disc at the trailing end of the page header bar, and it is a link to /whoami, where Sign
   * out is.
   */
  if (width >= 768) {
    await expect(brand, `no brand block on ${where} at ${width}`).toBeVisible();
    await expect(railAccount, `no account block on ${where} at ${width}`).toBeVisible();
    await expect(pageAccount, `a second identity on ${where} at ${width}`).toBeHidden();
  } else {
    await expect(pageAccount, `no account disc on ${where} at ${width}`).toBeVisible();
    await expect(railAccount, `a second identity on ${where} at ${width}`).toBeHidden();
    expect(await pageAccount.getAttribute("href")).toBe("/whoami");
  }
  const bar = page.locator("[data-tab-bar]");
  // The hamburger and its drawer are deleted (Firia, 2026-10-17 3:08 PM ET), at every width —
  // and so is the phone bar's "More" tab and the sheet it opened (Firia, 8:36 PM ET).
  await expect(page.getByRole("button", { name: /menu/i }), `a hamburger on ${where}`).toHaveCount(0);
  await expect(page.locator("[data-nav-drawer]"), `a drawer on ${where}`).toHaveCount(0);
  await expect(page.locator("[data-more-tab]"), `a More tab on ${where}`).toHaveCount(0);
  await expect(page.locator("[data-more-sheet]"), `a More sheet on ${where}`).toHaveCount(0);
  if (width < 768) {
    await expect(bar, `no tab bar on ${where} at ${width}`).toBeVisible();
    await expect(rail, `the desk rail is on screen at ${width} as well`).toBeHidden();
    return bar;
  }
  await expect(rail, `no menu on ${where} at ${width}`).toBeVisible();
  await expect(bar, `the phone tab bar is on screen at ${width} as well`).toBeHidden();
  return rail;
}

for (const width of WIDTHS) {
  test.describe(`the reworked frame, as ${ROLE} at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 } });

    test("every screen this role reaches has the frame, one chip, and no fixture date", async ({
      page,
    }) => {
      expect(MENU.length, `${ROLE} has no menu at all`).toBeGreaterThan(0);

      for (const href of ROUTES) {
        const response = await page.goto(href);
        const status = response?.status();
        /*
         * Nothing on the menu 404s — the founder's rule, and the thing `/family-texts` broke on
         * production. The three extras are held to it too: a role that may not open one is
         * redirected to its own home (§9.3), which is a 200 on the screen it lands on, never a
         * 404 and never a dead end.
         */
        expect(status, `${href} answered ${status}`).not.toBe(404);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const where = new URL(page.url()).pathname;
        const menu = await expectFrame(page, width, where);
        /*
         * The menu's own links. `:not([data-rail-account])` because the rail's foot carries one
         * more link that is not a destination on the menu — the account block, which opens
         * /whoami (REDESIGN-SPEC §9.2) — and counting it would make every role's menu one item
         * longer than their row in the access table says.
         */
        await expect(menu.locator("a:not([data-rail-account])")).toHaveCount(
          width < 768 ? TABS.length : MENU.length,
        );

        // The one DEMO bar, pinned, with the one §7.1 chip riding in it.
        await expectDemoBarPinned(page);

        /*
         * EXACTLY ONE VISIBLE "Simulated" — the chip in the bar. The board used to carry 56
         * more down its right-hand edge and the live map three under the vans; the per-record
         * source is screen-reader text now, so the requirement (NFR-09: every record carries
         * its source) and the review (one chip per screen) are both met.
         */
        const simulated = await visibleMatches(page, sourceMode.SIMULATED);
        expect(simulated, `visible "Simulated" on ${where} at ${width}`).toHaveLength(1);

        /*
         * NO FIXTURE DATE. The scenario replays a seeded Wednesday and every screen prints the
         * day the demo is being given on instead (src/ui/service-date.ts). "Oct 14" is the one
         * that was on screen; the assertion is the general one, so next week's is caught too.
         */
        expect(await visibleMatches(page, "Oct\\s+14"), `a fixture date on ${where}`).toEqual([]);

        /*
         * THE DEMO'S ONE CONTROL, and who may see it. The front desk never does — not hidden in
         * CSS, not in the DOM — and `POST /api/demo/reset` refuses them besides
         * (src/app/api/demo/reset/route.test.ts). It is one role's control, so for the others
         * all that is claimed is that neither label is loose on the screen.
         */
        const restart = page.locator("[data-demo-restart]");
        if (ROLE === "FRONT_DESK") {
          await expect(restart, `the front desk is being offered the reset on ${where}`).toHaveCount(0);
          expect(await page.locator("body").innerText()).not.toMatch(
            /Restart demo day|Start demo day/,
          );
        } else if (ROLE === "DIRECTOR") {
          // In the bar, at the trailing end, and reading exactly the one label.
          await expect(restart).toHaveText(demoDay.restart);
          expect(
            await restart.evaluate((el) => {
              const bar = document.querySelector('[role="status"][aria-label="DEMO"]')?.parentElement;
              return bar?.contains(el) ?? false;
            }),
            "the restart is not inside the DEMO bar",
          ).toBe(true);
        }
        // Whoever is looking, there is no second one and no "Start demo day" left anywhere.
        expect(await visibleMatches(page, "Start demo day")).toEqual([]);
        await expect(restart).toHaveCount(ROLE === "DIRECTOR" ? 1 : 0);

        console.log("screenshot:", await shotOf(page, where, width));
      }
    });

    /**
     * TODAY'S STEP STRIP: three cards, each saying what its own step actually stands at, and
     * never a link this role would be bounced from (REDESIGN-SPEC §9.2).
     *
     * The states here are the ones a shell with no database shows — Needed, Needed, Locked —
     * because that is what this run is: a role with no site behind it, so the readiness loader
     * reads nothing and says so rather than claiming anything is done. That makes the whole
     * strip deterministic without a seed and without a flag.
     *
     * A front desk sees all three cards and can open one, so the two they cannot open are plain
     * text rather than links to a 403 — which is why the hrefs are checked against the access
     * table's own answer, through the same function the page renders from.
     */
    test("the step strip is three steps, each saying where that step stands", async ({ page }) => {
      test.skip(!MENU.some((item) => item.href === "/today"), "Today is not on this role's menu");
      await page.goto("/today");
      const strip = page.getByRole("navigation", { name: flow.stepsAria });
      await expect(strip).toBeVisible();
      await expect(strip.locator("li")).toHaveCount(3);

      /*
       * THE SHOT OF THE STRIP, taken here — on Today, before anything is clicked. It used to be
       * taken at the end of this test, after the walk below had clicked through to the last
       * step, so the file called "today-steps" was a picture of the live map (Vera's read of
       * the artifacts). One shot of the strip, then one per destination, each named after what
       * is in it.
       */
      console.log("screenshot:", await shotOf(page, "/today-steps", width));

      // Every card says its step, its state and the one line its own data gives it.
      for (const step of STEPS) {
        const card = strip.locator(`[data-step="${step.key}"]`);
        await expect(card, `no ${step.key} card`).toHaveCount(1);
        await expect(card).toHaveAttribute("data-state", step.state);
        await expect(card).toContainText(step.label);
        await expect(card).toContainText(step.detail);
      }

      // The first card that is not done is the one marked as the step to take next, and it is
      // marked once — a strip with three "do this next" markers says nothing at all.
      const current = strip.locator('[aria-current="step"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute(
        "data-step",
        STEPS.find((step) => step.current)!.key,
      );

      const linkable = STEPS.filter((step) => step.linked);
      const links = strip.getByRole("link");
      await expect(links).toHaveCount(linkable.length);
      const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
      expect(hrefs).toEqual(linkable.map((step) => step.href));

      /*
       * Each link goes where it says, inside the frame — and for a Locked card "where it says"
       * is the step it is waiting on: the live map's card opens Plan routes while nothing is
       * saved, and its accessible name says so rather than surprising the click.
       */
      for (const step of linkable) {
        await page.goto("/today");
        await strip.getByRole("link", { name: step.ariaLabel }).click();
        await page.waitForURL(`**${step.href}`);
        expect(new URL(page.url()).pathname).toBe(step.href);
        await expectFrame(page, width, step.href);
        console.log("screenshot:", await shotOf(page, `/step-${step.key}`, width));
      }
    });

    /**
     * THE WAY BACK. The founder's complaint was that the browser's Back button was the only way
     * out of three screens; the menu is the way out now, and Back has to work as well — a
     * screen that loses its frame when you come back to it is the same dead end one click later.
     */
    test("a menu item opens, and Back lands on the screen it left, with the frame on it", async ({
      page,
    }) => {
      const from = MENU[0].href;
      const to = TABS.find((item) => item.href !== from);
      expect(to, `${ROLE} has only one destination`).toBeDefined();

      await page.goto(from);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const menu = await expectFrame(page, width, from);
      await menu.getByRole("link", { name: to!.label }).click();
      await page.waitForURL(`**${to!.href}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectFrame(page, width, to!.href);

      await page.goBack();
      await page.waitForURL(`**${from}`);
      expect(new URL(page.url()).pathname, "Back did not land on the screen it left").toBe(from);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectFrame(page, width, from);
    });
  });
}

/**
 * THE PHONE'S BAR, at 390: five tabs, the count on Family texts, and nothing to open.
 *
 * Firia, 2026-10-17 8:36 PM ET, over the 6:19 PM menu: five items at every width, so the bar is
 * one tab per item and the fifth slot that opened the rest is deleted with the overflow it
 * existed for. The front desk's two destinations are two tabs, as they always were.
 */
test.describe(`the phone's tab bar, as ${ROLE}`, () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("is one tab per menu item, with the Family texts count on it", async ({ page }) => {
    await page.goto(MENU[0].href);
    const bar = page.locator("[data-tab-bar]");
    await expect(bar).toBeVisible();

    // One tab per item, in the menu's order, and every one a §9 target.
    const tabs = bar.getByRole("link");
    await expect(tabs).toHaveCount(MENU.length);
    expect(MENU.length).toBeLessThanOrEqual(MENU_SIZE);
    expect(await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""))).toEqual(
      MENU.map((item) => item.href),
    );
    for (const tab of await tabs.all()) {
      expect((await tab.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // Nothing to open: no More tab, no sheet, no hamburger (checked at every route above too).
    await expect(bar.locator("[data-more-tab]")).toHaveCount(0);
    await expect(page.locator("[data-more-sheet]")).toHaveCount(0);

    /*
     * THE BADGE (REDESIGN-SPEC §9.2, audit §2 item 2): a Teal disc with white text on Family
     * texts, for the roles that can act on what is waiting — and the count said in words in the
     * tab's own accessible name, because the disc is aria-hidden.
     */
    const waiting = menuBadgeFor("/family-texts", ROLE);
    const badge = bar.locator("[data-menu-badge]");
    if (waiting === null) {
      await expect(badge, `${ROLE} is being shown a count`).toHaveCount(0);
    } else {
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveText(String(waiting));
      const disc = await badge.evaluate((el) => {
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return { bg: s.backgroundColor, ink: s.color, w: Math.round(box.width), h: Math.round(box.height) };
      });
      expect(disc.w).toBe(20);
      expect(disc.h).toBe(20);
      expect(disc.bg).toBe("rgb(15, 118, 110)");
      expect(disc.ink).toBe("rgb(255, 255, 255)");
      const tab = bar.getByRole("link", { name: `${nav.familyTexts}, ${waiting} waiting` });
      await expect(tab).toHaveCount(1);
      expect(await badge.evaluate((el) => el.closest("a")?.getAttribute("href"))).toBe(
        "/family-texts",
      );
    }
    console.log("screenshot:", await shotOf(page, "/tab-bar", 390));
  });

  /**
   * THE ACTIVE TAB (audit §2 item 6): a 2 px Teal top border and a Teal Ink label, and **no
   * tinted block** — production filled the whole tab with the selected tint, which reads as a
   * button being held down rather than as the page you are on.
   */
  test("marks the page you are on with an edge, not a filled block", async ({ page }) => {
    await page.goto(MENU[0].href);
    const current = page.locator("[data-tab-bar] a[aria-current='page']");
    await expect(current).toHaveCount(1);
    const style = await current.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        border: s.borderTopWidth,
        borderColor: s.borderTopColor,
        ink: s.color,
        background: s.backgroundColor,
        weight: s.fontWeight,
      };
    });
    expect(style.border).toBe("2px");
    expect(style.borderColor).toBe("rgb(15, 118, 110)");
    expect(style.ink).toBe("rgb(19, 78, 74)");
    // Transparent, or the surface it sits on — never the selected tint.
    expect(["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"]).toContain(style.background);
    expect(Number(style.weight)).toBeGreaterThanOrEqual(600);
  });
});

/**
 * THE TWO ADDRESSES THAT MOVED — `/exceptions` → `/today` and `/approvals` →
 * `/family-texts?tab=for-you`, both permanent (Firia, 8:36 PM ET; audit §2 item 2).
 *
 * Read off the status line rather than off the screen, with redirects not followed, because 308
 * is the claim: the address has moved for good. Then followed, because where a person *ends* is
 * the other half — and for the front desk that must be a screen they can see (their home, the
 * live map), never "For you" and never a refusal.
 */
test.describe(`the moved addresses, as ${ROLE}`, () => {
  for (const [from, to] of Object.entries(MOVED_PAGES)) {
    if (!["/exceptions", "/approvals"].includes(from)) continue;

    test(`${from} answers for this role without ever 404ing`, async ({ page }) => {
      const canOpen = pageOutcome({ kind: "STAFF", role: ROLE }, from) === "ALLOW";
      // The status line, with the redirect not followed.
      const response = await page.request.get(from, { maxRedirects: 0 });
      expect(response.status(), `${from} answered ${response.status()}`).not.toBe(404);
      if (canOpen) {
        expect(response.status(), `${from} is not a permanent redirect`).toBe(308);
        expect(response.headers()["location"]).toContain(to);
      } else {
        /*
         * A role whose row does not open it never learns where it went: the guard answers
         * first, with a 307 to their own home and the §9.3 notice on it.
         */
        expect(response.status()).toBe(307);
        const location = response.headers()["location"] ?? "";
        expect(location).toContain(homePathFor({ kind: "STAFF", role: ROLE }));
        expect(location, `${from} leaked its destination to ${ROLE}`).not.toContain(
          to.split("?")[0],
        );
      }

      // And where a person actually ends: a screen with this frame on it, never a dead end.
      await page.goto(from);
      const landed = new URL(page.url()).pathname;
      expect(landed).toBe(canOpen ? to.split("?")[0] : homePathFor({ kind: "STAFF", role: ROLE }));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectFrame(page, 1440, landed);
      // The front desk is on a page their own row opens, and it is not the For you queue.
      expect(pageOutcome({ kind: "STAFF", role: ROLE }, landed)).toBe("ALLOW");
      if (!canOpen) expect(page.url()).not.toContain("tab=for-you");
      console.log("screenshot:", await shotOf(page, `/from-${slug(from)}`, 1440));
    });
  }

  /**
   * A typed `?tab=for-you` is refused on the *server* for a role that may not decide, and lands
   * them on their own home — not hidden in the UI (the ID-swap skill, rule 6).
   */
  test("the For you tab refuses a role that may not decide, server-side", async ({ page }) => {
    const allowed = APPROVAL_ROLES.includes(ROLE);
    const response = await page.request.get("/family-texts?tab=for-you", { maxRedirects: 0 });
    if (allowed) {
      expect(response.status()).toBe(200);
      return;
    }
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toContain(homePathFor({ kind: "STAFF", role: ROLE }));
    await page.goto("/family-texts?tab=for-you");
    expect(new URL(page.url()).pathname).toBe(homePathFor({ kind: "STAFF", role: ROLE }));
  });
});
