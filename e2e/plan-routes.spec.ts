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
import { board, countable, fill, nav, planRoutes as copy, pluralize, securement, solver, vanName } from "../src/ui/copy";
import { DEFAULT_MAP_STYLE_URL } from "../src/components/map/style";
import { API } from "../src/auth/access";
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

/**
 * The saved line, with whatever minute the server kept the plan at: "Plan saved at 1:24 PM. No
 * family has been told." The time is the server's own record and the test cannot know it in
 * advance, so the shape is asserted here and the minute itself is read back off the endpoint.
 */
const SAVED_LINE = (() => {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [before, after] = copy.saved.split("{time}");
  return new RegExp(`^${escape(before)}\\d{1,2}:\\d{2} (?:AM|PM)${escape(after)}$`);
})();

/** The minute an instant is, on the clock at the centre — the same conversion the screen makes. */
function siteClock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
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

/**
 * Where a plan is saved. Named through the access table, which is where every endpoint path in
 * this repo is written down (src/auth/access.ts) — a literal here would be a second copy of it.
 */
const SAVE_ENDPOINT = API.planSave;

/** "the convertible van · 3 stops" on the row under the map, as a pattern over the count. */
const STOP_COUNT = new RegExp(`· (\\d+) (?:${countable.stop.one}|${countable.stop.many})$`);
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

/** The folded panel itself, so a test can ask whether it is on the screen rather than read a flag. */
function changesPanel(page: Page, laneId: string): Locator {
  return page.locator(`#lane-${laneId}-changes`);
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
 * The kerbs one lane drives, read off its own rider rows: "Okeeheelee Park · 6:50 AM", with the
 * place taken and the window left alone. Distinct, because two children of one family board at
 * one kerb and a van stops there once — which is also what the map draws.
 */
async function kerbsIn(page: Page, laneId: string): Promise<string[]> {
  const rows = await laneOf(page, laneId).locator("[data-rider]").allInnerTexts();
  const kerbs = rows.flatMap((row) => {
    const found = /^(.+) · \d{1,2}:\d{2} (?:AM|PM)$/m.exec(row);
    return found ? [found[1]] : [];
  });
  return [...new Set(kerbs)];
}

/**
 * Move some child into some other van, stopping at the first move the solver allows.
 *
 * Which child can go where is the solver's answer over the plan it has just made, and this check
 * is not the place to re-derive it: a hardcoded pair would be a copy of the planner's search and
 * would go stale the moment the fixtures changed. A refusal changes nothing on the screen — that
 * is what the refusal check above is for — so asking is free, and the first acceptance is the
 * move a coordinator would have made.
 */
async function moveWhoeverFits(
  page: Page,
): Promise<{ child: string; kerb: string; from: string; to: string }> {
  const all = await lanes(page);
  for (const lane of all) {
    for (const child of lane.riders) {
      const row = laneOf(page, lane.id).locator(`[data-rider="${child}"]`);
      const kerbs = /^(.+) · \d{1,2}:\d{2} (?:AM|PM)$/m.exec(await row.innerText());
      for (const target of all.filter((l) => l.id !== lane.id)) {
        await row.getByRole("button", { name: fill(copy.move, { child }), exact: true }).click();
        await page
          .getByRole("button", { name: fill(copy.moveTo, { vehicle: target.van }), exact: true })
          .click();
        const notice = (await page.locator("[data-notice]").innerText()).trim();
        if (notice === fill(copy.moved, { child, vehicle: target.van })) {
          return { child, kerb: kerbs?.[1] ?? "", from: lane.id, to: target.id };
        }
        // Refused: the line says which van and what is missing, and nothing moved.
        expect(notice, `${child} into ${target.van}`).toMatch(/^Can’t put /);
      }
    }
  }
  throw new Error("no move the solver allowed");
}

/**
 * No vehicle code anywhere in the planning surface (Vera's review, 2026-10-17).
 *
 * "V1" is how the fixtures file a van and how the solver keys one. The map preview and the ramp
 * iPad print it on purpose — a device, a marker and a manifest are all identified by it — and a
 * coordinator deciding which van a child rides in reads the van's name instead, so this is a
 * rule about this screen and lives here rather than in e2e/helpers.ts. Read off the rendered
 * text, so an interpolated code has nowhere to hide.
 *
 * The planning surface is the screen's own `<main>`, by role rather than by id: /plan-preview is
 * its own route outside the console shell (src/app/plan-preview/page.tsx renders the screen and
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
   * The screen was reachable by typing the URL and from a link on the map preview, which is not
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
    expect(new URL(page.url()).pathname).toBe("/plan-preview");
    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    console.log("screenshot:", await shot(page, "plan-routes-from-the-nav"));
  });

  test("plans every child into a van that fits their equipment, and covers every drop-off", async ({
    page,
  }) => {
    await page.goto("/plan-preview");
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
    await page.goto("/plan-preview");
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
    await page.goto("/plan-preview");
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
      await page.goto("/plan-preview");
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
    await page.goto("/plan-preview");
    await plan(page);

    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);

    // What arrived is behind the lane's one disclosure, closed until somebody wants it (Vera's
    // review, 2026-10-17) — and it is the control that says what it opens. Closed means gone from
    // the screen, not merely flagged: a `display` rule once kept the panel visible under `hidden`.
    const changes = lane.getByRole("button", { name: copy.changeVan, exact: true });
    const panel = changesPanel(page, laneId);
    await expect(changes).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
    await expect(panel.getByText(copy.arrivalHeading, { exact: true })).toBeHidden();
    await expect(panel.getByText(copy.substituteHeading, { exact: true })).toBeHidden();

    await openChanges(page, laneId);
    await expect(changes).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(panel.getByText(copy.arrivalHeading, { exact: true })).toBeVisible();
    await expect(panel.getByText(copy.substituteHeading, { exact: true })).toBeVisible();

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
    await page.goto("/plan-preview");
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
    const changes = lane.getByRole("button", { name: copy.changeVan, exact: true });
    const panel = changesPanel(page, laneId);
    await expect(changes).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    /*
     * And a control that says it is open closes when it is pressed (Veri's finding, 2026-10-17).
     * A panel held open by the van's own state used to ignore the press: the press cleared
     * "which lane is open" and the forced state put it straight back, so the one control on the
     * lane did nothing at all on exactly the lane a coordinator is working on.
     */
    await changes.click();
    await expect(changes).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
    await expect(panel.getByText(copy.arrivalHeading, { exact: true })).toBeHidden();
    // Open again, because the rest of VEH-05 is inside it.
    await changes.click();
    await expect(changes).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
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
    await page.goto("/plan-preview");
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
    await page.goto("/plan-preview");

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
    /*
     * And there is nothing to save yet, so the one control that leaves the browser cannot be
     * pressed and nothing claims to be unsaved (Vera's review, 2026-10-17): nobody is in a van,
     * which the row with the button says in the count beside it.
     */
    await expect(page.getByRole("button", { name: copy.save, exact: true })).toBeDisabled();
    await expect(page.locator("[data-unsaved]")).toHaveCount(0);
    console.log("screenshot:", await shot(page, "plan-routes-at12-before-planning"));

    await plan(page);
    // One press, and both are true the other way round: there is a plan, and it is not saved.
    await expect(page.getByRole("button", { name: copy.save, exact: true })).toBeEnabled();
    await expect(page.locator("[data-unsaved]")).toHaveText(copy.unsaved);

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

  /**
   * The map beside the lanes, and the plan being saved: the one walk a founder clicks through.
   *
   * MapLibre draws into a WebGL canvas, so none of this is readable from the DOM — a pane that
   * drew nothing looks exactly like a pane that drew three routes. The pane publishes what
   * MapLibre itself says is on screen when the tiles stop arriving (`data-routes-drawn`,
   * `data-basemap-features`, src/components/map/PlanMap.tsx), and that is what is asserted:
   * which vans have lines, and that there is a base map under them.
   */
  test("draws a route per van, follows a move, highlights one van, and saves the plan", async ({
    page,
  }) => {
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));

    await page.goto("/plan-preview");
    await expect(page.getByRole("heading", { level: 1, name: copy.heading })).toBeVisible();

    // The pane is a real map: a canvas of real size, with the licence text on it (ADR-008).
    const map = page.getByRole("region", { name: copy.mapLabel });
    await expect(map).toBeVisible();
    const canvas = map.locator("canvas.maplibregl-canvas");
    await expect(canvas).toBeVisible();
    const size = await boxOf(canvas);
    expect(size.width).toBeGreaterThan(240);
    expect(size.height).toBeGreaterThan(240);
    const pane = page.locator("[data-routes-drawn]");
    await expect(page.locator(".maplibregl-ctrl-attrib")).toBeAttached();
    // Neither tile notice is on screen: this is the drawn path, not the failure path.
    await expect(page.getByText(copy.mapEmpty)).toBeVisible();

    /*
     * Nothing is planned until staff ask for it, so the map opens with the centre and no lines —
     * and says which button draws them, rather than sitting there as an empty frame.
     */
    await expect(pane).toHaveAttribute("data-routes-drawn", "", { timeout: 60_000 });

    await plan(page);
    // One line per van, and the vans are the three lanes on the screen.
    const laneIds = (await lanes(page)).map((lane) => lane.id);
    await expect(pane).toHaveAttribute("data-routes-drawn", [...laneIds].sort().join(","), {
      timeout: 60_000,
    });
    /*
     * There is a base map under the lines. The number is lower than the fleet pane's bar (200)
     * because this pane is a third of the width and half the height of that one — what is being
     * asserted is that positron drew *something* real here, which is the difference between a
     * map and the empty canvas MapLibre leaves behind when its tile worker fails to load.
     */
    await expect
      .poll(async () => Number(await pane.getAttribute("data-basemap-features")), {
        timeout: 60_000,
        message: "no basemap features rendered: the tiles did not draw",
      })
      .toBeGreaterThan(50);
    await expect(page.getByText(copy.mapEmpty)).toHaveCount(0);

    /*
     * §9: the map is never the only way to read it. One row per van, naming the van in words and
     * counting the stops it drives — which is also how a move is read below, because a count is
     * something a browser check can compare and a drawn line is not.
     */
    const vans = page.getByRole("list", { name: copy.mapVansHeading });
    await expect(vans).toBeVisible();
    const rows = vans.getByRole("listitem");
    expect(await rows.count()).toBe(laneIds.length);
    const rowOf = (laneId: string) => page.locator(`[data-van-line="${laneId}"]`);
    const stopsOn = async (laneId: string): Promise<number> => {
      const text = (await rowOf(laneId).innerText()).trim();
      const count = STOP_COUNT.exec(text);
      expect(count, `${laneId} does not say how many stops it drives: ${text}`).not.toBeNull();
      return Number(count?.[1]);
    };
    for (const laneId of laneIds) {
      const van = (await lanes(page)).find((lane) => lane.id === laneId)?.van ?? "";
      const stops = await stopsOn(laneId);
      expect(stops).toBeGreaterThan(0);
      // The row is the van's own name and its stop count, with the noun on the number.
      await expect(rowOf(laneId)).toHaveText(
        fill(copy.mapVanRow, { vehicle: van, stops: pluralize(stops, countable.stop) }),
      );
    }

    /*
     * The map draws the lanes' own stops, which is checked as an invariant rather than as a
     * number: every van's line has exactly as many stops as that van has distinct kerbs among
     * its riders. Read off both sides of the screen — the kerb out of each rider's own row, the
     * count out of the row under the map — so the two can only agree by being one answer.
     */
    const expectMapAgreesWithLanes = async (when: string) => {
      for (const laneId of laneIds) {
        const kerbs = await kerbsIn(page, laneId);
        expect(
          { when, laneId, stops: await stopsOn(laneId) },
          `${laneId} draws a different number of stops than it carries`,
        ).toEqual({ when, laneId, stops: kerbs.length });
      }
    };
    await expectMapAgreesWithLanes("planned");

    /* ── a move between lanes moves on the map ── */
    const moved = await moveWhoeverFits(page);
    expect((await lanes(page)).find((lane) => lane.id === moved.to)?.riders).toContain(moved.child);
    expect((await lanes(page)).find((lane) => lane.id === moved.from)?.riders).not.toContain(
      moved.child,
    );
    // The map followed, in the same render and from the same plan.
    await expectMapAgreesWithLanes("after the move");
    // And the van that gained a rider draws the kerb that rider is picked up at.
    const gained = await kerbsIn(page, moved.to);
    expect(gained).toContain(moved.kerb);
    expect(await stopsOn(moved.to)).toBe(gained.length);

    const to = (await lanes(page)).find((lane) => lane.id === moved.to);
    if (!to) return;

    /* ── selecting a lane highlights its route ── */
    const lane = laneOf(page, to.id);
    const show = lane.getByRole("button", { name: copy.showOnMap, exact: true });
    await expect(show).toHaveAttribute("aria-pressed", "false");
    await show.click();
    // Said in three places and never in colour alone: the lane, its button, and the row under
    // the map — which is the same one selection, however it was made.
    await expect(lane).toHaveAttribute("data-selected", "true");
    await expect(show).toHaveAttribute("aria-pressed", "true");
    await expect(rowOf(to.id)).toHaveAttribute("aria-pressed", "true");
    for (const other of laneIds.filter((id) => id !== to.id)) {
      await expect(rowOf(other)).toHaveAttribute("aria-pressed", "false");
      await expect(laneOf(page, other)).not.toHaveAttribute("data-selected", "true");
    }
    // Every line is still drawn: the others are dimmed, not removed.
    await expect(pane).toHaveAttribute("data-routes-drawn", [...laneIds].sort().join(","));
    // The camera flies to the van that was picked (600 ms, §5.1), so the picture is taken once
    // the tiles for where it landed have arrived rather than halfway there.
    await page.waitForLoadState("networkidle");
    console.log("screenshot:", await shot(page, "plan-routes-map-selected"));

    // And back to all three, from the control that says so.
    await page.getByRole("button", { name: copy.mapShowAll, exact: true }).click();
    await expect(show).toHaveAttribute("aria-pressed", "false");
    await expect(lane).not.toHaveAttribute("data-selected", "true");

    /* ── saving ── */
    const save = page.getByRole("button", { name: copy.save, exact: true });
    const unsaved = page.locator("[data-unsaved]");
    await expect(save).toBeEnabled();
    // There is a plan on the screen and the server has not been told about it, which the row
    // with the button says in words (Vera's review, 2026-10-17).
    await expect(unsaved).toHaveText(copy.unsaved);

    await save.click();
    // The minute the server kept it at, read out on the clock at the centre — not the browser's
    // local time, and not a time the screen made up: the endpoint's own record says the same.
    await expect(page.locator("[data-notice]")).toHaveText(SAVED_LINE);
    const kept = await page.request.get(
      `${SAVE_ENDPOINT}?scenario=EVERY_RIDER_FITS&direction=AM`,
    );
    const savedAt: string = (await kept.json()).saved.savedAt;
    await expect(page.locator("[data-notice]")).toHaveText(
      fill(copy.saved, { time: siteClock(savedAt) }),
    );
    // Saving is not sending, and the saved line says so in the same breath.
    expect(copy.saved).toContain("No family has been told");
    // Saved is saved: the notice beside the button is gone until something changes again.
    await expect(unsaved).toHaveCount(0);

    // And one more move makes it true again, because the screen now differs from what was kept.
    await moveWhoeverFits(page);
    await expect(unsaved).toHaveText(copy.unsaved);

    await expectNoInternalCodes(page);
    await expectNoVehicleCodes(page);
    await expectVioletOnlyOnDemoChrome(page);
    expect(failures, `page errors: ${failures.join("; ")}`).toEqual([]);
    await page.waitForLoadState("networkidle");
    console.log("screenshot:", await shot(page, "plan-routes-map-and-save"));
  });

  /**
   * The refusal, over the wire. The screen will not send a plan it refused, so this is the plan
   * arriving from something that is not the screen — the same request a `curl` would make — and
   * it is refused by the solver on the server, in the sentence the screen would have shown.
   */
  test("a refused move cannot be saved by posting it straight to the endpoint", async ({
    page,
    request,
  }) => {
    await page.goto("/plan-preview");
    // The scenario where no van has four-point straps, so this is the one move the screen
    // refuses — read off the screen first, so the refusal below is the same verdict.
    const toggle = page.locator('[data-demo-control="true"]');
    await toggle.getByRole("button", { name: copy.demoScenario.ONE_RIDER_HAS_NO_VAN }).click();
    await plan(page);
    const group = page.locator("[data-unplaced]");
    await expect(group).toContainText(CHAIR_CHILD);

    const laneIds = (await lanes(page)).map((lane) => lane.id);
    // The lanes as the endpoint takes them: the van on each and what has been said about it.
    // No person: who is driving stays on the screen (src/app/plan-preview/save-plan.ts).
    const stages = Object.fromEntries(
      laneIds.map((id) => [id, { vehicleKey: id, arrival: "REPORTED" }]),
    );
    const forced = {
      scenario: "ONE_RIDER_HAS_NO_VAN",
      direction: "AM",
      stages,
      measured: [],
      // The chair, in the van the screen just refused it for.
      assignment: Object.fromEntries(laneIds.map((id, i) => [id, i === 0 ? ["C6"] : []])),
    };

    const refused = await request.post(SAVE_ENDPOINT, { data: forced });
    expect(refused.status()).toBe(422);
    const body = await refused.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain(CHAIR_CHILD);
    // The same words the screen would have used, and no code in them.
    expect(body.error).toMatch(/^Can’t put /);
    expect(body.error).not.toMatch(/\bV\d\b|\bC\d\b/);

    // Nothing was kept: the run still has no saved plan.
    const read = await request.get(
      `${SAVE_ENDPOINT}?scenario=ONE_RIDER_HAS_NO_VAN&direction=AM`,
    );
    expect(read.status()).toBe(200);
    expect((await read.json()).saved).toBeNull();

    // And the same request with another run's child in it is the uniform refusal instead.
    const swapped = await request.post(SAVE_ENDPOINT, {
      data: { ...forced, assignment: Object.fromEntries(laneIds.map((id, i) => [id, i === 0 ? ["C12"] : []])) },
    });
    expect(swapped.status()).toBe(404);
    expect((await swapped.json()).error).toBe(copy.saveNotThisRun);
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

    await page.goto("/plan-preview");
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
    // The save is the one request this screen makes on purpose, so it is in the walk.
    await page.getByRole("button", { name: copy.save, exact: true }).click();
    await expect(page.locator("[data-notice]")).toHaveText(SAVED_LINE);
    await page.waitForLoadState("networkidle");

    // No routing provider and no geocoder: there is no *.googleapis.com request to make.
    expect(seen.filter((r) => /googleapis\.com/i.test(r.url))).toEqual([]);

    /*
     * One host off this origin, and it is the base map's (ADR-008 / DESIGN-DIRECTION §5.1): the
     * positron style, its glyphs, its sprites and its tiles. Asserted as a *host* rather than as
     * an allowance for "anything that looks like tiles", so a second provider — a geocoder, an
     * analytics beacon, a font CDN — fails this check the day it arrives.
     */
    const tileHost = new URL(DEFAULT_MAP_STYLE_URL).host;
    const offSite = seen.filter((r) => !r.url.startsWith("http://127.0.0.1:"));
    expect([...new Set(offSite.map((r) => new URL(r.url).host))]).toEqual([tileHost]);
    // And the map asks the tile server for tiles: no body, so nothing of the day is in one.
    expect(offSite.filter((r) => r.body.length > 0).map((r) => r.url)).toEqual([]);
    expect(offSite.filter((r) => r.method !== "GET").map((r) => r.url)).toEqual([]);

    /*
     * The only payload on the page is the plan being saved, and it goes to this app's own origin.
     * What it carries is the day's own ids — which lane holds which child token — and nothing a
     * family could be identified by: no names, no places, no phone, no family code. The server
     * re-asks the solver about those ids (src/domain/plan/save.ts); it is handed no sentence to
     * repeat and no address to look up.
     */
    const bodies = seen.filter((r) => r.body.length > 0);
    expect(bodies.map((r) => `${r.method} ${new URL(r.url).host}`)).toEqual([
      `POST ${new URL(page.url()).host}`,
    ]);
    for (const payload of bodies.map((r) => r.body)) {
      expect(payload).not.toMatch(/\bF\d{1,2}\b/);
      expect(payload).not.toMatch(/\+1-561/);
    }

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
