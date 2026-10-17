/**
 * Plan routes, in a real browser (VEH-01…05, AT-04, AT-05, AT-12, TEST-SEC-02).
 *
 * The questions here are the ones a unit test cannot answer, because the answer is what is on
 * the screen: is every child in a van that fits their equipment *as the screen says it*, does a
 * refused drag change anything, does an unknown chair stop boarding and ask for a person, and
 * does the family hear nothing while staff are still choosing. Each is read off the rendered
 * page, and the screenshots land in artifacts/ so a design review has the picture next to the
 * assertion.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts), which grants a role and nothing else.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { board, fill, nav, planRoutes as copy, securement, solver, vanName } from "../src/ui/copy";
import { capabilityStates, reservationStates } from "../src/ui/states";
import {
  boxOf,
  expectDemoBarPinned,
  expectDemoControlStyling,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

/** The chair the ramp measures when the equipment that arrives is not the equipment on file. */
const MEASURED_CHAIR = "Chair measured at the ramp · 142 × 74 cm";
/** The one child in the scenario whose chair is held by four-point straps. */
const CHAIR_CHILD = "Zoe B.";
/** The reserve van a provider sends, as the screen names it — never as the code it is filed under. */
const SPARE_VAN = vanName("substitute van");

/**
 * A label that names the provider, as a pattern.
 *
 * The three lanes belong to three different providers and the lane under test is found by what
 * it carries, so these match the sentence and leave the name to the lane. The point of the
 * pattern is that there *is* a name in it: "Reported by the provider" named a role where the day
 * has somebody on file (Vera's review, 2026-10-17).
 */
function namesProvider(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace("\\{provider\\}", "\\S.+")}$`);
}

const REPORTED = namesProvider(copy.arrival.REPORTED);
const ASK_PROVIDER = namesProvider(copy.askProvider);
const RECORD_ANSWER = namesProvider(copy.recordAnswer);

/**
 * How a lane says how full it is, since Vera's review: used of available, with the noun on the
 * count ("3 of 6 seats used"). The anchored line has to be matched first — "anchored seats" also
 * ends in "seats used" — which is why these are two patterns and not one with a flag.
 */
const SEATS = /(?<!anchored )(\d+) of (\d+) seats? used/;
const ANCHORED_SEATS = /(\d+) of (\d+) anchored seats? used/;

type Lane = {
  id: string;
  /** The van's name as the screen says it ("the center van") — never its fixture code. */
  van: string;
  verdict: string;
  text: string;
  riders: string[];
};

async function lanes(page: Page): Promise<Lane[]> {
  const sections = page.locator("[data-lane]");
  const count = await sections.count();
  const out: Lane[] = [];
  for (let i = 0; i < count; i += 1) {
    const section = sections.nth(i);
    out.push({
      id: (await section.getAttribute("data-lane")) ?? "",
      van: (await section.getAttribute("data-van")) ?? "",
      verdict: (await section.getAttribute("data-verdict")) ?? "",
      text: await section.innerText(),
      riders: await section
        .locator("[data-rider]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-rider") ?? "")),
    });
  }
  return out;
}

function laneOf(page: Page, id: string): Locator {
  return page.locator(`[data-lane="${id}"]`);
}

/** What arrived and the substitution row, folded away under each lane until it is opened. */
async function openChanges(page: Page, laneId: string): Promise<void> {
  const control = laneOf(page, laneId).getByRole("button", { name: copy.changeVan, exact: true });
  if ((await control.getAttribute("aria-expanded")) !== "true") await control.click();
}

/** The red group: a child planning could not place, the reason, and the options. */
async function unplacedRows(page: Page): Promise<string[]> {
  const group = page.locator("[data-unplaced]");
  if ((await group.count()) === 0) return [];
  return (await group.innerText()).split("\n").filter((line) => line.trim().length > 0);
}

/** The neutral group: the children nobody has put in a van, as names. */
async function waitingNames(page: Page): Promise<string[]> {
  const group = page.locator("[data-waiting]");
  if ((await group.count()) === 0) return [];
  return group.locator("[data-rider]").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-rider") ?? ""),
  );
}

async function plan(page: Page): Promise<void> {
  await page.getByRole("button", { name: copy.plan, exact: true }).click();
}

/**
 * No vehicle code anywhere in the planning surface (Vera's review, 2026-10-17).
 *
 * "V1" is how the fixtures file a van and how the solver keys one. The live map and the ramp
 * iPad print it on purpose — a device, a marker and a manifest are all identified by it — and a
 * coordinator deciding which van a child rides in reads the van's name instead, so this is a
 * rule about this screen and lives here rather than in e2e/helpers.ts. Read off the rendered
 * text, so an interpolated code has nowhere to hide.
 *
 * The planning surface is the screen's own `<main>`, by role rather than by id: /plan-routes is
 * its own route outside the console shell (src/app/plan-routes/page.tsx renders the screen and
 * nothing else), so the shell's `#content` is not on this page at all and waiting for it is a
 * two-minute timeout rather than an assertion.
 */
async function expectNoVehicleCodes(page: Page): Promise<void> {
  const text = await page.getByRole("main").innerText();
  expect([...text.matchAll(/\bV\d{1,2}\b/g)].map((m) => m[0]), "a vehicle code on screen").toEqual(
    [],
  );
}

/**
 * The equipment check, read entirely off the screen: a child who uses a wheelchair is in a lane
 * whose own equipment list names a place with their securement hardware, and a lane never has
 * more riders needing an anchored seat than it says it has anchored seats.
 */
async function expectEquipmentFits(page: Page): Promise<void> {
  const sections = page.locator("[data-lane]");
  for (let i = 0; i < (await sections.count()); i += 1) {
    const section = sections.nth(i);
    const text = await section.innerText();
    const label = await section.getByRole("heading", { level: 3 }).innerText();
    const riders = section.locator("[data-rider]");

    for (let r = 0; r < (await riders.count()); r += 1) {
      const row = await riders.nth(r).innerText();
      const chair = /Uses a wheelchair · (.+)/.exec(row);
      if (!chair) continue;
      expect(
        text,
        `${label} carries a chair held by ${chair[1]} and lists no place for it`,
      ).toContain(`Wheelchair place · ${chair[1]}`);
      // A chair that boards by lift needs the van to have one.
      expect(text, `${label} has no ramp`).toContain(copy.equipment.lift);
    }

    const anchored = (await riders.allInnerTexts()).filter((row) =>
      row.includes("Needs an anchored seat"),
    ).length;
    const seats = ANCHORED_SEATS.exec(text);
    expect(seats, `${label} does not say how many anchored seats it has`).not.toBeNull();
    expect(Number(seats?.[1]), `${label} anchored seats used`).toBe(anchored);
    expect(Number(seats?.[1])).toBeLessThanOrEqual(Number(seats?.[2]));

    const walking = SEATS.exec(text);
    expect(walking, `${label} does not say how many seats are used`).not.toBeNull();
    expect(Number(walking?.[1])).toBeLessThanOrEqual(Number(walking?.[2]));
  }
}

/**
 * Drag a rider's row onto a lane with the mouse: press on the row, move in steps, release over
 * the lane's heading.
 *
 * This is the gesture a coordinator makes, driven by the real input stack — `mouse.down`,
 * `mouse.move`, `mouse.up` — and nothing about it is dispatched by hand. It is possible at all
 * because the screen moves a rider with pointer events instead of the browser's own
 * drag-and-drop: a platform drag session never starts for a synthetic gesture (or for a finger
 * on an iPad), which is exactly how a drag that did nothing shipped behind a check that passed.
 *
 * The release lands on the lane's own heading rather than its middle, because the middle of a
 * lane is a stop row — dropping there still works, the heading is simply a point no other
 * element can be on top of. The pointer-free way to do the same thing is the Move menu, and it
 * is checked below as well.
 */
async function dragRider(page: Page, child: string, target: Locator): Promise<void> {
  // The child's name, which is the first span in the row: a point inside the row that is not one
  // of its buttons, since Measure and Move are pressed rather than dragged.
  const grip = page.locator(`[data-rider="${child}"]`).first().locator("span").first();
  await grip.scrollIntoViewIfNeeded();

  // A mouse drag cannot scroll the page on the way, so both ends have to be on screen at once:
  // one scroll to the midpoint between them, and then the boxes are read again.
  const span = async () => [await boxOf(grip), await boxOf(target)] as const;
  const [grabbed, dropped] = await span();
  const middle = (grabbed.y + dropped.y + dropped.height) / 2;
  const height = page.viewportSize()?.height ?? 0;
  await page.evaluate((by) => window.scrollBy(0, by), middle - height / 2);

  const [from, to] = await span();
  for (const [what, box] of [[child, from], ["the van", to]] as const) {
    expect(box.y, `${what} is off screen, so the mouse cannot reach it`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${what} is below the window`).toBeLessThanOrEqual(height);
  }
  const at = (box: typeof from) => [box.x + box.width / 2, box.y + box.height / 2] as const;

  await page.mouse.move(...at(from));
  await page.mouse.down();
  // More than one move, and the first one small: the screen waits for the pointer to travel
  // before it calls a press a drag, and a single jump would skip the hold entirely.
  const [x, y] = at(from);
  await page.mouse.move(x + 12, y + 12);
  await page.mouse.move(...at(to), { steps: 12 });
  await page.mouse.up();
}

/** Where a lane is dropped onto: its heading, which no stop row can sit on top of. */
function laneTarget(page: Page, laneId: string): Locator {
  return laneOf(page, laneId).getByRole("heading", { level: 3 });
}

test.describe("Plan routes", () => {
  /**
   * The screen was reachable by typing the URL and from a link on the live map, which is not
   * how anybody finds a screen. It is a destination in the console rail now, for the two roles
   * whose row opens it, and this is the walk a coordinator actually makes.
   */
  test("is a destination in the console nav, not a URL staff have to know", async ({ page }) => {
    await page.goto("/today");
    const link = page
      .getByRole("navigation", { name: nav.landmarkLabel })
      .getByRole("link", { name: copy.heading });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page.getByRole("heading", { level: 1, name: copy.heading })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/plan-routes");
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    console.log("screenshot:", await shot(page, "plan-routes-from-the-nav"));
  });

  test("plans every child into a van that fits their equipment, and covers every drop-off", async ({
    page,
  }) => {
    await page.goto("/plan-routes");
    await expect(page.getByRole("heading", { level: 1, name: copy.heading })).toBeVisible();
    await expectDemoBarPinned(page);
    await expectVioletOnlyOnDemoChrome(page);

    /*
     * Nothing is planned until staff ask for it, and that is not a failure (Vera's review,
     * 2026-10-17): the opening screen is a neutral list of names headed "Waiting to be planned",
     * with no red group, no reason per child and no critical border anywhere. It is also where
     * the roster for the rest of this check comes from.
     */
    const roster = await waitingNames(page);
    expect(roster.length).toBeGreaterThanOrEqual(9);
    const waiting = page.locator("[data-waiting]");
    await expect(
      waiting.getByRole("heading", {
        name: fill(board.groupHeading, { group: copy.waitingHeading, count: roster.length }),
      }),
    ).toBeVisible();
    expect(await page.locator("[data-unplaced]").count(), "a red group on first load").toBe(0);
    // Names only: a row carries the child and the Move control, and nothing a card would add —
    // no stop, no window, no equipment chip and no intake caption.
    const waitingText = await waiting.innerText();
    expect(waitingText).not.toContain(copy.needsCaption);
    expect(waitingText).not.toMatch(/Uses a wheelchair|Needs an anchored seat|\d+:\d\d (AM|PM)/);
    for (const name of roster) {
      expect(waitingText, `${name} is in the waiting list`).toContain(name);
    }

    for (const lane of await lanes(page)) {
      expect(lane.riders, `${lane.id} before planning`).toEqual([]);
      expect(lane.text).toContain(copy.laneEmpty);
    }

    // The van that can be re-seated says, in plain words, that planning picks the setup — which
    // is why its "Set up as …" line is about to change under the reader's eyes. Exactly one van
    // on this day is built more than one way, and the other two explain nothing.
    const convertible = (await lanes(page)).filter((lane) =>
      lane.text.includes(copy.setUpChanges.BEFORE),
    );
    expect(convertible.map((lane) => lane.id)).toHaveLength(1);

    await plan(page);

    // Every child, once, in a van the solver called a fit — and the screen says so in words.
    expect(await page.locator("[data-unplaced]").count()).toBe(0);
    expect(await page.locator("[data-waiting]").count(), "nobody is still waiting").toBe(0);
    // The one button still says the same thing it said before it was pressed.
    await expect(page.getByRole("button", { name: copy.plan, exact: true })).toBeVisible();
    const planned = await lanes(page);
    const seated = planned.flatMap((lane) => lane.riders);
    expect([...seated].sort()).toEqual([...roster].sort());
    for (const lane of planned) {
      expect(lane.verdict, lane.id).toBe("FEASIBLE");
      expect(lane.text, lane.id).toContain(reservationStates.FEASIBLE.label);
      expect(lane.text, lane.id).toContain(copy.laneFits);
      // Morning: every lane ends at the centre, so every rider has a drop-off.
      expect(lane.text, lane.id).toContain(`${copy.dropOff} · PPEC center`);
    }
    await expect(page.getByText(`${roster.length} of ${roster.length} riders are in a van.`)).toBeVisible();
    // ...and now it says planning chose this setup, on the one lane that could choose.
    const chosen = planned.find((lane) => lane.id === convertible[0].id);
    expect(chosen?.text, convertible[0].id).toContain(copy.setUpChanges.PLANNED);
    expect(planned.filter((lane) => lane.text.includes(copy.setUpChanges.PLANNED))).toHaveLength(1);
    await expectEquipmentFits(page);
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    // The intake caption is said once, over the lanes, not under each of the nine rider cards.
    await expect(page.getByText(copy.needsCaption, { exact: true })).toHaveCount(1);
    console.log("screenshot:", await shot(page, "plan-routes-morning"));

    // The afternoon is the same plan read backwards: everyone boards at the centre and each
    // child is set down at their own stop, which is where "every drop-off is covered" bites.
    await page.getByRole("button", { name: copy.directionButton.PM, exact: true }).click();
    await plan(page);
    const afternoon = await lanes(page);
    expect(afternoon.flatMap((lane) => lane.riders).sort()).toEqual([...roster].sort());
    for (const lane of afternoon) {
      expect(lane.verdict, lane.id).toBe("FEASIBLE");
      expect(lane.text, lane.id).toContain(`${copy.pickUp} · PPEC center`);
      // One stop per rider besides the centre: nobody is carried without a place to get off.
      const stops = lane.text.split("\n").filter((line) => / · \d+:\d\d (AM|PM)$/.test(line.trim()));
      expect(stops.length, lane.id).toBe(lane.riders.length);
    }
    await expectEquipmentFits(page);
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    console.log("screenshot:", await shot(page, "plan-routes-afternoon"));
  });

  test("refuses a move the van cannot take, in one line that names the child", async ({ page }) => {
    await page.goto("/plan-routes");
    await plan(page);

    const from = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD));
    expect(from, `${CHAIR_CHILD} is planned into a van`).toBeDefined();
    const target = (await lanes(page)).find((lane) => lane.id !== from?.id);
    const rider = laneOf(page, from?.id ?? "").locator(`[data-rider="${CHAIR_CHILD}"]`);

    // The pointer-free way in, because a drag is never the only way (§9): the center van's
    // position is L-track hardware and this chair is held by four-point straps, so it cannot
    // take her. The same refusal with the mouse is the test below.
    await rider.getByRole("button", { name: new RegExp(`^Move ${CHAIR_CHILD}`) }).click();
    await page
      .getByRole("button", { name: fill(copy.moveTo, { vehicle: target?.van ?? "" }), exact: true })
      .first()
      .click();

    // One line, the child first, then the van by name and the one thing that is missing. The
    // keyboard's way in goes through the same mover as the drag (`tryMove`), so the refusal is
    // read here the same three ways: the notice, the lane she stayed in, and every verdict.
    const notice = page.locator("[data-notice]");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-refused", "true");
    await expect(notice).toHaveText(
      fill(copy.refused, {
        child: CHAIR_CHILD,
        vehicle: target?.van ?? "",
        missing: fill(copy.missing.NO_SECUREMENT, { securement: securement.FOUR_POINT_STRAP }),
      }),
    );
    // Nothing moved: she is still in the lane she was planned into, and the target did not
    // take her.
    const after = await lanes(page);
    expect(after.find((lane) => lane.id === from?.id)?.riders).toContain(CHAIR_CHILD);
    expect(after.find((lane) => lane.id === target?.id)?.riders).not.toContain(CHAIR_CHILD);
    expect(after.every((lane) => lane.verdict === "FEASIBLE")).toBe(true);
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    console.log("screenshot:", await shot(page, "plan-routes-move-refused"));
  });

  /**
   * Vera's review, 2026-10-17: pressing the one button again may not quietly undo a drag.
   *
   * It used to. "Plan routes" re-labelled itself "Plan routes again" and then planned from
   * nothing, so a coordinator who had moved two children by hand and wanted the rest filled in
   * lost both. The screen keeps them instead of asking: the label never changes, the moved child
   * stays in the van they were put in, and one line says what was kept.
   */
  test("keeps a coordinator's own moves when the day is planned again", async ({ page }) => {
    await page.goto("/plan-routes");
    await plan(page);

    // A rider who needs only a seat, and a van that says it has a free one: both read off the
    // screen, so the move being tested is one the solver will take.
    const planned = await lanes(page);
    const roomy = planned.find((lane) => {
      const seats = SEATS.exec(lane.text);
      return seats ? Number(seats[1]) < Number(seats[2]) : false;
    });
    expect(roomy, "a van on this day has a free seat").toBeDefined();
    const donor = planned.find((lane) => lane.id !== roomy?.id && lane.riders.length > 0);
    const walking = await laneOf(page, donor?.id ?? "")
      .locator("[data-rider]")
      .evaluateAll((rows) =>
        rows
          .filter((row) => !/Uses a wheelchair|Needs an anchored seat/.test(row.textContent ?? ""))
          .map((row) => row.getAttribute("data-rider") ?? ""),
      );
    expect(walking.length, `${donor?.id} has a rider who needs only a seat`).toBeGreaterThan(0);
    const child = walking[0];

    await laneOf(page, donor?.id ?? "")
      .locator(`[data-rider="${child}"]`)
      .getByRole("button", { name: new RegExp(`^Move ${child}`) })
      .click();
    await page
      .getByRole("button", { name: fill(copy.moveTo, { vehicle: roomy?.van ?? "" }), exact: true })
      .first()
      .click();
    expect((await lanes(page)).find((lane) => lane.id === roomy?.id)?.riders).toContain(child);

    // Plan again. Same label, and the child a person placed is still where they were placed.
    await expect(page.getByRole("button", { name: copy.plan, exact: true })).toBeVisible();
    await plan(page);
    const again = await lanes(page);
    expect(again.find((lane) => lane.id === roomy?.id)?.riders, "the move was kept").toContain(child);
    expect(again.find((lane) => lane.id === donor?.id)?.riders).not.toContain(child);
    // Nobody was dropped to keep it, and the screen says what it did.
    expect(again.flatMap((lane) => lane.riders).sort()).toEqual(
      planned.flatMap((lane) => lane.riders).sort(),
    );
    await expect(page.locator("[data-notice]")).toHaveText(copy.plannedKeptMoves);
    for (const lane of again) expect(lane.verdict, lane.id).toBe("FEASIBLE");
    console.log("screenshot:", await shot(page, "plan-routes-kept-moves"));
  });

  /**
   * The drag, with the mouse, both ways: a move the solver takes and a move it refuses.
   *
   * This is the check the screen did not have. The old one dispatched `dragstart` and `drop` by
   * hand, which passed while a real mouse did nothing at all, because the browser's own
   * drag-and-drop needs a platform drag session that no synthetic gesture — and no finger — ever
   * starts. Pointer events have no such session, so what is driven here is the same input a
   * coordinator's hand produces: press, move, release.
   */
  test.describe("with the mouse", () => {
    // A drag cannot scroll the page, so the row and the van it is dropped on have to be in the
    // window together, and a lane is tall. The gesture is what is under test here; the layout at
    // the review's two widths is measured in e2e/screens.spec.ts.
    test.use({ viewport: { width: 1440, height: 2000 } });

    test("moves a rider into a van that fits, and refuses one that does not", async ({ page }) => {
      await page.goto("/plan-routes");
      await plan(page);
      const notice = page.locator("[data-notice]");

      /* ── refused: the chair's hardware is not in the other van ── */
      const planned = await lanes(page);
      const home = planned.find((lane) => lane.riders.includes(CHAIR_CHILD));
      const other = planned.find((lane) => lane.id !== home?.id);
      expect(home, `${CHAIR_CHILD} is planned into a van`).toBeDefined();
      expect(other, "there is a second van to drop her on").toBeDefined();
      await dragRider(page, CHAIR_CHILD, laneTarget(page, other?.id ?? ""));

      /*
       * One line, on screen, and it is a refusal: the child by name, then the van by name and
       * the one thing that is missing.
       *
       * Tightened for Veri's finding, 2026-10-17. The refusal is the whole check here, so it is
       * read three independent ways — the notice says so, the rider is still in the lane she was
       * planned into, and every lane is still a fit. A mover that stopped asking the solver
       * (`tryMove`, src/domain/solver) fails all three: she lands in a van whose securement
       * cannot hold her chair, so that lane's own verdict turns INFEASIBLE on screen.
       */
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute("data-refused", "true");
      await expect(notice).toHaveText(
        fill(copy.refused, {
          child: CHAIR_CHILD,
          vehicle: other?.van ?? "",
          missing: fill(copy.missing.NO_SECUREMENT, { securement: securement.FOUR_POINT_STRAP }),
        }),
      );
      // And the assignment did not change at all: a refused drag moves nobody.
      const afterRefusal = await lanes(page);
      expect(
        afterRefusal.find((lane) => lane.id === home?.id)?.riders,
        `${CHAIR_CHILD} left the van she was planned into`,
      ).toContain(CHAIR_CHILD);
      expect(
        afterRefusal.find((lane) => lane.id === other?.id)?.riders,
        `the van that refused ${CHAIR_CHILD} took her anyway`,
      ).not.toContain(CHAIR_CHILD);
      expect(afterRefusal.map((lane) => lane.riders)).toEqual(planned.map((lane) => lane.riders));
      // Nothing the lanes say about themselves changed either, verdicts and seat counts alike.
      for (const lane of afterRefusal) expect(lane.verdict, lane.id).toBe("FEASIBLE");
      expect(afterRefusal.map((lane) => SEATS.exec(lane.text)?.[0])).toEqual(
        planned.map((lane) => SEATS.exec(lane.text)?.[0]),
      );
      console.log("screenshot:", await shot(page, "plan-routes-mouse-refused"));

      /* ── accepted: a walking rider into the van that still has a seat ── */
      // Both ends read off the screen rather than assumed: the van whose own line says a seat is
      // free, and a rider in another van who needs nothing but a seat.
      const roomy = afterRefusal.find((lane) => {
        const seats = SEATS.exec(lane.text);
        return seats ? Number(seats[1]) < Number(seats[2]) : false;
      });
      expect(roomy, "a van on this day has a free seat").toBeDefined();

      const donor = afterRefusal.find((lane) => lane.id !== roomy?.id);
      const walking = await laneOf(page, donor?.id ?? "")
        .locator("[data-rider]")
        .evaluateAll((rows) =>
          rows
            .filter(
              (row) =>
                !/Uses a wheelchair|Needs an anchored seat/.test(row.textContent ?? ""),
            )
            .map((row) => row.getAttribute("data-rider") ?? ""),
        );
      expect(walking.length, `${donor?.id} has a rider who needs only a seat`).toBeGreaterThan(0);
      const rider = walking[0];

      await dragRider(page, rider, laneTarget(page, roomy?.id ?? ""));

      await expect(notice).not.toHaveAttribute("data-refused", "true");
      await expect(notice).toHaveText(
        fill(copy.moved, { child: rider, vehicle: roomy?.van ?? "" }),
      );
      const afterMove = await lanes(page);
      expect(afterMove.find((lane) => lane.id === roomy?.id)?.riders).toContain(rider);
      expect(afterMove.find((lane) => lane.id === donor?.id)?.riders).not.toContain(rider);
      // The screen only ever shows the solver's verdict, so the van that took them still fits.
      expect(afterMove.find((lane) => lane.id === roomy?.id)?.verdict).toBe("FEASIBLE");
      await expectEquipmentFits(page);
      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, "plan-routes-mouse-moved"));
    });
  });

  test("AT-04: equipment unknown until arrival stops boarding and asks for a person", async ({
    page,
  }) => {
    await page.goto("/plan-routes");
    await plan(page);

    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);

    // What arrived is behind the lane's one disclosure, closed until somebody wants it (Vera's
    // review, 2026-10-17) — and it is the control that says what it opens.
    const changes = lane.getByRole("button", { name: copy.changeVan, exact: true });
    await expect(changes).toHaveAttribute("aria-expanded", "false");
    await openChanges(page, laneId);

    // Half one: nobody has reported on the van at all. That is the normal state of a morning,
    // and it is never read as a yes — the lane carries nobody's boarding.
    await lane.getByRole("button", { name: copy.arrival.NOT_CHECKED, exact: true }).click();
    await expect(lane).toHaveAttribute("data-verdict", "CAPABILITY_PENDING");
    await expect(lane).toContainText(capabilityStates.UNKNOWN.label);
    await expect(lane).toContainText(copy.laneNeedsCheck);
    console.log("screenshot:", await shot(page, "plan-routes-at04-unknown"));

    // Half two: the van is reported — by a named provider, not by "the provider" — and the chair
    // that arrives is not the chair on file. The run is infeasible *before* anyone boards, and
    // every way out needs a coordinator.
    await lane.getByRole("button", { name: REPORTED }).click();
    await expect(lane).toHaveAttribute("data-verdict", "FEASIBLE");
    const rider = lane.locator(`[data-rider="${CHAIR_CHILD}"]`);
    await rider.getByRole("button", { name: new RegExp(`^Measure ${CHAIR_CHILD}`) }).click();

    await expect(lane).toHaveAttribute("data-verdict", "INFEASIBLE");
    await expect(lane).toContainText(reservationStates.INFEASIBLE.label);
    await expect(lane).toContainText(MEASURED_CHAIR);
    await expect(lane).toContainText(copy.laneBlocked);
    // One note under the list, rather than the same chip beside every option.
    await expect(lane.getByText(copy.optionsNote)).toHaveCount(1);
    // The child is still on the run: the solver proposes and a human decides, so nobody is
    // quietly taken off a van.
    await expect(rider).toBeVisible();
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    await expectVioletOnlyOnDemoChrome(page);
    await lane.getByRole("heading", { level: 3 }).scrollIntoViewIfNeeded();
    console.log("screenshot:", await shot(page, "plan-routes-at04-infeasible"));
  });

  test("AT-05: a substitute van is unknown, is asked about, and is solved again", async ({ page }) => {
    await page.goto("/plan-routes");
    await plan(page);

    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);
    const was = await lane.getByRole("heading", { level: 3 }).innerText();
    await openChanges(page, laneId);

    // 1. The provider sends a different van, with a different driver. The van is offered by its
    // own name: "the substitute van", never "V3".
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    const spare = lane.getByRole("button", { name: new RegExp(`^${SPARE_VAN} · `) });
    await expect(spare).toBeVisible();
    await spare.click();

    await expect(lane.getByRole("heading", { level: 3 })).not.toHaveText(was);
    await expect(lane).toContainText("Omar T.");
    // 2. Nothing is known about it yet, and the lane says which kind of unknown this is.
    await expect(lane).toHaveAttribute("data-verdict", "CAPABILITY_PENDING");
    await expect(lane).toContainText(capabilityStates.CHANGED.label);
    await expect(lane).toContainText(solver.pending.substituted);
    // The van has changed, so the control the next step lives in opens itself.
    await expect(
      lane.getByRole("button", { name: copy.changeVan, exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    // The picture is evidence, so frame the lane that changed rather than wherever the last
    // click left the page.
    await lane.getByRole("heading", { level: 3 }).scrollIntoViewIfNeeded();
    console.log("screenshot:", await shot(page, "plan-routes-at05-substituted"));

    // 3. The provider is asked again, by name, and answers.
    await lane.getByRole("button", { name: ASK_PROVIDER }).click();
    await expect(lane).toContainText(capabilityStates.REQUESTED.label);
    await lane.getByRole("button", { name: RECORD_ANSWER }).click();

    // 4. Re-solved against the substitute's own hardware, which does not hold this chair.
    await expect(lane).toHaveAttribute("data-verdict", "INFEASIBLE");
    await expect(lane).toContainText(securement.FOUR_POINT_STRAP);
    await expect(lane).toContainText(copy.laneBlocked);
    await lane.getByRole("heading", { level: 3 }).scrollIntoViewIfNeeded();
    console.log("screenshot:", await shot(page, "plan-routes-at05-resolved"));

    // A driver substitution is the other half of AT-05, and it changes nothing about what the
    // van can carry — so the verdict is the same before and after. The line leads with the
    // person and names no van (Vera's review, 2026-10-17).
    const verdict = await lane.getAttribute("data-verdict");
    await openChanges(page, laneId);
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    await lane.getByRole("button", { name: copy.substituteDriver, exact: true }).click();
    await expect(page.locator("[data-notice]")).toHaveText(/^\S.+ drives instead\.$/);
    await expect(lane).toHaveAttribute("data-verdict", verdict ?? "");
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
  });

  test("AT-12: a child with no van is named a reason, and no family is told first", async ({
    page,
  }) => {
    await page.goto("/plan-routes");
    await plan(page);

    // Take away the one van built for this chair, the way a provider does: a substitution.
    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);
    await openChanges(page, laneId);
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    await lane.getByRole("button", { name: new RegExp(`^${SPARE_VAN} · `) }).click();
    await lane.getByRole("button", { name: ASK_PROVIDER }).click();
    await lane.getByRole("button", { name: RECORD_ANSWER }).click();
    await plan(page);

    // She is in the red group at the top, with one plain line that names her and what is
    // missing — and she is the only one in it, because everybody else has a van.
    const group = page.locator("[data-unplaced]");
    await expect(group).toBeVisible();
    await expect(group).toContainText(`No van with ${securement.FOUR_POINT_STRAP} for ${CHAIR_CHILD}`);
    await expect(group).toContainText(CHAIR_CHILD);
    expect(await page.locator("[data-waiting]").count(), "nobody is merely waiting").toBe(0);

    // Every way out needs a coordinator, said once under the list rather than on every row.
    await expect(group.getByText(copy.optionsNote)).toHaveCount(1);
    for (const option of [
      solver.options.FAMILY_TRANSPORT.label,
      solver.options.DELAY.label,
      solver.options.CANCEL.label,
    ]) {
      await expect(group.getByText(option, { exact: false }).first()).toBeVisible();
    }
    await expect(page.getByText(copy.nothingSent)).toBeVisible();
    await expect(group).toContainText(
      fill(solver.options.FAMILY_TRANSPORT.detail, { who: CHAIR_CHILD }),
    );
    // The heading names her, and the options name vans rather than codes.
    await expect(
      group.getByRole("heading", { name: fill(copy.optionsHeading, { child: CHAIR_CHILD }) }),
    ).toBeVisible();

    // Nobody else lost their van, and no lane was auto-reshuffled around her.
    const rows = await unplacedRows(page);
    const names = rows.flatMap((line) => [...line.matchAll(/([A-Z][a-z]+ [A-Z]\.)/g)].map((m) => m[1]));
    expect([...new Set(names)]).toEqual([CHAIR_CHILD]);

    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    await expectVioletOnlyOnDemoChrome(page);
    console.log("screenshot:", await shot(page, "plan-routes-at12-no-van"));
  });

  /**
   * The same promise, reached by walking the screen rather than by driving a substitution.
   *
   * The normal day places all nine riders, so the group at the top — a child with no van, the
   * reason, and the options — was only ever reachable by taking a van away in four clicks. The
   * second demo scenario is that walk, on the same service date: the convertible van is off the
   * road, the provider sent the small substitute, and no van left today holds four-point straps.
   * The normal scenario is untouched, which is what keeps the feasible-plan check above honest.
   *
   * The toggle itself is checked here too (Vera's review, 2026-10-17): it is labelled by what
   * happens rather than by a date, it is painted as the demo control it is, and the one demo day
   * the screen replays is the same date on both sides of it.
   */
  test("AT-12: the demo scenario where one child cannot be placed shows the group and a reason", async ({
    page,
  }) => {
    await page.goto("/plan-routes");

    // The scenario is a choice on the screen, in plain words, and the normal day is the default.
    const toggle = page.locator('[data-demo-control="true"]');
    await expect(toggle).toBeVisible();
    const ordinary = toggle.getByRole("button", {
      name: copy.demoScenario.EVERY_RIDER_FITS,
      exact: true,
    });
    await expect(ordinary).toHaveAttribute("aria-pressed", "true");
    // It is a demo control and looks like one: the DEMO bar's own fill, not the screen's.
    await expectDemoControlStyling(toggle);
    // Named by the scenario, never by a date: the one date on the screen is the heading's.
    const dateLabel = await page.locator("h1 + span").innerText();
    for (const label of Object.values(copy.demoScenario)) {
      await expect(toggle.getByRole("button", { name: label, exact: true })).toBeVisible();
      expect(label, "a scenario label reads like a date").not.toMatch(/\d/);
    }

    await toggle
      .getByRole("button", { name: copy.demoScenario.ONE_RIDER_HAS_NO_VAN, exact: true })
      .click();
    await expect(page.getByText(copy.demoScenarioNote.ONE_RIDER_HAS_NO_VAN)).toBeVisible();
    // Still the one demo day: switching the scenario does not move the screen to another date.
    expect(await page.locator("h1 + span").innerText()).toBe(dateLabel);

    /*
     * Before planning, both groups are on screen at once, which is the clearest place to read
     * the difference Vera asked for: no van on this day holds her chair, so she is in the red
     * group with a reason from the first second — and the eight children nobody has placed yet
     * are in the neutral one, with no reason and no critical border.
     */
    const bordersBefore = await page.evaluate(() => {
      const border = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).borderTopColor : null;
      };
      return { blocked: border("[data-unplaced]"), waiting: border("[data-waiting]") };
    });
    expect(bordersBefore.blocked, "the red group is on screen before planning").not.toBeNull();
    expect(bordersBefore.waiting, "the neutral group is on screen too").not.toBeNull();
    expect(bordersBefore.waiting, "the two groups share a border colour").not.toBe(
      bordersBefore.blocked,
    );
    expect(await waitingNames(page)).not.toContain(CHAIR_CHILD);
    await expect(page.locator("[data-waiting]")).not.toContainText(securement.FOUR_POINT_STRAP);
    console.log("screenshot:", await shot(page, "plan-routes-at12-before-planning"));

    await plan(page);

    // One child, named, with the missing hardware said in words — and everybody else in a van.
    const group = page.locator("[data-unplaced]");
    await expect(group).toBeVisible();
    await expect(group).toContainText(
      `No van with ${securement.FOUR_POINT_STRAP} for ${CHAIR_CHILD}`,
    );
    const rows = await unplacedRows(page);
    const names = rows.flatMap((line) => [...line.matchAll(/([A-Z][a-z]+ [A-Z]\.)/g)].map((m) => m[1]));
    expect([...new Set(names)]).toEqual([CHAIR_CHILD]);
    for (const lane of await lanes(page)) {
      expect(lane.verdict, lane.id).toBe("FEASIBLE");
      expect(lane.riders, `${lane.id} carries ${CHAIR_CHILD}`).not.toContain(CHAIR_CHILD);
    }

    // Nothing is assigned and no family has been told: every way out needs a coordinator.
    await expect(group.getByText(copy.optionsNote)).toHaveCount(1);
    await expect(page.getByText(copy.nothingSent)).toBeVisible();
    await expectEquipmentFits(page);
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    // The toggle is violet, and it is still the only thing on the screen that is.
    await expectVioletOnlyOnDemoChrome(page);
    console.log("screenshot:", await shot(page, "plan-routes-at12-demo-scenario"));

    // Back to the normal day, and the plan it starts from is dropped rather than carried over:
    // nobody is in a van, and nobody is a failure either.
    await ordinary.click();
    await expectDemoControlStyling(toggle);
    expect(await page.locator("h1 + span").innerText()).toBe(dateLabel);
    expect(await page.locator("[data-unplaced]").count()).toBe(0);
    expect((await waitingNames(page)).length).toBeGreaterThanOrEqual(9);
    for (const lane of await lanes(page)) expect(lane.riders, lane.id).toEqual([]);
    await plan(page);
    expect(await page.locator("[data-unplaced]").count()).toBe(0);
    expect(await page.locator("[data-waiting]").count()).toBe(0);
  });

  test("TEST-SEC-02: no non-BAA call leaves the page, and no routing payload carries a token", async ({
    page,
  }) => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    page.on("request", (request) =>
      seen.push({
        method: request.method(),
        url: request.url(),
        body: request.postData() ?? "",
      }),
    );

    await page.goto("/plan-routes");
    // Everything on the screen that could possibly ask something of the network: planning,
    // moving a child, substituting a van, asking the provider, measuring a chair, both runs.
    await plan(page);
    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);
    await lane
      .locator(`[data-rider="${CHAIR_CHILD}"]`)
      .getByRole("button", { name: new RegExp(`^Measure ${CHAIR_CHILD}`) })
      .click();
    await openChanges(page, laneId);
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    await lane.getByRole("button", { name: new RegExp(`^${SPARE_VAN} · `) }).click();
    await lane.getByRole("button", { name: ASK_PROVIDER }).click();
    await lane.getByRole("button", { name: RECORD_ANSWER }).click();
    await plan(page);
    await page.getByRole("button", { name: copy.directionButton.PM, exact: true }).click();
    await plan(page);
    await page.waitForLoadState("networkidle");

    // No map, no routing provider, no geocoder: there is no *.googleapis.com request to make.
    expect(seen.filter((r) => /googleapis\.com/i.test(r.url))).toEqual([]);
    // And nothing left this origin at all, which is the stronger form of the same rule.
    const offSite = seen.filter((r) => !r.url.startsWith("http://127.0.0.1:"));
    expect(offSite.map((r) => r.url)).toEqual([]);

    // No payload at all, so nothing can be in one: the plan is computed in the browser from
    // the synthetic day, and the solver is pure.
    expect(seen.filter((r) => r.body.length > 0).map((r) => `${r.method} ${r.url}`)).toEqual([]);

    // Belt and braces: no child, place or vehicle name appears in any request we did make.
    const names = [CHAIR_CHILD, "Noah O.", "Okeeheelee Park", "PPEC center", "Omar T."];
    for (const name of names) {
      const encoded = encodeURIComponent(name);
      const leaks = seen.filter(
        (r) => r.url.includes(name) || r.url.includes(encoded) || r.body.includes(name),
      );
      expect(leaks.map((r) => r.url), `${name} reached a request`).toEqual([]);
    }

    console.log("screenshot:", await shot(page, "plan-routes-egress"));
  });
});
