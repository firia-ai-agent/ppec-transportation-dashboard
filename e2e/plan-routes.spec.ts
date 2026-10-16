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
import { fill, planRoutes as copy, securement, solver } from "../src/ui/copy";
import { capabilityStates, reservationStates } from "../src/ui/states";
import {
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

/** The chair the ramp measures when the equipment that arrives is not the equipment on file. */
const MEASURED_CHAIR = "Chair measured at the ramp · 142 × 74 cm";
/** The one child in the scenario whose chair is held by four-point straps. */
const CHAIR_CHILD = "Zoe B.";

type Lane = {
  id: string;
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

/** Who is in the group at the top of the screen, and what each row says about them. */
async function unplacedRows(page: Page): Promise<string[]> {
  const group = page.locator("[data-unplaced]");
  if ((await group.count()) === 0) return [];
  return (await group.innerText()).split("\n").filter((line) => line.trim().length > 0);
}

async function plan(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: copy.plan, exact: true });
  const again = page.getByRole("button", { name: copy.planAgain, exact: true });
  if (await button.count()) await button.click();
  else await again.click();
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
    const seats = /Anchored seats: (\d+) needed, (\d+) free/.exec(text);
    expect(seats, `${label} does not say how many anchored seats it has`).not.toBeNull();
    expect(Number(seats?.[1]), `${label} anchored seats used`).toBe(anchored);
    expect(Number(seats?.[1])).toBeLessThanOrEqual(Number(seats?.[2]));

    const walking = /\bSeats: (\d+) needed, (\d+) free/.exec(text);
    expect(Number(walking?.[1])).toBeLessThanOrEqual(Number(walking?.[2]));
  }
}

/**
 * Drag a rider's row onto a lane.
 *
 * The events are dispatched rather than mimed with the mouse: headless Chromium does not start
 * a native drag session for a synthetic mouse gesture (Playwright's own `dragTo` and a stepped
 * `mouse.move` both leave the page untouched here), so a mouse-shaped check would pass while
 * testing nothing. What is dispatched is exactly what a browser sends — dragstart on the row
 * with a real `DataTransfer`, then dragover and drop on the lane — so the screen's own handlers,
 * the token it puts on the transfer and the solver call behind the drop are all the real ones.
 * The pointer-free way to do the same thing is the Move menu, and it is checked below as well.
 */
async function dragRider(page: Page, child: string, laneId: string): Promise<void> {
  await page.evaluate(
    ([rowSelector, laneSelector]) => {
      const transfer = new DataTransfer();
      const row = document.querySelector(rowSelector);
      const lane = document.querySelector(laneSelector);
      if (!row || !lane) throw new Error(`nothing to drag: ${rowSelector} → ${laneSelector}`);
      const event = (type: string) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      row.dispatchEvent(event("dragstart"));
      lane.dispatchEvent(event("dragover"));
      lane.dispatchEvent(event("drop"));
      row.dispatchEvent(event("dragend"));
    },
    [`[data-rider="${child}"]`, `[data-lane="${laneId}"]`],
  );
}

test.describe("Plan routes", () => {
  test("plans every child into a van that fits their equipment, and covers every drop-off", async ({
    page,
  }) => {
    await page.goto("/plan-preview");
    await expect(page.getByRole("heading", { level: 1, name: copy.heading })).toBeVisible();
    await expectDemoBarPinned(page);
    await expectVioletOnlyOnDemoChrome(page);

    // Nothing is planned until staff ask for it: every child is in the group at the top, and
    // that group is where the roster for this check comes from.
    const before = await unplacedRows(page);
    const roster = before
      .flatMap((line) => [...line.matchAll(/([A-Z][a-z]+ [A-Z]\.)/g)].map((m) => m[1]))
      .filter((name, index, all) => all.indexOf(name) === index);
    expect(roster.length).toBeGreaterThanOrEqual(9);
    for (const lane of await lanes(page)) {
      expect(lane.riders, `${lane.id} before planning`).toEqual([]);
      expect(lane.text).toContain(copy.laneEmpty);
    }

    await plan(page);

    // Every child, once, in a van the solver called a fit — and the screen says so in words.
    expect(await page.locator("[data-unplaced]").count()).toBe(0);
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
    await expectEquipmentFits(page);
    await expectNoInternalCodes(page);
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
    console.log("screenshot:", await shot(page, "plan-routes-afternoon"));
  });

  test("refuses a drag the van cannot take, in one line that names the child", async ({ page }) => {
    await page.goto("/plan-preview");
    await plan(page);

    const from = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD));
    expect(from, `${CHAIR_CHILD} is planned into a van`).toBeDefined();
    const target = (await lanes(page)).find((lane) => lane.id !== from?.id);
    const targetLabel = (await laneOf(page, target?.id ?? "")
      .getByRole("heading", { level: 3 })
      .innerText()).split(" ")[0];
    const rider = laneOf(page, from?.id ?? "").locator(`[data-rider="${CHAIR_CHILD}"]`);

    // The drag itself, as staff do it: the centre van's position is L-track hardware and this
    // chair is held by four-point straps, so the van cannot take her.
    await dragRider(page, CHAIR_CHILD, target?.id ?? "");

    const notice = page.locator("[data-notice]");
    await expect(notice).toHaveAttribute("data-refused", "true");
    await expect(notice).toContainText(CHAIR_CHILD);
    await expect(notice).toContainText(securement.FOUR_POINT_STRAP);
    // Nothing moved: she is still in the lane she was planned into, and the target did not
    // take her.
    const after = await lanes(page);
    expect(after.find((lane) => lane.id === from?.id)?.riders).toContain(CHAIR_CHILD);
    expect(after.find((lane) => lane.id === target?.id)?.riders).not.toContain(CHAIR_CHILD);
    expect(after.every((lane) => lane.verdict === "FEASIBLE")).toBe(true);
    console.log("screenshot:", await shot(page, "plan-routes-move-refused"));

    // And the same refusal through the keyboard's way in, because a drag is never the only way.
    await rider.getByRole("button", { name: new RegExp(`^Move ${CHAIR_CHILD}`) }).click();
    await page
      .getByRole("button", { name: fill(copy.moveTo, { vehicle: targetLabel }), exact: true })
      .first()
      .click();
    await expect(notice).toHaveAttribute("data-refused", "true");
    await expectNoInternalCodes(page);
  });

  test("AT-04: equipment unknown until arrival stops boarding and asks for a person", async ({
    page,
  }) => {
    await page.goto("/plan-preview");
    await plan(page);

    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);

    // Half one: nobody has reported on the van at all. That is the normal state of a morning,
    // and it is never read as a yes — the lane carries nobody's boarding.
    await lane.getByRole("button", { name: copy.arrival.NOT_CHECKED, exact: true }).click();
    await expect(lane).toHaveAttribute("data-verdict", "CAPABILITY_PENDING");
    await expect(lane).toContainText(capabilityStates.UNKNOWN.label);
    await expect(lane).toContainText(copy.laneNeedsCheck);
    console.log("screenshot:", await shot(page, "plan-routes-at04-unknown"));

    // Half two: the van is reported, and the chair that arrives is not the chair on file. The
    // run is infeasible *before* anyone boards, and every way out needs a coordinator.
    await lane.getByRole("button", { name: copy.arrival.REPORTED, exact: true }).click();
    await expect(lane).toHaveAttribute("data-verdict", "FEASIBLE");
    const rider = lane.locator(`[data-rider="${CHAIR_CHILD}"]`);
    await rider.getByRole("button", { name: new RegExp(`^Measure ${CHAIR_CHILD}`) }).click();

    await expect(lane).toHaveAttribute("data-verdict", "INFEASIBLE");
    await expect(lane).toContainText(reservationStates.INFEASIBLE.label);
    await expect(lane).toContainText(MEASURED_CHAIR);
    await expect(lane).toContainText(copy.laneBlocked);
    await expect(lane.getByText(copy.needsApproval).first()).toBeVisible();
    // The child is still on the run: the solver proposes and a human decides, so nobody is
    // quietly taken off a van.
    await expect(rider).toBeVisible();
    await expectNoInternalCodes(page);
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

    // 1. The provider sends a different van, with a different driver.
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    const spare = lane.getByRole("button", { name: /^V3 · / });
    await expect(spare).toBeVisible();
    await spare.click();

    await expect(lane.getByRole("heading", { level: 3 })).not.toHaveText(was);
    await expect(lane).toContainText("Omar T.");
    // 2. Nothing is known about it yet, and the lane says which kind of unknown this is.
    await expect(lane).toHaveAttribute("data-verdict", "CAPABILITY_PENDING");
    await expect(lane).toContainText(capabilityStates.CHANGED.label);
    await expect(lane).toContainText(solver.pending.substituted);
    // The picture is evidence, so frame the lane that changed rather than wherever the last
    // click left the page.
    await lane.getByRole("heading", { level: 3 }).scrollIntoViewIfNeeded();
    console.log("screenshot:", await shot(page, "plan-routes-at05-substituted"));

    // 3. The provider is asked again, and answers.
    await lane.getByRole("button", { name: copy.askProvider, exact: true }).click();
    await expect(lane).toContainText(capabilityStates.REQUESTED.label);
    await lane.getByRole("button", { name: copy.recordAnswer, exact: true }).click();

    // 4. Re-solved against the substitute's own hardware, which does not hold this chair.
    await expect(lane).toHaveAttribute("data-verdict", "INFEASIBLE");
    await expect(lane).toContainText(securement.FOUR_POINT_STRAP);
    await expect(lane).toContainText(copy.laneBlocked);
    await lane.getByRole("heading", { level: 3 }).scrollIntoViewIfNeeded();
    console.log("screenshot:", await shot(page, "plan-routes-at05-resolved"));

    // A driver substitution is the other half of AT-05, and it changes nothing about what the
    // van can carry — so the verdict is the same before and after.
    const verdict = await lane.getAttribute("data-verdict");
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    await lane.getByRole("button", { name: copy.substituteDriver, exact: true }).click();
    await expect(page.locator("[data-notice]")).toContainText("driving");
    await expect(lane).toHaveAttribute("data-verdict", verdict ?? "");
    await expectNoInternalCodes(page);
  });

  test("AT-12: a child with no van is named a reason, and no family is told first", async ({
    page,
  }) => {
    await page.goto("/plan-preview");
    await plan(page);

    // Take away the one van built for this chair, the way a provider does: a substitution.
    const laneId = (await lanes(page)).find((lane) => lane.riders.includes(CHAIR_CHILD))?.id ?? "";
    const lane = laneOf(page, laneId);
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    await lane.getByRole("button", { name: /^V3 · / }).click();
    await lane.getByRole("button", { name: copy.askProvider, exact: true }).click();
    await lane.getByRole("button", { name: copy.recordAnswer, exact: true }).click();
    await plan(page);

    // She is in the group at the top, with one plain line that names her and what is missing.
    const group = page.locator("[data-unplaced]");
    await expect(group).toBeVisible();
    await expect(group).toContainText(`No van with ${securement.FOUR_POINT_STRAP} for ${CHAIR_CHILD}`);
    await expect(group).toContainText(CHAIR_CHILD);

    // Every way out is a proposal for a named human, and the family has been told nothing.
    await expect(group.getByText(copy.needsApproval).first()).toBeVisible();
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
    await expect(page.getByText(copy.optionsNote).first()).toBeVisible();

    // Nobody else lost their van, and no lane was auto-reshuffled around her.
    const rows = await unplacedRows(page);
    const names = rows.flatMap((line) => [...line.matchAll(/([A-Z][a-z]+ [A-Z]\.)/g)].map((m) => m[1]));
    expect([...new Set(names)]).toEqual([CHAIR_CHILD]);

    await expectNoInternalCodes(page);
    await expectVioletOnlyOnDemoChrome(page);
    console.log("screenshot:", await shot(page, "plan-routes-at12-no-van"));
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
    await lane.getByRole("button", { name: copy.substitute, exact: true }).click();
    await lane.getByRole("button", { name: /^V3 · / }).click();
    await lane.getByRole("button", { name: copy.askProvider, exact: true }).click();
    await lane.getByRole("button", { name: copy.recordAnswer, exact: true }).click();
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
