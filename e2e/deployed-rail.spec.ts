/**
 * THE DIRECTOR'S RAIL ON THE DEPLOYED BUILD — read off the DOM, against a real sign-in.
 *
 * Why this file exists, and why it is not the same check as e2e/nav-rail.spec.ts.
 *
 * The founder screenshotted prod signed in as SYN Dana Director and the rail showed four items:
 * Today · Exceptions & Approvals · Setup · Health & ROI, with no Plan routes. Every unit test
 * passed, and nav-rail.spec.ts passed, because both of them read the same `navItems` list the
 * app reads — a list that was already correct in the commit prod reported.
 *
 * **Why that screenshot showed four items is unproven.** Nobody re-read the rail on the
 * deployment while the screenshot was fresh, and the image carries no commit, no URL and no
 * timestamp, so the candidates were never separated and some of them no longer can be:
 *
 *  - a tab open since before `/plan-routes` reached the rail in production at 4:36 AM ET, still
 *    showing the bundle it loaded then;
 *  - an old per-deployment URL (a Vercel preview or an immutable deployment address), which
 *    serves its own commit for as long as it exists and is not the production alias;
 *  - a screenshot taken well before it was posted, of a production build that predated the rail.
 *
 * All three are consistent with the image, and none of them is a bug in `navItems`. What *is*
 * measurable is the rendered rail on a named deployment, so that is what this file measures:
 * it signs in, reads the rail off the DOM, and reports the commit it read it from. That makes
 * the next screenshot answerable in one run instead of arguable — and it is a guard, not a
 * diagnosis: it fails when a deployment's rail is actually short, whatever the cause.
 *
 * So, deliberately:
 *  - it runs against a **deployment**, named by `E2E_DEPLOYED_URL` (the Vercel preview URL for
 *    the branch, or production). Without it there is nothing to measure and every test skips;
 *  - it signs in with a **real session** — the seeded demo director and the shared demo
 *    password, which /login prints on its own card (`DEMO_SHARED_PASSWORD`, DECISION-LEDGER row
 *    59; synthetic accounts only, ADR-015). Not `E2E_DEMO_ROLE`: that synthetic session is
 *    refused outright whenever `VERCEL_ENV` is set, which is exactly every deployment, and a
 *    session the deployment would refuse could not have caught this;
 *  - the expected rail is **written out here**, not imported from `src/ui/nav-items.ts`. A check
 *    that derives its expectation from the same config the page renders from agrees with the
 *    page by construction and cannot fail the way the screenshot did;
 *  - it reads the rail off the **DOM**: each item's accessible name, its href, and its box,
 *    so "the rail is missing an item" and "the rail is clipping an item" are different failures;
 *  - it reports the **deployed commit** from /api/health first, so a failure says which build
 *    was measured and a passing run dates the evidence.
 *
 * Read-only: it signs in, reads three pages and signs nothing, writes nothing, posts nothing.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { DEMO_ACCOUNTS, DEMO_SHARED_PASSWORD } from "../src/auth/demo-accounts";
import { nav } from "../src/ui/copy";

/** The deployment to measure. Unset locally, so the whole file skips. */
const DEPLOYED = process.env.E2E_DEPLOYED_URL?.replace(/\/$/, "");

/**
 * The commit the deployment is expected to be serving. Defaults to this checkout's `HEAD`,
 * because that is the thing you are usually asking about: "does the build of *my* branch show
 * the rail". `E2E_EXPECTED_COMMIT=` (empty) turns the check off, for measuring production from a
 * branch checkout.
 *
 * This is the assertion that would have *separated* the candidates above. `/plan-routes` reached
 * the rail in bf0d489 and reached production in a9b122e, so a rail read off a build older than
 * a9b122e is that build's correct rail and a rail read off a newer one is a real bug — and only
 * the commit tells the two apart. Naming it turns "the rail is wrong" into either "this
 * deployment is older than the rail" or a failure worth chasing.
 */
const EXPECTED_COMMIT =
  process.env.E2E_EXPECTED_COMMIT ??
  (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  })();

/** Filled by the first test and quoted in every later failure, so a failure dates itself. */
let served = "unknown";

async function deployedCommit(request: { get: (url: string) => Promise<{ json: () => Promise<{ commit?: string }> }> }): Promise<string> {
  const health = await (await request.get(`${DEPLOYED}/api/health`)).json();
  return health.commit ?? "unknown";
}

/**
 * The rail a DIRECTOR must get, in order: §2's four console destinations, with Plan routes and
 * the live map between the board and the exceptions it raises, and the ramp iPad last. Written
 * out on purpose — see the note above.
 */
const DIRECTOR_RAIL = [
  { label: "Today", href: "/today" },
  { label: "Plan routes", href: "/plan-routes" },
  { label: "Live map", href: "/live-map" },
  { label: "Exceptions & Approvals", href: "/exceptions" },
  { label: "Setup", href: "/setup" },
  { label: "Health & ROI", href: "/health" },
  { label: "Ramp iPad", href: "/ramp-ipad" },
] as const;

const DIRECTOR = DEMO_ACCOUNTS.find((a) => a.role === "DIRECTOR") as (typeof DEMO_ACCOUNTS)[number];

/** Signs in on the deployment the way a person does: the sign-in form, then the board. */
async function signInAsDirector(page: Page): Promise<void> {
  await page.goto(`${DEPLOYED}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(DIRECTOR.email);
  await page.locator('input[type="password"]').first().fill(DEMO_SHARED_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  // Sign-in lands on this role's own first page, which for a director is the board.
  await page.waitForURL(`${DEPLOYED}/today`, { timeout: 60_000 });
}

test.describe("the deployed build, as the demo director", () => {
  test.skip(!DEPLOYED, "set E2E_DEPLOYED_URL to the preview or production URL to run this");

  test("says which commit it is serving, and is serving the one under test", async ({ request }) => {
    const health = await (await request.get(`${DEPLOYED}/api/health`)).json();
    served = health.commit ?? "unknown";
    // The evidence is dated: a rail that is missing an item is only a code bug if the build that
    // drew it contains the code.
    console.log(`deployed: commit=${served} branch=${health.branch} env=${health.environment}`);
    expect(typeof health.commit, "the deployment does not report a commit").toBe("string");
    if (EXPECTED_COMMIT) {
      expect(
        served,
        `${DEPLOYED} is serving ${served}, not ${EXPECTED_COMMIT}: whatever its rail shows is that older build's rail, not this branch's`,
      ).toBe(EXPECTED_COMMIT);
    }
  });

  test("reports DIRECTOR for the session it just signed in with", async ({ page }) => {
    await signInAsDirector(page);
    await page.goto(`${DEPLOYED}/whoami`);
    const words = await page.locator("main, body").first().innerText();
    // The role filter is the first thing to rule out when a rail is short: a session that is
    // not a director would correctly be shown a shorter rail.
    expect(words).toContain("DIRECTOR");
    expect(words).toContain(DIRECTOR.name);
  });

  test("renders every one of the director's seven destinations, and clips none of them", async ({
    page,
  }) => {
    await signInAsDirector(page);
    if (served === "unknown") served = await deployedCommit(page.request);

    const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
    await expect(rail).toBeVisible();
    const links = rail.getByRole("link");

    /*
     * Both halves of the founder's question, off the DOM: which items are there, and in what
     * order. `aria-label` is the accessible name the rail puts on every link at every width
     * (src/ui/NavRail.tsx), so this is the name a person is offered, not a config entry.
     */
    const rendered = await links.evaluateAll((els) =>
      els.map((el) => ({
        label: el.getAttribute("aria-label") ?? "",
        href: new URL((el as HTMLAnchorElement).href).pathname,
      })),
    );
    expect(
      { commit: served, rail: rendered },
      "the rail the deployment rendered is not the director's seven",
    ).toEqual({ commit: served, rail: DIRECTOR_RAIL.map((item) => ({ ...item })) });

    // Nothing in the rail says "preview", in its words or in its address (Vera, 2026-10-17).
    for (const item of rendered) {
      expect(item.label).not.toMatch(/preview/i);
      expect(item.href).not.toMatch(/preview/i);
    }

    /*
     * A layout or CSS cutoff is the other way an item goes missing: present in the DOM, off the
     * screen. Every link is laid out, has a real box, and that box is inside the rail's.
     */
    const railBox = await rail.boundingBox();
    expect(railBox, "the rail has no box").not.toBeNull();
    for (const item of DIRECTOR_RAIL) {
      const link = rail.getByRole("link", { name: item.label });
      await expect(link, `${item.label} is not visible in the rail`).toBeVisible();
      const box = await link.boundingBox();
      expect(box, `${item.label} has no box`).not.toBeNull();
      expect(box!.height, `${item.label} is zero-height`).toBeGreaterThan(0);
      expect(box!.y, `${item.label} is above the rail`).toBeGreaterThanOrEqual(railBox!.y - 1);
      expect(
        box!.y + box!.height,
        `${item.label} is cut off the bottom of the rail`,
      ).toBeLessThanOrEqual(railBox!.y + railBox!.height + 1);
    }
  });

  test("opens each of the seven from the rail, on the screen it names", async ({ page }) => {
    await signInAsDirector(page);
    const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
    for (const item of DIRECTOR_RAIL) {
      await page.goto(`${DEPLOYED}/today`);
      await rail.getByRole("link", { name: item.label }).click();
      await page.waitForURL(`${DEPLOYED}${item.href}`, { timeout: 60_000 });
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      /*
       * Each screen's <h1> carries the rail's words, because the rail reads them from that
       * screen's entry in copy.ts. Today is the exception: its heading may only say "Today" on
       * the day that is true of (`board.headingOtherDay`), so it only has to have one.
       */
      if (item.href !== "/today") await expect(heading).toContainText(item.label);
    }
  });
});
