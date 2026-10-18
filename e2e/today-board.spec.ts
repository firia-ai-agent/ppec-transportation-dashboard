/**
 * The Today board and the child drawer, in a real browser (SURF-01 / SURF-02).
 *
 * The unit tests already know which words the board puts on screen. What only a browser can
 * answer is the rest of the design's acceptance list (DESIGN-DIRECTION §10): does a group
 * header stay above its rows when the board is scrolled, does the drawer keep the list in
 * context instead of covering it, does the keyboard walk the board without a mouse, and is the
 * reason a disabled action is disabled actually *visible* rather than merely in the markup.
 * Each one is measured, and the screenshots land in artifacts/ so a design review has the
 * picture next to the assertion.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts and src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment. The board it renders is the committed demo day.
 */
import { expect, test } from "@playwright/test";
import { canOpenPage } from "../src/auth/access";
import type { StaffRole } from "../src/auth/core";
import {
  board as boardCopy,
  demoBanner,
  drawer,
  fill,
  flow,
  nav,
  sentence,
} from "../src/ui/copy";
import { legStates } from "../src/ui/states";
import { demoDay, serviceDayFor } from "../src/domain/board/day";
import { CHILDREN, RUNS } from "../src/modules/demo/fixtures/standard";
import { demoDateIso } from "../src/ui/service-date";
import {
  boxOf,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectPageHeaderBar,
  expectVioletOnlyOnDemoChrome,
  overlaps,
  shot,
} from "./helpers";

/**
 * ONE RUN IS ONE ROLE (`E2E_DEMO_ROLE`, playwright.config.ts), and the board is not every
 * role's: /today is the coordinator's and the director's (src/auth/access.ts). A front desk who
 * types the address is sent to their own home with the §9.3 notice, so every test below would
 * be measuring the live map instead. They are skipped by name rather than deleted — that
 * redirect is e2e/role-pages.spec.ts's subject, and it is measured there.
 */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;
const OPENS_BOARD = canOpenPage({ kind: "STAFF", role: ROLE }, "/today");

test.beforeEach(() => {
  test.skip(!OPENS_BOARD, `${ROLE} does not open the board`);
});

/** The review's two widths: the icon rail lives at 1024, the labelled rail at 1280. */
const WIDTHS = [1024, 1280] as const;
const VIEWPORT = { height: 900 };

/** The child the scenario gives no authorized receiving adult, and one on a van that is moving. */
const NO_RECEIVER_CHILD = "Noah O.";
const RIDING_CHILD = "Zoe B.";

/**
 * The day before the demo day, which the scenario drove to the end: every ride on it has an
 * outcome, including the one that ended holding a child (AT-13) and the one whose van arrived
 * and was never handed over (AT-10).
 *
 * Reached by URL, which is now the only way: the console has no date switcher in it (Vera's
 * final call), so this is a review and test path and never something a coordinator lands on.
 *
 * And it is a test path in the code as well as in the design (Veri #49): the server reads
 * `?date=` at all only because playwright.config.ts sets `E2E_DATE_OVERRIDE=1` on a local
 * synthetic shell. The same gate is refused wherever `VERCEL_ENV` is set — every deployment —
 * so this URL is the demo day in production, and the unit tests hold that
 * (src/domain/board/day.test.ts).
 */
const FINISHED = serviceDayFor(demoDay().previousIso);
const FINISHED_URL = `/today?date=${FINISHED.iso}`;

/**
 * One row per child and ride: the seeded children, each with a morning row and an afternoon one
 * (AT-07). **Derived, not written down** — the census is the seed's and the seed changed: twelve
 * children where there were twenty-eight ("Firia 8:02 PM seed ruling";
 * src/modules/demo/fixtures/standard.ts:273 `BOARD_CENSUS`, which `CHILDREN` is built to). The
 * board renders a row per child and a leg per direction, so the count is the census doubled —
 * asserted exactly, as before.
 */
const RIDES = CHILDREN.length * 2;

/**
 * The rows "Only needs action" leaves on the demo day, **derived from the seed**, not written
 * down:
 *  - Van 3's riders, one morning row each. R3 is Van 3's run (src/modules/demo/fixtures/
 *    standard.ts:352, `childKeys: ["C1", "C4", "C5"]`), and its all-ambulatory layout has two
 *    tether-capable seats for three children who all ride anchored (standard.ts:424-427), so the
 *    solver says the van does not fit them and each morning ride is "Does not fit". Their
 *    afternoon rides are not flagged on top of that.
 *  - Noah O.'s afternoon ride (`NO_RECEIVER_CHILD`): F2 holds every scope except RECEIVE_CHILD
 *    (standard.ts:163 `NO_RECEIVER_SCOPES`, :182), so nobody on file may receive him (AT-13).
 *    His morning ride needs nothing.
 */
const VAN3_RIDERS = (RUNS.find((run) => run.vehicleKey === "V3")?.childKeys ?? []).map(
  (key) => CHILDREN.find((child) => child.key === key)?.label ?? key,
);
const NEEDS_ACTION_ROWS = VAN3_RIDERS.length + 1;

/** One row's opener: a child and which of their two rides this row is. */
const opener = (child: string, ride: string = boardCopy.amSpoken) =>
  fill(boardCopy.openRow, { child, ride }) as string;

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, ...VIEWPORT } });

    test("the board groups the day, needs action first, and keeps its headers in view", async ({
      page,
    }) => {
      await page.goto("/today");
      await expect(page.getByRole("heading", { level: 1, name: boardCopy.heading })).toBeVisible();
      await expectDemoBarPinned(page);

      // §4.1: needs action is the first group, and every group header carries its count.
      const headers = page.locator("th[scope='colgroup']");
      const texts = await headers.allInnerTexts();
      expect(texts.length).toBeGreaterThan(1);
      expect(texts[0]).toContain(boardCopy.groups.NEEDS_ACTION);
      for (const text of texts) expect(text).toMatch(/\(\d+\)$/);

      // One row per child and ride: the whole census, both halves of every day (AT-07).
      const openers = page.getByRole("button", { name: /^Open / });
      await expect(openers).toHaveCount(RIDES);
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toBeVisible();
      await expect(
        page.getByRole("button", { name: opener(RIDING_CHILD, boardCopy.pmSpoken) }),
      ).toBeVisible();

      // Every ride says when it arrives, the afternoon included: no row on the board is still
      // waiting for its window to be worked out.
      await expect(page.getByText(boardCopy.windowPending)).toHaveCount(0);
      await expect(page.getByText(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/).first()).toBeVisible();

      // D-5: the violet is the DEMO bar and the Simulated chip, and nothing else on the board.
      await expectVioletOnlyOnDemoChrome(page);

      /*
       * The group header is sticky (§4.1). Scrolled to the bottom of the board, the last
       * group's header is still on screen rather than scrolled off with its first row — which
       * is the whole reason a dense board groups at all.
       */
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      await expect(headers.last()).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, 0));

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `today-board-${width}`));
    });

    test("a row says what is happening in words, not in colour alone", async ({ page }) => {
      await page.goto("/today");
      // This child's *morning* row: their afternoon is a row of its own, in another group.
      const row = page
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: opener(RIDING_CHILD) }) });

      // §3: icon + label, always. The label is the §3 string, verbatim.
      await expect(row.getByText(legStates.EN_ROUTE_PICKUP.label).first()).toBeVisible();
      // §4.1: the window the family holds, and how far today has moved it.
      await expect(row.getByText(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/).first()).toBeVisible();
      // Every chip on the row carries a label beside its icon, so the row reads in greyscale.
      // `:visible` because below 1280 three cells leave the row for the drawer (§4.1).
      for (const chip of await row.locator("[data-tone]:visible").all()) {
        expect((await chip.innerText()).trim(), "a state chip with an icon and no label").not.toBe("");
        await expect(chip.locator("svg")).toHaveCount(1);
      }
      // Nobody has reported anything on the live board yet, so nothing on it is handed off.
      await expect(page.getByText(/handed off/i)).toHaveCount(0);
    });

    /**
     * AT-10, measured where both answers are on one board.
     *
     * The finished day has a van that reached a kerb with no custody event recorded, and ten
     * rides a person did receive. The rule is the difference between them, so this test is
     * written as that difference: the arrived row says "Arrived (vehicle)" and asks for the
     * handoff, the received rows say who received the child, and the count of handoffs on the
     * whole board is exactly the number of custody events the day recorded. Make the projection
     * read an arrival as a handoff and the arrived row changes, the step disappears and the
     * count goes up — three assertions, not one, because the mutation has to be caught wherever
     * it is made.
     */
    test("a van that arrived is not a child handed over (AT-10)", async ({ page }) => {
      await page.goto(`${FINISHED_URL}&q=Zoe`);

      const arrived = page
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: opener(RIDING_CHILD, boardCopy.pmSpoken) }) });
      await expect(arrived.getByText(legStates.ARRIVED_DROPOFF.label).first()).toBeVisible();
      // The row that merely arrived says nothing about a handoff, in any of its cells.
      await expect(arrived.getByText(/handed off/i)).toHaveCount(0);

      // The morning of the same child was received at the centre, and names where.
      const handedOff = page
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: opener(RIDING_CHILD) }) });
      await expect(
        handedOff
          .getByText(
            fill(legStates.COMPLETED_HANDOFF.label, { "receiver role": boardCopy.receivedByRamp }),
            { exact: true },
          )
          .first(),
      ).toBeVisible();

      // Whole-board count: a handoff on screen for every custody event the day recorded, and
      // not one more. Eleven rides ran that day; ten of them were received by a person.
      await page.goto(FINISHED_URL);
      await expect(page.getByText(/^Handed off to /)).toHaveCount(10);
      await expect(page.getByText(legStates.ARRIVED_DROPOFF.label, { exact: true })).toHaveCount(1);

      /*
       * And the control that would commit one. The van is there and an adult is on file, so the
       * day has nothing left to ask — the button is still unavailable, and the reason it gives
       * is this build's, not a pretend one about the van not having arrived (§1 honesty).
       */
      await page.getByRole("button", { name: opener(RIDING_CHILD, boardCopy.pmSpoken) }).click();
      const panel = page.getByRole("dialog");
      // The panel is about the day it was opened from, and says so rather than "Today's rides":
      // it covers the board's own header, so it is read with no date in sight (Veri #49).
      await expect(
        panel.getByRole("heading", {
          name: fill(drawer.ridesHeadingOtherDay, { date: FINISHED.label }),
        }),
      ).toBeVisible();
      await expect(panel.getByText(drawer.ridesHeading, { exact: true })).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: fill(drawer.confirmHandoff, { child: RIDING_CHILD }) }),
      ).toBeDisabled();
      await expect(panel.getByText(drawer.handoffBlockedNotConnected)).toBeVisible();
      await expect(
        panel.getByText(fill(drawer.handoffBlockedNotArrived, { child: RIDING_CHILD })),
      ).toHaveCount(0);
      console.log("screenshot:", await shot(page, `today-arrival-not-handoff-${width}`));
    });

    /**
     * …and on a day that is over, that same van is a thing somebody has to do.
     *
     * The state is right either way — "Arrived (vehicle)", never a handoff — but the group it
     * sits in is a claim too. Under "On the way" on a board whose vans are all back in the yard
     * it reads as a ride still in progress, and worse, it was not in "Only needs action", which
     * is the view a coordinator closing out the day works from: the last unrecorded handoff of
     * the day was the one row nobody was told about. So it is walked here through the filter,
     * which is the measurement that would catch it coming back.
     */
    test("a handoff nobody recorded is needs action once the day is over", async ({ page }) => {
      await page.goto(FINISHED_URL);
      const headers = page.locator("th[scope='colgroup']");
      await expect(headers.first()).toContainText(boardCopy.groups.NEEDS_ACTION);

      // Two rides need a person on that day: the held child, and this arrival nobody closed.
      const toggle = page.getByRole("switch");
      await expect(toggle).toContainText(
        fill(boardCopy.groupHeading, { group: boardCopy.onlyNeedsAction, count: 2 }),
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(
        page.getByText(fill(boardCopy.showing, { shown: 2, total: RIDES })),
      ).toBeVisible();

      // The afternoon row is in it; the morning of the same child was received and is not.
      const arrived = page.getByRole("button", {
        name: opener(RIDING_CHILD, boardCopy.pmSpoken),
      });
      await expect(arrived).toBeVisible();
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }),
      ).toBeVisible();

      // The row still says what the van did and no more, and the panel says why it is in here.
      const row = page.getByRole("row").filter({ has: arrived });
      await expect(row.getByText(legStates.ARRIVED_DROPOFF.label).first()).toBeVisible();
      await expect(row.getByText(/handed off/i)).toHaveCount(0);
      await arrived.click();
      const panel = page.getByRole("dialog");
      await expect(
        panel
          .getByText(fill(boardCopy.reasons.HANDOFF_UNRECORDED, { child: RIDING_CHILD }), {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await expect(
        panel
          .getByText(sentence(fill(boardCopy.nextSteps.CONFIRM_HANDOFF, { child: RIDING_CHILD })), {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      console.log("screenshot:", await shot(page, `today-unrecorded-handoff-${width}`));
    });

    /**
     * AT-13: a ride that **ended** with nobody on file to receive the child.
     *
     * The afternoon van reached Noah O.'s stop, no adult on file may receive him and no custody
     * event was recorded, so the leg machine's only remaining edge was HELD_NO_RECEIVER. What
     * the board has to carry is the part a coordinator cannot be left to assume: he is waiting
     * with the van, and nothing is bringing him back on its own (PRD §6.6 CA-04).
     *
     * Walked on the **demo day**, with no `?date=` in the URL (Vera, 2026-10-16): the console
     * has no date switcher, so a story that lived only on the day before the demo day was a
     * story nobody on the walk could reach.
     */
    test("a ride that ends held, with no automatic return (AT-13)", async ({ page }) => {
      await page.goto("/today?q=Noah");

      const held = page
        .getByRole("row")
        .filter({
          has: page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }),
        });
      await expect(held.getByText(legStates.HELD_NO_RECEIVER.label).first()).toBeVisible();
      // It is a held child, not a handed-over one, and not a van still on its way.
      await expect(held.getByText(/handed off/i)).toHaveCount(0);
      // Needs action, first group on the board (§4.1).
      const headers = page.locator("th[scope='colgroup']");
      await expect(headers.first()).toContainText(boardCopy.groups.NEEDS_ACTION);

      const reason = fill(boardCopy.reasons.CHILD_HELD, { child: NO_RECEIVER_CHILD });
      const step = sentence(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: NO_RECEIVER_CHILD }));
      if (width >= 1280) {
        await expect(page.getByText(step, { exact: true })).toBeVisible();
      }

      // The drawer: the day read as one day, with the hold on the afternoon row and the rule
      // about no automatic return said out loud.
      await page
        .getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) })
        .click();
      const panel = page.getByRole("dialog");
      await expect(panel.getByText(legStates.HELD_NO_RECEIVER.label).first()).toBeVisible();
      await expect(panel.getByText(reason).first()).toBeVisible();
      await expect(panel.getByText(step).first()).toBeVisible();
      await expect(
        panel.getByText(fill(drawer.heldNoReturn, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      // The morning of the same child is its own ride, in its own state: one held ride is not a
      // held day (AT-07). On the demo day that ride is still on the road, and nothing anywhere
      // in the panel says this child was handed over.
      await expect(panel.getByText(legStates.EN_ROUTE_PICKUP.label).first()).toBeVisible();
      await expect(panel.getByText(/handed off/i)).toHaveCount(0);
      // Nothing on this screen can move it: the one action that would is unavailable, and says
      // which person has to answer first.
      await expect(
        panel.getByRole("button", {
          name: fill(drawer.confirmHandoff, { child: NO_RECEIVER_CHILD }),
        }),
      ).toBeDisabled();
      await expect(
        panel.getByText(fill(drawer.handoffBlockedNoReceiver, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();

      await expectNoInternalCodes(page);
      await expectVioletOnlyOnDemoChrome(page);
      console.log("screenshot:", await shot(page, `today-held-no-receiver-${width}`));
    });

    /**
     * §2, Vera's final call: **one** date on screen, and it is the replayed demo day, labelled
     * as the demo day. Not today's real date — the chrome carries no date at all — and not a
     * date anything on screen can change: there is no switcher, so a coordinator cannot be
     * looking at a day they did not mean to be looking at.
     */
    test("the board shows one date, the demo day, and nothing offers another", async ({
      page,
    }) => {
      await page.goto("/today");
      await expect(page.getByRole("heading", { level: 1, name: boardCopy.heading })).toBeVisible();

      /*
       * The one date, and only the date: "Sat, Oct 17". The words are the day the demo is being
       * *given* on — the scenario replays a seeded Wednesday and every screen re-dates it
       * (Firia, 2026-10-17 4:50 PM ET; src/ui/service-date.ts) — and the `datetime` attribute
       * says the same day the words do, which is the whole of that ruling.
       *
       * The "Service date" label and the "Demo day" tag that used to flank it are gone (Firia,
       * 7:55 PM ET), so they are checked for by absence: one of them labelled the only date in
       * the app, the other repeated the DEMO bar above every screen.
       */
      const dates = page.locator("time[datetime]");
      await expect(dates).toHaveCount(1);
      await expect(dates).toHaveText(demoDay().label);
      await expect(dates).toHaveAttribute("datetime", demoDateIso(demoDay().iso));
      await expect(page.getByText("Service date", { exact: true })).toHaveCount(0);
      // Exact, because the DEMO bar's one control reads "Restart demo day" and is not this tag.
      await expect(page.getByText("Demo day", { exact: true })).toHaveCount(0);

      /*
       * The real date is the one the board shows now, so this is the check it has become: if
       * the mapping ever stopped happening, the fixture's own day would be on screen instead
       * and `realToday !== demoDay().label` would be true — and the board would be printing a
       * date that is not today, which is what the walk caught.
       */
      const realToday = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(new Date());
      if (realToday !== demoDay().label) {
        await expect(page.getByText(realToday)).toHaveCount(0);
      }

      /*
       * No switcher: no control, link or arrow on the *board* that reaches another service date.
       *
       * The step strip above it (redesign spec §9.2) does carry `?date=` on each of its three
       * cards, and that is the opposite of a switcher: it is how Van setup, Plan routes and Live
       * map open on the day a person is already looking at (§9.3's deep-link rule). So the count
       * is of date links outside it.
       */
      const dateLinksOutsideTheStrip = await page.evaluate((label) => {
        const strip = document.querySelector(`nav[aria-label="${label}"]`);
        return Array.from(document.querySelectorAll("a[href*='date=']")).filter(
          (link) => !strip?.contains(link),
        ).length;
      }, flow.stepsAria);
      expect(dateLinksOutsideTheStrip).toBe(0);
      for (const name of [/previous day/i, /next day/i]) {
        await expect(page.getByRole("link", { name })).toHaveCount(0);
        await expect(page.getByRole("button", { name })).toHaveCount(0);
      }

      // Nothing on the live day has been handed over: no ride on it has a custody event, so no
      // row may say one happened. The one outcome it does carry is the AT-13 hold, which is on
      // this board on purpose and walked by the test above.
      await expect(page.getByText(/handed off/i)).toHaveCount(0);
      await expect(page.getByText(legStates.HELD_NO_RECEIVER.label).first()).toBeVisible();
      console.log("screenshot:", await shot(page, `today-one-date-${width}`));
    });

    /**
     * The finished day, reached the only way it can be now: by URL. There is no control on the
     * board that goes here (the test above holds that), and this is the day AT-13 and AT-10 are
     * read on — so the board still has to be about the day it names rather than about today.
     *
     * **Where the day is named moved**, and that is audit §2 item 1: the board's own `<h1>` is
     * deleted and the screen's one title is the frame's page header bar, which prints that
     * screen's label from the access table — "Today", the name of the screen, on every day. So
     * the h1 this test used to read ("Rides on Fri, Oct 16") is not coming back: one title per
     * screen, and it is the screen's name.
     *
     * What names the *day* is the board's date readout beside it, and that is what is asserted
     * instead — the words, the machine-readable attribute, and the screen-reader caption before
     * the first row, which is the one place a reader who cannot see the readout is told. This
     * address is a test path besides (`E2E_DATE_OVERRIDE`, refused wherever `VERCEL_ENV` is
     * set), so no deployment can be on a day the title does not match.
     */
    test("a day asked for by URL is the day the board names", async ({ page }) => {
      await page.goto(FINISHED_URL);
      // The frame's one title, and it is the screen's name rather than the day.
      await expect(page.getByRole("heading", { level: 1, name: nav.today })).toBeVisible();
      await expectPageHeaderBar(page);
      // The day, in the readout the mockup draws beside it: the words and the attribute agree.
      const readout = page.locator("time[datetime]");
      await expect(readout).toHaveText(FINISHED.label);
      await expect(readout).toHaveAttribute("datetime", demoDateIso(FINISHED.iso));
      // ...and said once more for the ear, before the first row (`onDay`, Veri #49).
      await expect(page.locator("table caption")).toHaveText(
        fill(boardCopy.tableLabelOtherDay, { date: FINISHED.label }),
      );
      // …and that day's rides are the finished ones.
      await expect(page.getByText(/^Handed off to /).first()).toBeVisible();
    });

    /**
     * The "Next step" column, which is the taste rule this board was re-cut for: a step is a
     * thing to do, written as a verb and the name of the child it is done for — never a role.
     */
    test("every row says what to do next, as a verb and a child's name", async ({ page }) => {
      await page.goto("/today");
      const step = sentence(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: NO_RECEIVER_CHILD }));

      if (width >= 1280) {
        await expect(page.getByText(step, { exact: true })).toBeVisible();
        // The adult who receives a child is named on the row, not described.
        await expect(
          page.getByText(fill(boardCopy.receiverNamed, { adult: "Alma R." })).first(),
        ).toBeVisible();
        await expect(page.getByText(boardCopy.noReceiver).first()).toBeVisible();
        // The role names the column used to carry are gone from the board.
        for (const role of ["Coordinator", "Front desk"]) {
          await expect(page.getByRole("cell", { name: role, exact: true })).toHaveCount(0);
        }
      } else {
        // §4.1 folds this column into the drawer below 1280, so that is where it has to be.
        await page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }).click();
        // Exact: the panel carries other sentences about the same child and the same contacts.
        await expect(page.getByRole("dialog").getByText(step, { exact: true })).toBeVisible();
      }
    });

    test("the keyboard walks the board and opens a child, with focus visible throughout", async ({
      page,
    }) => {
      await page.goto("/today");
      const first = page.getByRole("button", { name: /^Open / }).first();
      await first.focus();
      const firstName = await first.getAttribute("aria-label");

      // §4.1: J and K move between children.
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      );
      expect(afterJ).not.toBe(firstName);
      await page.keyboard.press("k");
      const afterK = await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      );
      expect(afterK).toBe(firstName);

      // …and Enter opens the child, which is also what the button does with a mouse.
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("the drawer keeps the board in context and explains its disabled action", async ({
      page,
    }) => {
      await page.goto("/today");
      await page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) }).click();

      const panel = page.getByRole("dialog");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: NO_RECEIVER_CHILD })).toBeVisible();

      /*
       * Both of the child's rides, read as one day — which is what the drawer is for, and why
       * they are rows and not cards: a time column, where the ride runs between, and the state
       * as an icon and a label, morning above afternoon.
       */
      const rides = panel.locator("ol > li");
      await expect(rides).toHaveCount(2);
      for (const heading of [drawer.amRide, drawer.pmRide]) {
        await expect(panel.getByText(heading, { exact: true })).toBeVisible();
      }
      await expect(rides.first().getByText(/^\d{1,2}:\d{2} [AP]M$/)).toBeVisible();
      await expect(
        rides.first().getByText(fill(drawer.rideFromTo, { from: "Okeeheelee Park", to: "PPEC center" })),
      ).toBeVisible();
      await expect(
        rides.last().getByText(fill(drawer.rideFromTo, { from: "PPEC center", to: "Okeeheelee Park" })),
      ).toBeVisible();
      for (const ride of await rides.all()) {
        await expect(ride.locator("[data-tone]").first()).toBeVisible();
      }
      // Morning above afternoon: the order is the information, so it is a laid-out fact.
      const [morning, afternoon] = [await boxOf(rides.first()), await boxOf(rides.last())];
      expect(morning.y).toBeLessThan(afternoon.y);

      // §4.2: the sections, in the order the design fixes them.
      for (const heading of [
        drawer.ridesHeading,
        drawer.needsHeading,
        drawer.capabilityHeading,
        drawer.receiverHeading,
      ]) {
        await expect(panel.getByRole("heading", { name: heading })).toBeVisible();
      }

      /*
       * §4.2: one primary action, disabled, and the reason beside it in text rather than in a
       * tooltip only — so it is readable without a pointer and by a screen reader. This child
       * has nobody on file who may receive them, which is the thing to fix first.
       */
      const confirm = panel.getByRole("button", {
        name: fill(drawer.confirmHandoff, { child: NO_RECEIVER_CHILD }),
      });
      await expect(confirm).toBeDisabled();
      await expect(
        panel.getByText(fill(drawer.handoffBlockedNoReceiver, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      await expect(
        panel.getByText(fill(drawer.receiverMissing, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      // §1 "name the person": no sentence in here stands in for a name with "this child".
      await expect(panel.getByText(/this child/i)).toHaveCount(0);

      // §9: a transport need is never a diagnosis, and the caption says so on screen.
      await expect(panel.getByText(drawer.needsCaption)).toBeVisible();

      /*
       * §4.2 "overlay, keeps list context": the drawer must not sit on the column that names
       * the children, or opening one child hides every other.
       */
      if (width >= 768) {
        const panelBox = await boxOf(panel);
        const other = page.getByRole("button", { name: opener(RIDING_CHILD) });
        expect(
          overlaps(await boxOf(other), panelBox),
          "the drawer covers the row that opens another child",
        ).toBe(false);
      }

      // §7: the DEMO bar owns the top of every screen, drawer open included.
      const bar = page.getByRole("status", { name: "DEMO" });
      await expect(bar).toBeVisible();
      expect(overlaps(await boxOf(bar), await boxOf(panel))).toBe(false);

      await expectNoInternalCodes(page);
      await expectVioletOnlyOnDemoChrome(page);
      console.log("screenshot:", await shot(page, `today-drawer-${width}`));

      await panel.getByRole("button", { name: drawer.close }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    /**
     * §4.2 / §9: and the disabled action has to *look* disabled.
     *
     * "Override with reason" was drawn in `ink-muted` inside a `border-strong` box on the panel's
     * own surface — 7.58:1 text in a crisp outline, which is exactly how an enabled secondary
     * button is drawn, so the only thing saying it was unavailable was the attribute. This reads
     * the computed colours the browser actually painted and holds them to the inert tokens: the
     * fill, the text and the hairline all drop together, and the contrast comes out lower than
     * the live control beside it.
     */
    test("an unavailable action is drawn as unavailable, not only marked as one", async ({
      page,
    }) => {
      await page.goto("/today");
      await page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) }).click();
      const panel = page.getByRole("dialog");

      const override = panel.getByRole("button", {
        name: fill(drawer.overrideWithReason, { child: NO_RECEIVER_CHILD }),
      });
      await expect(override).toBeDisabled();

      const painted = await override.evaluate((el) => {
        const s = getComputedStyle(el);
        const root = getComputedStyle(document.documentElement);
        const token = (name: string) => root.getPropertyValue(name).trim();
        return {
          color: s.color,
          background: s.backgroundColor,
          border: s.borderTopColor,
          cursor: s.cursor,
          tokens: {
            fg: token("--color-disabled-fg"),
            bg: token("--color-disabled-bg"),
            line: token("--color-disabled-border"),
            strong: token("--color-border-strong"),
            inkMuted: token("--color-ink-muted"),
            surface: token("--color-surface"),
          },
        };
      });

      // The hexes are the tokens' own: src/ui/tokens.ts is the only place a colour is written.
      const rgb = (hex: string) => {
        const h = hex.replace("#", "");
        return `rgb(${[0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ")})`;
      };
      expect(painted.color).toBe(rgb(painted.tokens.fg));
      expect(painted.background).toBe(rgb(painted.tokens.bg));
      expect(painted.border).toBe(rgb(painted.tokens.line));
      expect(painted.cursor).toBe("not-allowed");
      // And it is no longer dressed as the enabled secondary it used to look like.
      expect(painted.border).not.toBe(rgb(painted.tokens.strong));
      expect(painted.color).not.toBe(rgb(painted.tokens.inkMuted));
      expect(painted.background).not.toBe(rgb(painted.tokens.surface));

      // The one primary action is dressed the same way, and never in the brand colour.
      const confirm = panel.getByRole("button", {
        name: fill(drawer.confirmHandoff, { child: NO_RECEIVER_CHILD }),
      });
      await expect(confirm).toBeDisabled();
      const primary = await confirm.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      expect(primary).toEqual({ color: painted.color, background: painted.background });

      // §9: the reason beside them keeps its full contrast — nothing about *why* is dimmed.
      const reason = panel.getByText(
        fill(drawer.handoffBlockedNoReceiver, { child: NO_RECEIVER_CHILD }),
      );
      await expect(reason).toBeVisible();
      expect(await reason.evaluate((el) => getComputedStyle(el).color)).not.toBe(painted.color);

      /*
       * And the override has a reason of its own, under its own button (Vera, 2026-10-16): the
       * line above belongs to the handoff, and standing alone beside this control it read as the
       * child's missing receiver being what stops an override. This one says what does.
       */
      const ownReason = panel.getByText(drawer.overrideDisabled);
      await expect(ownReason).toBeVisible();
      const [override_, reasonBox] = [await boxOf(override), await boxOf(ownReason)];
      expect(reasonBox.y, "the override's reason sits under its button").toBeGreaterThan(
        override_.y,
      );
      expect(await ownReason.evaluate((el) => getComputedStyle(el).color)).not.toBe(painted.color);

      /*
       * Hovering it changes nothing. A pointer that lights a control up is an offer, and there
       * is nothing here to accept: the fill, the text and the hairline stay exactly where the
       * inert tokens put them, and the cursor keeps saying so.
       */
      await override.hover({ force: true });
      const hovered = await override.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          color: s.color,
          background: s.backgroundColor,
          border: s.borderTopColor,
          cursor: s.cursor,
        };
      });
      expect(hovered).toEqual({
        color: painted.color,
        background: painted.background,
        border: painted.border,
        cursor: painted.cursor,
      });

      console.log("screenshot:", await shot(page, `today-disabled-action-${width}`));
    });

    test("the needs-action filter narrows the board and says how much of it is left", async ({
      page,
    }) => {
      await page.goto("/today");
      const toggle = page.getByRole("switch");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      /*
       * One row per ride, not per child (see NEEDS_ACTION_ROWS): Van 3's three riders on their
       * morning rides, which do not fit the van, and Noah O.'s afternoon ride, the one nobody on
       * file may receive him off (AT-13). His morning ride needs nothing, so it is not in here,
       * and neither is a child whose van is simply on the road.
       */
      expect(VAN3_RIDERS, "the seed's Van 3 riders").toEqual(["Mia R.", "Ava N.", "Eli N."]);
      for (const child of VAN3_RIDERS) {
        await expect(page.getByRole("button", { name: opener(child) })).toBeVisible();
      }
      await expect(
        page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.amSpoken) }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toHaveCount(0);
      await expect(
        page.getByText(fill(boardCopy.showing, { shown: NEEDS_ACTION_ROWS, total: RIDES })),
      ).toBeVisible();

      console.log("screenshot:", await shot(page, `today-needs-action-${width}`));
    });

    /** An empty board says which kind of empty it is, and ends in the way out of it. */
    test("a filter that hides everything says so, and says how to undo it", async ({ page }) => {
      await page.goto("/today?q=no+child+is+called+this");
      await expect(
        page.getByText(fill(boardCopy.emptySearch, { query: "no child is called this" })),
      ).toBeVisible();
      // Not the "no rides today" line: the day has its rides, they just do not match.
      await expect(page.getByText(/No rides scheduled/)).toHaveCount(0);
      await expect(page.locator("table")).toHaveCount(0);

      await page.getByRole("link", { name: boardCopy.clearSearch }).click();
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(RIDES);
    });

    test("the header's search box filters the board it was always meant to", async ({ page }) => {
      await page.goto("/today");
      await page.getByRole("searchbox").fill("Zoe");
      await page.getByRole("searchbox").press("Enter");
      await page.waitForURL(/\/today\?q=Zoe/);

      // A child's name brings back their whole day: both rides, still one row each.
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(2);
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toBeVisible();
      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toHaveCount(0);
      await page.getByRole("link", { name: boardCopy.clearSearch }).click();
      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toBeVisible();
    });
  });
}

/**
 * THE PAGE DOES NOT SCROLL SIDEWAYS — the board at a phone width, and at the width where the
 * icon rail starts.
 *
 * Veri's gate on #74, measured at 390 px: `document.documentElement.scrollWidth` was 766 on a
 * 390 px window, `scrollTo` reached `scrollX` 376, and the frame went with it — the DEMO bar,
 * the tab bar and the step strip all slid off the left-hand edge, which is §10's "no horizontal
 * scroll" failing in the one place a founder opens the app on a phone. The board's nine columns
 * of chips genuinely do not fit 390 px and a chip may not wrap (audit §4.1), so the answer is
 * not "make it fit": it is that the **table** carries the scrollbar and the page does not
 * (src/app/(app)/today/today.module.css).
 *
 * So three things are measured here, in the browser, at both widths:
 *  - the document is no wider than the window — the whole claim, in one number;
 *  - the table still has its columns, inside its own scroll box, below 1024 — otherwise "no
 *    sideways scroll" could be met by hiding half the board;
 *  - and after a scroll in *both* directions the chrome is still on screen: the DEMO bar at the
 *    top (NFR-09) and the menu this width draws — the tab bar on a phone, the rail at the desk.
 */
for (const width of [390, 1024] as const) {
  test.describe(`the board's frame at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 } });

    test("the page does not scroll sideways, and the frame stays on screen", async ({ page }) => {
      await page.goto("/today");
      await expect(page.getByRole("heading", { level: 1, name: boardCopy.heading })).toBeVisible();
      const viewport = page.viewportSize() ?? { width, height: 900 };

      const page_ = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        window: window.innerWidth,
      }));
      expect(page_.doc, `the document is ${page_.doc}px wide in a ${width}px window`).toBeLessThanOrEqual(
        viewport.width,
      );
      expect(page_.body, "the body is wider than the window").toBeLessThanOrEqual(viewport.width);

      /*
       * The columns are still there, and below 1024 the table is the thing that scrolls. Both
       * halves: a board that answered "no sideways scroll" by dropping its chip columns would
       * pass the number above and fail the day.
       */
      const table = page.locator("table");
      await expect(table).toHaveCount(1);
      const box = await table.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
        columns: el.querySelectorAll("thead th").length,
      }));
      expect(box.columns, "the board has lost columns").toBeGreaterThanOrEqual(6);
      expect(box.clientWidth, "the table is wider than the window").toBeLessThanOrEqual(
        viewport.width,
      );
      if (width < 1024) {
        expect(box.overflowX, "the table is not its own scroll box").toBe("auto");
        expect(box.scrollWidth, "the table has nothing to scroll").toBeGreaterThan(box.clientWidth);
      }

      /*
       * And the chrome, after asking the window to scroll both ways: the DEMO bar is pinned at
       * the top and the menu this width draws is on screen. `scrollTo` with an x of 2000 is the
       * founder's swipe — on a page that overflows it took the frame with it.
       */
      await page.evaluate(() => window.scrollTo(2000, document.body.scrollHeight));
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => Math.round(window.scrollX)), "the page scrolled sideways").toBe(0);
      const bar = page.getByRole("status", { name: demoBanner.ariaLabel });
      await expect(bar).toBeInViewport();
      expect((await boxOf(bar)).y, "the DEMO bar is not at the top of the window").toBeLessThan(40);
      const menu =
        width < 768
          ? page.locator("[data-tab-bar]")
          : page.getByRole("navigation", { name: nav.landmarkLabel });
      await expect(menu).toBeInViewport();
      const menuBox = await boxOf(menu);
      expect(menuBox.x, "the menu has slid off the left-hand edge").toBeGreaterThanOrEqual(0);
      expect(
        menuBox.x + menuBox.width,
        "the menu has slid off the right-hand edge",
      ).toBeLessThanOrEqual(viewport.width + 1);

      await page.evaluate(() => window.scrollTo(0, 0));
      console.log("screenshot:", await shot(page, `today-frame-${width}`));
    });
  });
}
