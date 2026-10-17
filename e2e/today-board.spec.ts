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
import { board as boardCopy, drawer, fill, sentence, serviceDate } from "../src/ui/copy";
import { legStates } from "../src/ui/states";
import { demoDay, serviceDayFor } from "../src/domain/board/day";
import {
  boxOf,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  overlaps,
  shot,
} from "./helpers";

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

/** The 28 children of the standard scenario, each with a morning row and an afternoon row. */
const RIDES = 56;

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

      /*
       * §4.1: the groups are stacked in their fixed order with their counts, needs action first
       * wherever there is one. On this board there is none — it is read twelve minutes into the
       * morning and every ride on it is either under way or still ahead of the clock (Vera,
       * 2026-10-17) — so the first header is the next group down, and the absent group is absent
       * rather than a header over nothing. The finished day is where the first-group rule is
       * walked, below.
       */
      const headers = page.locator("th[scope='colgroup']");
      const texts = await headers.allInnerTexts();
      expect(texts.length).toBeGreaterThan(1);
      expect(texts[0]).toContain(boardCopy.groups.GETTING_READY);
      expect(texts.join(" ")).not.toContain(boardCopy.groups.NEEDS_ACTION);
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
       * The group header is sticky (§4.1). Scrolled to the bottom of a 28-row board, the last
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
       * day has nothing left to ask — the button is still unavailable, and what says so is this
       * build's own sentence, not a pretend one about the van not having arrived (§1 honesty).
       * That sentence is the footer's caption, said once for both controls (Vera, #51).
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
      await expect(panel.getByText(drawer.readOnly)).toBeVisible();
      await expect(panel.getByText(/connected/)).toHaveCount(1);
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
     * Walked on the **finished day**, because the hold is now derived from the clock (Firia,
     * 2026-10-17; `dayRecordFor` in src/domain/board/board.ts). Noah O.'s afternoon window is
     * 4:20 PM and the demo day is read at 07:42, so a board that showed the hold there was
     * claiming a ride had ended while the van collecting him was still on the road. It is shown
     * on a day whose clock is past the ride, and this build has no way to make the demo day's
     * clock reach 4:20 PM: `INSTANT_MINUTE.LIVE` in src/domain/board/day.ts is a constant, the
     * committed replays cover the morning only, and `ops.scenario_clock` is seeded paused with
     * nothing reading it. A walking clock is B-10's (docs/ui/B12-SLICE2-DEFERRED.md §5) — until
     * it lands, the test below is the half of AT-13 the demo walk itself still reaches.
     */
    test("a ride that ends held, with no automatic return (AT-13)", async ({ page }) => {
      await page.goto(`${FINISHED_URL}&q=Noah`);

      const held = page
        .getByRole("row")
        .filter({
          has: page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }),
        });
      await expect(held.getByText(legStates.HELD_NO_RECEIVER.label).first()).toBeVisible();
      // It is a held child, not a handed-over one, and not a van still on its way. Said of this
      // row: the same child's morning *was* handed off at the ramp, two rows up.
      await expect(held.getByText(/handed off/i)).toHaveCount(0);
      // Needs action, first group on the board (§4.1).
      const headers = page.locator("th[scope='colgroup']");
      await expect(headers.first()).toContainText(boardCopy.groups.NEEDS_ACTION);

      /*
       * And the line that asks for the record, which is the half of this the demo day does not
       * reach: the van is back, the ride ended with nobody recorded as receiving him, so the row
       * asks a person to call his contacts and record who receives him (CA-04). At 07:42 the same
       * row asks for nothing at all (Vera, 2026-10-17; the test below).
       */
      const reason = fill(boardCopy.reasons.CHILD_HELD, { child: NO_RECEIVER_CHILD });
      const step = sentence(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: NO_RECEIVER_CHILD }));
      expect(step).toContain("record who receives");
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
      // held day (AT-07). On this day the morning was received by the ramp, which is the contrast
      // that makes the point — the same child, the same panel, two different endings.
      //
      // `.first()` because every state chip says its label twice on purpose: once for the ear
      // ("State: Handed off to the ramp") and once for the eye (§9), which is two nodes to a
      // text locator and a strict-mode violation to a bare one.
      await expect(
        panel
          .getByText(
            fill(legStates.COMPLETED_HANDOFF.label, {
              "receiver role": boardCopy.receivedByRamp,
            }),
          )
          .first(),
      ).toBeVisible();
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
     * And the demo walk's half of AT-13: the board it opens is read at 07:42, so that afternoon
     * says **when it is** and nothing else (Vera, 2026-10-17).
     *
     * This is the test that would have caught the bug. The walk used to open on "Noah O. is being
     * held with the van" next to the same child's morning row reading "On the way to pickup" — a
     * child set down at home before the van that collects him had finished its run. The first fix
     * left the row asking a coordinator to record a receiver for a van that leaves in eight hours,
     * which is work nobody can close and a needs-action group nobody can clear; Vera's ruling
     * takes the row down to its time. What a 07:42 board still carries about CA-04 is the part a
     * coordinator can act on, and it is on the row and in the panel: nobody on file may receive
     * him, and if nobody is there he waits with the van and nothing brings him back.
     */
    test("the day the walk opens says the receiver rule, and claims no hold (AT-13)", async ({
      page,
    }) => {
      await page.goto("/today?q=Noah");
      await expect(page.getByText(serviceDate.phases.LIVE)).toBeVisible();

      // No hold anywhere on the board a walk opens, and nothing on it handed over either.
      await expect(page.getByText(legStates.HELD_NO_RECEIVER.label)).toHaveCount(0);
      await expect(
        page.getByText(fill(boardCopy.reasons.CHILD_HELD, { child: NO_RECEIVER_CHILD })),
      ).toHaveCount(0);
      await expect(page.getByText(/handed off/i)).toHaveCount(0);

      /*
       * The afternoon row says its own time, at the end of the ride that time is: "Drop-off 4:20
       * PM", rather than the ten-minute window a van on the road publishes to a family.
       */
      const afternoon = page.getByRole("row").filter({
        has: page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }),
      });
      await expect(
        afternoon.getByText(fill(boardCopy.dropoffAt, { time: "4:20 PM" }), { exact: true }),
      ).toBeVisible();

      // And nothing is asked of it: no needs-action group on the board, and no step on the row.
      await expect(page.locator("th[scope='colgroup']").first()).not.toContainText(
        boardCopy.groups.NEEDS_ACTION,
      );
      const record = sentence(
        fill(boardCopy.nextSteps.RECORD_RECEIVER, { child: NO_RECEIVER_CHILD }),
      );
      await expect(page.getByText(record, { exact: true })).toHaveCount(0);
      if (width >= 1280) {
        await expect(afternoon.getByText(boardCopy.nextSteps.NOTHING)).toBeVisible();
        // What the row does carry about him, all day and on both of his rows: who may receive
        // him. `.first()` because a chip says its label for the ear and for the eye (§9).
        await expect(afternoon.getByText(boardCopy.noReceiver).first()).toBeVisible();
      }

      // And the morning ride beside it is where the replay has it: on the road, as it should be
      // at 07:42 — which is the thing the hold used to contradict.
      const morning = page
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) }) });
      await expect(morning.getByText(legStates.EN_ROUTE_PICKUP.label).first()).toBeVisible();

      // The drawer says the rule, in the present tense, with no ride claimed to have ended and
      // nothing asked of the one that has not run.
      await page
        .getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) })
        .click();
      const panel = page.getByRole("dialog");
      await expect(
        panel.getByText(fill(drawer.receiverMissing, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      await expect(
        panel.getByText(fill(drawer.heldNoReturn, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      await expect(
        panel.getByText(fill(boardCopy.reasons.NO_RECEIVING_ADULT, { child: NO_RECEIVER_CHILD })),
      ).toHaveCount(0);
      await expect(panel.getByText(record, { exact: true })).toHaveCount(0);
      await expect(panel.getByText(legStates.HELD_NO_RECEIVER.label)).toHaveCount(0);

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `today-receiver-rule-before-ride-${width}`));
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

      // The one date, labelled: "Service date · Wed, Oct 14 · Demo day".
      const dates = page.locator("time[datetime]");
      await expect(dates).toHaveCount(1);
      await expect(dates).toHaveText(demoDay().label);
      await expect(dates).toHaveAttribute("datetime", demoDay().iso);
      await expect(page.getByText(serviceDate.groupLabel)).toBeVisible();
      await expect(page.getByText(serviceDate.phases.LIVE)).toBeVisible();

      // Today's real date is nowhere on the screen — not in the board, not in the chrome.
      const realToday = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(new Date());
      if (realToday !== demoDay().label) {
        await expect(page.getByText(realToday)).toHaveCount(0);
      }

      // No switcher: no control, link or arrow that reaches another service date.
      await expect(page.locator("a[href*='date=']")).toHaveCount(0);
      for (const name of [/previous day/i, /next day/i]) {
        await expect(page.getByRole("link", { name })).toHaveCount(0);
        await expect(page.getByRole("button", { name })).toHaveCount(0);
      }
      await expect(page.getByRole("navigation", { name: serviceDate.groupLabel })).toHaveCount(0);

      // Nothing on the live day has an outcome: no ride on it has a custody event, so no row may
      // say one happened — and since the hold is read off the clock (Firia, 2026-10-17) no row
      // claims one of those either. A board read at 07:42 is a morning, all the way across.
      await expect(page.getByText(/handed off/i)).toHaveCount(0);
      await expect(page.getByText(legStates.HELD_NO_RECEIVER.label)).toHaveCount(0);
      console.log("screenshot:", await shot(page, `today-one-date-${width}`));
    });

    /**
     * The finished day, reached the only way it can be now: by URL. There is no control on the
     * board that goes here (the test above holds that), and this is the day AT-13 and AT-10 are
     * read on — so the board still has to be about the day it names rather than about today.
     */
    test("a day asked for by URL is the day the board names", async ({ page }) => {
      await page.goto(FINISHED_URL);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: fill(boardCopy.headingOtherDay, { date: FINISHED.label }),
        }),
      ).toBeVisible();
      await expect(page.getByText(serviceDate.phases.ENDED)).toBeVisible();
      await expect(page.locator("time[datetime]")).toHaveAttribute("datetime", FINISHED.iso);
      // …and that day's rides are the finished ones.
      await expect(page.getByText(/^Handed off to /).first()).toBeVisible();
    });

    /**
     * The "Next step" column, which is the taste rule this board was re-cut for: a step is a
     * thing to do, written as a verb and the name of the child it is done for — never a role.
     */
    test("every row says what to do next, as a verb and a child's name", async ({ page }) => {
      await page.goto("/today");
      /*
       * A step on the board a walk opens: this child's van has reported nothing all morning, and
       * the person who can answer for it is named rather than called "the provider". It is the
       * morning's step because the morning is the half of the day the clock has reached — nothing
       * is asked of an afternoon that has not run (Vera, 2026-10-17).
       */
      const step = sentence(
        fill(boardCopy.nextSteps.ASK_ABOUT_VAN, { dispatcher: "Rae S.", child: "Mia R." }),
      );

      if (width >= 1280) {
        await expect(page.getByText(step, { exact: true }).first()).toBeVisible();
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
        await page.getByRole("button", { name: opener("Mia R.") }).click();
        // Exact: the panel carries other sentences about the same child and the same van.
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
       * And the override has a line of its own, under its own button (Vera, 2026-10-16): the
       * line above belongs to the handoff, and standing alone beside this control it read as the
       * child's missing receiver being what stops an override. This one is about the override —
       * and it is muted, not the critical tone the handoff's reason wears, because it reports
       * nothing wrong with the day (Vera, #51).
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

    /**
     * The filter on the board a walk opens, which is the board with nothing in that group.
     *
     * The count on the toggle is the measurement: a demo day read twelve minutes into its morning
     * has no open work on it, because the one row that used to be in here was an afternoon the
     * clock had not reached (Vera, 2026-10-17). So the filter empties the board, and the line it
     * leaves says which kind of empty that is and how to undo it — not "no rides today", which
     * would be false of a day with 56 of them. The filter *narrowing* a board is walked on the
     * finished day, which has two rides needing a person (above).
     */
    test("the needs-action filter says plainly when nothing needs action", async ({ page }) => {
      await page.goto("/today");
      const toggle = page.getByRole("switch");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(toggle).toContainText(
        fill(boardCopy.groupHeading, { group: boardCopy.onlyNeedsAction, count: 0 }),
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      await expect(page.getByText(boardCopy.emptyNeedsAction)).toBeVisible();
      await expect(page.locator("table")).toHaveCount(0);
      await expect(page.getByText(/No rides scheduled/)).toHaveCount(0);

      // And it is a filter, not the day: turning it off brings the whole board back.
      await toggle.click();
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(RIDES);
      await expect(
        page.getByText(fill(boardCopy.showing, { shown: RIDES, total: RIDES })),
      ).toBeVisible();

      console.log("screenshot:", await shot(page, `today-needs-action-${width}`));
    });

    /** An empty board says which kind of empty it is, and ends in the way out of it. */
    test("a filter that hides everything says so, and says how to undo it", async ({ page }) => {
      await page.goto("/today?q=no+child+is+called+this");
      await expect(
        page.getByText(fill(boardCopy.emptySearch, { query: "no child is called this" })),
      ).toBeVisible();
      // Not the "no rides today" line: there are 56 rides today, they just do not match.
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
