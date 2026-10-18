import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyPlan, unassignedRiders, type BoardPlan } from "@/domain/plan/board";
import { applyPending, enqueue, NO_PENDING } from "@/domain/plan/pending";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { testDay, vanIdOfSlot } from "@/test/board-day";
import { planBoard } from "@/ui/copy";
import { rejectCardLine } from "./lines";
import { UnassignedColumn } from "./UnassignedColumn";
import { VanColumn } from "./VanColumn";

/**
 * THE BOARD AT 390, AS png/plan-board-390.png DRAWS IT — Vera's visual check of b3453cd.
 *
 * Three findings, and each one is held here rather than left to the next screenshot:
 *
 *  1. a `Move to…` select stood open under every Family drives card, which doubled the lane's
 *     height — and the van cards in the mockup carry no such control. The control is behind the
 *     card's hold now, in both lanes, and the board says how once above the columns;
 *  2. the one column a phone shows filled about 45 % of the width, because
 *     `.column[data-role="unassigned"]`'s 176 px outranks a bare `.column` in the 390 block;
 *  3. the column tabs were wearing the leg switch's segmented control instead of the mockup's
 *     chips.
 *
 * (1) is rendered — a Family drives card against a van card, part for part — and (2) and (3) are
 * read out of the stylesheet, which is where a width lives. Rendering cannot see a media query
 * and a screenshot is not a test, so the rule itself is the assertion.
 */
const CSS = readFileSync(path.join(__dirname, "board.module.css"), "utf8");
/** Comments are not rules: a file may describe a width it does not set. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Ana S., one of the three the centre does not drive. */
const ANA = childTokenOf("C10");
const COLUMNS = [{ id: null as string | null, name: planBoard.unassigned }];

/** Every css-module class on an element, in order, by the name it was written under. */
function classesOf(html: string): string[] {
  return [...html.matchAll(/class="_([A-Za-z]+)_[a-z0-9]+"/g)].map((match) => match[1]);
}

/** One card's `<li>`, from the token on its button. */
function cardOf(html: string, token: string): string {
  const at = html.indexOf(`data-rider="${token}"`);
  expect(at, token).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<li>", at);
  return html.slice(start, html.indexOf("</li>", at) + "</li>".length);
}

function lane(day: Awaited<ReturnType<typeof testDay>>, plan: BoardPlan, lifted = false): string {
  return renderToStaticMarkup(
    createElement(UnassignedColumn, {
      day,
      plan,
      shown: true,
      columns: COLUMNS,
      onMove: () => undefined,
      onMoveToBucket: () => undefined,
      onOpenChild: () => undefined,
      canEdit: true,
      overBucket: null,
      lifted,
    }),
  );
}

function vanColumn(day: Awaited<ReturnType<typeof testDay>>, plan: BoardPlan, vanId: string): string {
  const van = day.vans.find((candidate) => candidate.id === vanId);
  if (!van) throw new Error(`no van ${vanId}`);
  return renderToStaticMarkup(
    createElement(VanColumn, {
      van,
      day,
      plan,
      minutes: 38,
      reject: undefined,
      hovered: false,
      selected: false,
      shown: true,
      columns: COLUMNS,
      onMove: () => undefined,
      onMoveToBucket: () => undefined,
      onOpenChild: () => undefined,
      canEdit: true,
      openChildToken: null,
      rampHref: null,
    }),
  );
}

describe("a Family drives card is a van card, part for part", () => {
  it("carries the van card's own move control and nothing extra", async () => {
    const day = await testDay("PM");
    const vanOne = vanIdOfSlot(1);
    const rider = day.riders[0];
    const plan = applyPending(
      emptyPlan(day),
      enqueue(NO_PENDING, { childToken: rider.token, bucket: "VAN", vanId: vanOne }),
    );

    const family = cardOf(lane(day, plan), ANA);
    const inVan = cardOf(vanColumn(day, plan, vanOne), rider.token);

    // One control each, and it is the same control: one `<select>`, one `Move to…` label.
    for (const [card, where] of [[family, "family"], [inVan, "van"]] as const) {
      expect(card.match(/<select\b/g), where).toHaveLength(1);
      expect(card.match(/data-move-to=/g), where).toHaveLength(1);
      expect(card.match(/_moveTo_/g), where).toHaveLength(1);
    }

    /*
     * And the same parts in the same order. The one difference is the first cell, which is the
     * stop number a van drives the child at: a child in no van has the grip there instead.
     */
    expect(classesOf(family).filter((name) => name !== "grip")).toEqual(
      classesOf(inVan).filter((name) => name !== "stopBadge"),
    );
  });

  it("says the lane's own words on its second line, never 'No pickup stop'", async () => {
    const day = await testDay("PM");
    const card = cardOf(lane(day, emptyPlan(day)), ANA);

    expect(card).toContain(`_cardSub_`);
    expect(card.slice(card.indexOf("_cardSub_"))).toContain(planBoard.familyDrives);
    expect(card).not.toContain("No pickup stop");
    expect(planBoard).not.toHaveProperty("noStop");
  });

  it("takes the van columns' dashed drop outline the moment a card is lifted", async () => {
    const day = await testDay("PM");
    const plan = emptyPlan(day);

    const still = lane(day, plan);
    const held = lane(day, plan, true);
    const familyOf = (html: string) =>
      html.slice(html.indexOf('data-bucket="FAMILY_DRIVES"'), html.indexOf('data-bucket="ABSENT"'));

    // The van column's own attribute, not a second one (VanColumn.tsx `data-fit`).
    expect(familyOf(still)).not.toContain('data-fit="yes"');
    expect(familyOf(held)).toContain('data-fit="yes"');
    // Absent is not a lane a lifted card is offered: it stays as it was.
    expect(held.slice(held.indexOf('data-bucket="ABSENT"'))).not.toContain('data-fit="yes"');
  });

  it("draws the outline from the same declarations the vans use", () => {
    const blockOf = (selector: string) =>
      RULES.slice(RULES.indexOf(`${selector} {`), RULES.indexOf("}", RULES.indexOf(`${selector} {`)));
    const van = blockOf('.column[data-fit="yes"]');
    const group = blockOf('.group[data-fit="yes"]');

    for (const declaration of ["outline: 2px dashed var(--color-brand)", "outline-offset: -2px"]) {
      expect(van, declaration).toContain(declaration);
      expect(group, declaration).toContain(declaration);
    }
  });
});

describe("what a card says when a van refuses it", () => {
  it("is the card's own second line, with a coral edge — not a bar under the card", async () => {
    const day = await testDay("PM");
    const rider = day.riders[0];
    const plan = emptyPlan(day);
    const vanOne = day.vans[0];
    // The board's own line, built where every refusal line is built (lines.ts), not a string.
    const line = rejectCardLine(vanOne.name, "SEAT");

    const html = renderToStaticMarkup(
      createElement(UnassignedColumn, {
        day,
        plan,
        shown: true,
        columns: COLUMNS,
        onMove: () => undefined,
        onMoveToBucket: () => undefined,
        onOpenChild: () => undefined,
        canEdit: true,
        overBucket: null,
        refusal: { childToken: rider.token, reason: "SEAT" as const, line },
      }),
    );
    const card = cardOf(html, rider.token);

    // Inside the card's button, on the subline, and nowhere else: one element carries it.
    expect(card.match(/data-refusal=/g)).toHaveLength(1);
    expect(card).toMatch(/_cardSub_[a-z0-9]+"[^>]*data-refusal=/);
    expect(card.slice(0, card.indexOf("</button>"))).toContain(`data-refusal="${rider.token}"`);
    expect(card).toContain(`data-tone="crit">${line}`);
    // It replaces the second line rather than being added to it.
    expect(card.match(/_cardSub_/g)).toHaveLength(1);
    expect(card).not.toContain(rider.stopLabel);
    // And the card itself is the thing marked, which is what the coral border is for.
    expect(card).toContain('data-refused="true"');
    // No strip of its own under the card any more.
    expect(card).not.toContain("_refusal_");
  });

  it("paints it in alert text on a coral edge, both from tokens", () => {
    const sub = RULES.slice(
      RULES.indexOf('.cardSub[data-tone="crit"] {'),
      RULES.indexOf("}", RULES.indexOf('.cardSub[data-tone="crit"] {')),
    );
    const card = RULES.slice(
      RULES.indexOf('.card[data-refused="true"] {'),
      RULES.indexOf("}", RULES.indexOf('.card[data-refused="true"] {')),
    );

    // `crit-fg` on the card's surface is the §8 pair at 8.31:1; coral is the edge, never the
    // words (src/ui/tokens.ts: coral is 2.99:1 against white).
    expect(sub).toContain("color: var(--color-crit-fg)");
    expect(card).toContain("border-color: var(--color-alert)");
    expect(`${sub}${card}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // The old strip's rule is gone, not merely unused.
    expect(RULES).not.toMatch(/^\.refusal\s*\{/m);
  });
});

describe("the two counts the board had too many of", () => {
  it("drops the Unassigned chip at zero and keeps the warn count while anybody waits", async () => {
    const day = await testDay("PM");
    const waiting = lane(day, emptyPlan(day));

    // Somebody is waiting: a warn chip with how many (png/plan-board.png draws the count).
    const header = waiting.slice(0, waiting.indexOf("</div>"));
    expect(header).toContain("data-unassigned-count");
    expect(header).toContain('data-tone="warn"');
    expect(header.slice(header.indexOf("data-unassigned-count"))).toContain(
      String(unassignedRiders(day, emptyPlan(day)).length),
    );
    expect(unassignedRiders(day, emptyPlan(day)).length).toBeGreaterThan(0);

    // Nobody is: no chip at all, and the green line says so in a word.
    const placed = day.riders.reduce(
      (plan, rider) =>
        applyPending(
          plan,
          enqueue(NO_PENDING, { childToken: rider.token, bucket: "VAN", vanId: vanIdOfSlot(1) }),
        ),
      emptyPlan(day),
    );
    const clear = lane(day, placed);
    expect(clear).not.toContain("data-unassigned-count");
    expect(clear).toContain(planBoard.allPlaced);
  });

  it("leaves 'Using default setup' to the board's banner, not to every van column", async () => {
    const day = await testDay("PM");
    const plan = emptyPlan(day);
    // `testDay` leaves a van on its configured defaults unless a test counts it, which is
    // exactly an unconfirmed van.
    const unchecked = day.vans.find((van) => van.setupState === "DEFAULT");
    expect(unchecked).toBeDefined();
    const html = vanColumn(day, plan, unchecked?.id ?? "");

    expect(html).not.toContain(planBoard.usingDefault);
    expect(html).not.toContain(planBoard.notChecked);
    // A van the ramp counted keeps its chip, which is the one thing the column still says.
    const checkedDay = await testDay("PM", { 2: { seats: 5 } });
    const checked = checkedDay.vans.find((van) => van.setupState === "CHECKED");
    expect(vanColumn(checkedDay, emptyPlan(checkedDay), checked?.id ?? "")).toContain(
      planBoard.checked,
    );
  });
});

describe("the 390 rules png/plan-board-390.png is drawn by", () => {
  /** The block of the media query that holds the one-column rules. */
  const phone = (() => {
    const at = RULES.indexOf('.column[data-shown="false"]');
    expect(at).toBeGreaterThan(-1);
    return RULES.slice(RULES.lastIndexOf("@media", at), RULES.indexOf("\n}", at));
  })();

  it("gives the shown column the whole width, Unassigned included", () => {
    // Named explicitly, because `.column[data-role="unassigned"]` outranks a bare `.column`.
    expect(phone).toMatch(/\.column,\s*\.column\[data-role="unassigned"\]\s*\{[^}]*flex: 1 1 auto/);
    expect(phone).toMatch(/\.column,\s*\.column\[data-role="unassigned"\]\s*\{[^}]*width: 100%/);
    // And nothing beside it to scroll to.
    expect(phone).toMatch(/\.columns\s*\{[^}]*overflow-x: visible/);
  });

  it("leaves no `Move to…` select standing open on a card", () => {
    expect(phone).not.toMatch(/\.moveTo\s*\{\s*display: block/);
    // The one rule that opens it is the card's own hold, at every width.
    expect(RULES).toMatch(/\.moveTo\[data-open="true"\]\s*\{\s*display: block/);
    // And the phone's hint is shown instead.
    expect(phone).toMatch(/\.moveHint\s*\{\s*display: flex/);
  });

  it("draws the column tabs as the one pill, with the brand edge on the one that is on", () => {
    const tab = RULES.slice(RULES.indexOf(".vanTab {"), RULES.indexOf("}", RULES.indexOf(".vanTab {")));
    expect(tab).toContain('composes: pill from "../../../ui/Pill.module.css"');
    expect(tab).toContain('composes: outline from "../../../ui/Pill.module.css"');
    // A tab is a thumb target, not a label.
    expect(tab).toContain("height: var(--target-console)");

    const on = RULES.slice(
      RULES.indexOf('.vanTab[aria-selected="true"] {'),
      RULES.indexOf("}", RULES.indexOf('.vanTab[aria-selected="true"] {')),
    );
    expect(on).toContain("background: var(--color-selected-bg)");
    expect(on).toContain("border-color: var(--color-brand)");
    expect(on).toContain("color: var(--color-ink-brand)");
    // No colour literal: every value above is a token (src/ui/no-hex.test.ts holds the rule).
    expect(`${tab}${on}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
