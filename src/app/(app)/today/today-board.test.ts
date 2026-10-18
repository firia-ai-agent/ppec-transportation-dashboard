import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { buildBoard, demoDay, serviceDayFor, type LegRow } from "@/domain/board/board";
import { DEMO_SERVICE_DATE } from "@/domain/board/day";
import {
  board as boardCopy,
  drawer,
  fill,
  needCategories,
  places,
  serviceDate,
} from "@/ui/copy";
import { legStates, therapySessionStates } from "@/ui/states";
import { clockLabel, demoDateIso, demoDateLabel } from "@/ui/service-date";
import { stepsFor } from "@/ui/step-strip";
import { TodayBoard } from "./TodayBoard";
import { LegDrawer } from "./LegDrawer";
import { nextStepCellText } from "./next-step";

/**
 * The board and the drawer as markup (SURF-01 / SURF-02).
 *
 * These are the assertions a browser cannot make cheaply and a unit test can: which words are
 * on the screen, which state is announced, whether every state carries a label beside its icon,
 * whether the next step on a ride names the child it is for, and whether the one primary action
 * is disabled with the reason *in text* beside it rather than in a tooltip (§4.2, §9).
 * e2e/today-board.spec.ts then walks the same screen in a real browser for the things that are
 * only true once something is laid out.
 */

/** `renderToStaticMarkup` escapes an apostrophe, and half this copy has one in it. */
function escaped(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

const board = buildBoard();
/** The day before, read after the last van is in: the one with outcomes on it (AT-10, AT-13). */
const finished = buildBoard(serviceDayFor(demoDay().previousIso));
/** The day after, read before it starts: the plan, and the other day that is not "today". */
const planned = buildBoard(serviceDayFor(demoDay().nextIso));

const legsIn = (of: typeof board, key: string): LegRow[] => {
  const legs = of.legs.filter((l) => l.child.childKey === key);
  if (legs.length === 0) throw new Error(`no rows for ${key}`);
  return legs;
};
const legsOf = (key: string): LegRow[] => legsIn(board, key);
const legOf = (key: string, direction: "AM" | "PM"): LegRow => {
  const leg = legsOf(key).find((l) => l.ride.direction === direction);
  if (!leg) throw new Error(`no ${direction} row for ${key}`);
  return leg;
};

/**
 * The board as a director sees it, strip included: the strip lives under the board's own header
 * now (REDESIGN-SPEC §9.2), so it is one of the board's props rather than a sibling of it.
 */
function boardHtml(query = "", of: typeof board = board): string {
  return renderToStaticMarkup(
    createElement(TodayBoard, { board: of, query, steps: stepsFor("DIRECTOR") }),
  );
}

function drawerHtml(key: string, of: typeof board = board): string {
  return renderToStaticMarkup(
    createElement(LegDrawer, { legs: legsIn(of, key), day: of.day, onClose: () => {} }),
  );
}

describe("the board renders the day", () => {
  const html = boardHtml();

  /**
   * Vera's final call: one date on screen, the replayed demo day, labelled as the demo day —
   * and no switcher. The date is a fact to read, so a `<time>` and the words for what kind of
   * day it is; there is no arrow, no link and no form that would offer another one.
   */
  it("has one heading and one date, the demo day, labelled as the demo day", () => {
    expect(html).toContain(`>${boardCopy.heading}<`);
    /*
     * The day is read, not written down: the board prints the day the demo is being given on
     * (Firia, 2026-10-17 4:50 PM ET), so this asks the one helper what that is rather than
     * naming a date that is true for one day a year (src/ui/no-fixed-dates.test.ts bars one).
     */
    expect(html).toMatch(new RegExp(`datetime="${demoDateIso(DEMO_SERVICE_DATE)}"`, "i"));
    expect(html).toContain(demoDateLabel(DEMO_SERVICE_DATE));
    expect(html).toContain(serviceDate.phases.LIVE);
    // One date, once: the label, the date and the kind of day, and nothing else dated.
    expect(html.match(/<time/g)).toHaveLength(1);
    expect(html).toContain(serviceDate.groupLabel);
  });

  it("offers no way to change the day: no switcher anywhere on the board", () => {
    for (const of_ of [board, finished]) {
      const markup = boardHtml("", of_);
      expect(markup).not.toMatch(/href="\/today\?date=/);
      expect(markup).not.toMatch(/\bdate=\d{4}-\d{2}-\d{2}/);
      expect(markup).not.toMatch(/Previous day|Next day/);
    }
    // ...and the component that used to draw it is gone, not merely unmounted.
    expect(existsSync(path.join(__dirname, "..", "..", "..", "ui", "ServiceDateSwitcher.tsx"))).toBe(
      false,
    );
    expect(serviceDate).not.toHaveProperty("previousDay");
    expect(serviceDate).not.toHaveProperty("nextDay");
  });

  /**
   * And no way to ask for one by URL either, on a deployment (Veri #49). The route may read the
   * date only through the gated helper: a `?date=` is a test path or it is nothing, and the one
   * line that decides which is the one asserted here, because a page component is not something
   * a unit test can render.
   */
  it("reads the request's date and tick through the gate, never through the projection", () => {
    const page = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(page).toContain("requestedBoardDay(one(params.date), one(params[CLOCK_PARAM])");
    expect(page).toContain("process.env");
    // Neither the projection nor the clock may be reached around the gate.
    expect(page).not.toMatch(/serviceDayFor\s*\(/);
    expect(page).not.toMatch(/demoDayAtTick\s*\(/);
    expect(page).not.toMatch(/requestedServiceDay\s*\(/);
  });

  /**
   * The heading may only say "Today" on the day that is true of. A board of finished rides under
   * a heading that said "Today" would be the one false sentence on the screen.
   */
  it("names the day instead of saying 'Today' when it is showing another one", () => {
    for (const of_ of [finished, planned]) {
      const other = boardHtml("", of_);
      expect(other, of_.day.iso).toContain(
        fill(boardCopy.headingOtherDay, { date: of_.day.label }),
      );
      expect(other, of_.day.iso).not.toContain(`>${boardCopy.heading}<`);
      expect(other, of_.day.iso).toContain(serviceDate.phases[of_.day.phase]);
    }
  });

  /**
   * The same rule where only the ear reads: the table's caption is announced before the first
   * row, so a day that is not the demo day may not be introduced as "Today's rides" there
   * either (Veri #49).
   *
   * Both other phases, and the words rather than the constants. A finished day was the only one
   * asserted, which left the one that has not started — the plan — able to be captioned "Today's
   * rides" by any change that treated "not finished" as "today"; and asserting the constant
   * against itself would pass whatever the constant said, including a demo-day caption that had
   * quietly stopped saying "Today" at all.
   */
  it("captions the table with the day it is about, not with 'Today' (§9)", () => {
    expect(html).toContain(escaped(boardCopy.tableLabel));
    expect(html).toMatch(/<caption[^>]*>Today&#x27;s rides,/);

    for (const of_ of [finished, planned]) {
      const other = boardHtml("", of_);
      expect(other, of_.day.iso).toContain(
        escaped(fill(boardCopy.tableLabelOtherDay, { date: of_.day.label })),
      );
      expect(other, of_.day.iso).toMatch(
        new RegExp(`<caption[^>]*>Rides on ${of_.day.label},`),
      );
      expect(other, of_.day.iso).not.toContain(escaped(boardCopy.tableLabel));
      expect(other, of_.day.iso).not.toMatch(/Today&#x27;s rides/);
    }
  });

  it("stacks the groups with their counts, needs action first", () => {
    const headings = board.groups.map((g) =>
      fill(boardCopy.groupHeading, {
        group: boardCopy.groups[g.group],
        count: g.legs.length,
      }),
    );
    for (const heading of headings) expect(html).toContain(heading);
    const positions = headings.map((h) => html.indexOf(h));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  /**
   * One row per child *and* ride (AT-07). Each row is its own opener, so the two halves of a
   * child's day are two things a keyboard can land on and two things a screen reader can tell
   * apart — "Open Mia R., morning ride" and "Open Mia R., afternoon ride".
   */
  it("gives every child's morning and afternoon a row of its own", () => {
    for (const leg of board.legs) {
      const opener = fill(boardCopy.openRow, {
        child: leg.child.childLabel,
        ride: leg.ride.direction === "AM" ? boardCopy.amSpoken : boardCopy.pmSpoken,
      });
      expect(html, leg.key).toContain(opener);
    }
    expect(board.legs).toHaveLength(board.rows.length * 2);
  });

  it("every state on screen is an icon plus a label, announced as a state (§3, §9)", () => {
    // The chip writes "State: <label>" for a screen reader; the eye gets the icon and the label.
    expect(html).toContain(`State: ${legStates.EN_ROUTE_PICKUP.label}`);
    expect(html).toContain(`State: ${legStates.CAPABILITY_PENDING.label}`);
    // The states that used to be bare words in a cell now carry an icon and a label too.
    expect(html).toContain(`State: ${boardCopy.familyDrives}`);
    expect(html).toContain(`State: ${boardCopy.noPosition}`);
    expect(html).toContain(`State: ${boardCopy.noReceiver}`);
    expect(html).toContain(`State: ${therapySessionStates.SCHEDULED.label}`);
    expect(html).toContain(`State: ${fill(boardCopy.receiverNamed, { adult: "Alma R." })}`);
    expect(html).toMatch(/State: Stopped \d+ min/);
    // One icon per chip, and there are several chips a row.
    expect(html.match(/class="lucide/g)?.length ?? 0).toBeGreaterThan(board.legs.length * 3);
  });

  it("every row carries a source chip (NFR-09)", () => {
    const badges = html.match(/Source: Simulated/g) ?? [];
    expect(badges.length).toBe(board.legs.length);
  });

  /**
   * The taste rule this column exists for: a step is a thing to do, written as one. It opens
   * with a verb and it names the child it is done for — never a role, which is the one thing a
   * coordinator reading their own board already knows.
   */
  it("says the next step as a verb and a child's name, never as a role", () => {
    expect(html).toContain(escaped(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: "Noah O." })));
    expect(html).toContain(
      escaped(fill(boardCopy.nextSteps.ASK_ABOUT_VAN, { dispatcher: "Rae S.", child: "Mia R." })),
    );
    expect(html).toContain(boardCopy.nextSteps.NOTHING);
    for (const role of ["Coordinator", "Front desk", "Provider"]) {
      expect(html, role).not.toContain(`>${role}<`);
    }
    // Every step on this board is either an instruction or the honest absence of one.
    for (const leg of board.legs) {
      const text = nextStepCellText(leg);
      expect(html, leg.key).toContain(escaped(text));
      expect(text, leg.key).not.toMatch(/\{\w+\}/);
    }
  });

  it("names the adult who receives each child, rather than saying one exists", () => {
    expect(html).toContain(fill(boardCopy.receiverNamed, { adult: "Alma R." }));
    expect(html).toContain(boardCopy.noReceiver);
  });

  /**
   * The hint line is gone (Vera's review, 2026-10-17 2:44 PM ET) and the keys are not: J and K
   * still move between rides and Enter still opens one (`onKeyDown` below), and every row is
   * reachable by Tab and by its own button, so nothing on this board is keyboard-only.
   */
  it("says nothing about J and K above the rows, and still moves on them", () => {
    expect(html).not.toMatch(/J and K/);
    expect(boardCopy).not.toHaveProperty("keyboardHint");
    const source = readFileSync(path.join(__dirname, "TodayBoard.tsx"), "utf8");
    expect(source).toMatch(/case "j"|=== "j"/i);
    expect(source).toMatch(/case "k"|=== "k"/i);
  });

  /**
   * Every row's arrival window, which the afternoon used to go without: the board printed
   * "Window pending" on all 28 of its PM rows because the committed routes had no afternoon in
   * them. They do now (src/fixtures/run-routes.ts), so the only row that says nothing about an
   * arrival is one with no van in it at all.
   */
  it("says when each ride arrives, and never that the window is still being worked out", () => {
    expect(html).not.toContain(boardCopy.windowPending);
    const windows = html.match(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/g) ?? [];
    const riding = board.legs.filter((l) => l.ride.mode !== "FAMILY");
    expect(windows.length).toBeGreaterThanOrEqual(riding.length);
    // The afternoon of the child the scenario holds, from the geometry of their own run.
    expect(html).toContain("4:20–4:30 PM");
  });

  it("never prints 'Handed off' for a vehicle that merely arrived (AT-10)", () => {
    expect(html).not.toMatch(/handed off/i);
  });

  /**
   * The finished day is the one board where both answers appear, and that is what makes the rule
   * legible rather than merely true: ten rides were received by a person and say so, and the one
   * van standing at a kerb with no custody event says "Arrived (vehicle)" and asks for the
   * handoff. If an arrival were ever read as a handoff, this row is the one that would change.
   */
  it("tells an arrival and a handoff apart on the day that has both (AT-10)", () => {
    // Zoe B.'s two rides on that day: a morning a person received, and an afternoon whose van
    // is at the kerb with no custody event recorded.
    const ended = boardHtml("Zoe", finished);
    expect(ended).toContain(`State: ${legStates.ARRIVED_DROPOFF.label}`);
    expect(ended).toContain(
      escaped(fill(boardCopy.nextSteps.CONFIRM_HANDOFF, { child: "Zoe B." })),
    );

    // The §3 handoff label carries a placeholder, and it is filled: the morning ended at the
    // centre, so it says the ramp, and the afternoon names the adult on file (COPY-GUIDE §1).
    const handedOffTo = (who: string) =>
      `State: ${fill(legStates.COMPLETED_HANDOFF.label, { "receiver role": who })}`;
    expect(ended).toContain(handedOffTo(boardCopy.receivedByRamp));
    expect(boardHtml("Theo", finished)).toContain(handedOffTo("Lena V."));
    for (const html of [ended, boardHtml("Theo", finished)]) {
      expect(html).not.toMatch(/receiver role/);
    }
  });

  /**
   * AT-13 on the board: the ride that ended holding a child, and what it says about it.
   *
   * On the demo day first, because that is the board a demo walk opens (`DEMO_DAY_RIDES`): the
   * hold and the no-auto-return rule used to live only on a day reachable by a crafted URL, and
   * a story the walk cannot reach is a story the demo does not tell (Vera, 2026-10-16).
   */
  it("shows the ride that ended with nobody to receive the child (AT-13)", () => {
    const live = boardHtml("Noah");
    expect(live).toContain(`State: ${legStates.HELD_NO_RECEIVER.label}`);
    expect(live).toContain(boardCopy.groups.NEEDS_ACTION);
    expect(live).toContain(escaped(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: "Noah O." })));
    // It is the only ride on the live board with an outcome: nothing else on it is finished.
    expect(live).not.toMatch(/handed off/i);

    // And on the finished day, where the morning of the same child is finished too: one held
    // ride is not a held day.
    const ended = boardHtml("Noah", finished);
    expect(ended).toContain(`State: ${legStates.HELD_NO_RECEIVER.label}`);
    expect(ended).toContain(
      `State: ${fill(legStates.COMPLETED_HANDOFF.label, { "receiver role": boardCopy.receivedByRamp })}`,
    );
  });

  it("filters to one child's two rides when the shell's search box carried a name in", () => {
    const filtered = boardHtml("Zoe");
    const opener = (ride: string) => fill(boardCopy.openRow, { child: "Zoe B.", ride });
    expect(filtered).toContain(opener(boardCopy.amSpoken));
    expect(filtered).toContain(opener(boardCopy.pmSpoken));
    expect(filtered).not.toContain("Mia R.");
    expect(filtered).toContain(fill(boardCopy.showing, { shown: 2, total: board.legs.length }));
    expect(filtered).toContain(boardCopy.clearSearch);
  });

  /**
   * Three ways to be empty, three lines, each one saying what to do next — because "No rides
   * scheduled for today" said to a search that matched nobody is a board telling a coordinator
   * the day is empty when it is not.
   */
  it("says which kind of empty it is, in one line, with the way out", () => {
    const none = boardHtml("no child is called this");
    expect(none).toContain(escaped(fill(boardCopy.emptySearch, { query: "no child is called this" })));
    expect(none).not.toContain("<table");
    expect(none).not.toContain(fill(boardCopy.empty, { date: demoDateLabel(DEMO_SERVICE_DATE) }));
  });

  it("and each of those lines is one line that ends in something to do", () => {
    for (const line of [boardCopy.empty, boardCopy.emptySearch, boardCopy.emptyNeedsAction]) {
      expect(line.split("\n")).toHaveLength(1);
      // Two sentences at most: what is true, then what to do about it.
      expect(line.split(". ").length, line).toBe(2);
      expect(line.endsWith("."), line).toBe(true);
    }
  });
});

describe("the drawer reads one child's day", () => {
  const html = drawerHtml("C6");

  it("is a dialog named for the child it is about", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain(fill(drawer.label, { child: "Zoe B." }));
  });

  it("has the §4.2 sections, in the order the design fixes", () => {
    const order = [
      drawer.ridesHeading,
      drawer.needsHeading,
      drawer.capabilityHeading,
      drawer.receiverHeading,
      drawer.approvalsHeading,
      drawer.agentHeading,
      drawer.historyHeading,
    ];
    // As headings, not as text: "Vehicle check" is also the start of a state chip's label.
    const at = order.map((heading) => html.indexOf(`>${escaped(heading)}</h3>`));
    for (const [i, position] of at.entries()) expect(position, order[i]).toBeGreaterThan(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  /**
   * "Today's rides" is true of the demo day and of no other, and the panel is read without
   * looking back at the header behind it, so the heading carries the day itself (Veri #49).
   */
  it("heads the rides with the day they are on, and says 'Today' only when it is", () => {
    expect(html).toContain(`>${escaped(drawer.ridesHeading)}</h3>`);

    for (const of_ of [finished, planned]) {
      const other = drawerHtml("C6", of_);
      expect(other, of_.day.iso).toContain(
        `>${escaped(fill(drawer.ridesHeadingOtherDay, { date: of_.day.label }))}</h3>`,
      );
      expect(other, of_.day.iso).not.toContain(escaped(drawer.ridesHeading));
      expect(other, of_.day.iso).not.toMatch(/Today&#x27;s/);
    }
  });

  it("holds both rides, each with its own state and its own next step", () => {
    for (const heading of [drawer.amRide, drawer.pmRide]) expect(html).toContain(heading);
    expect(html).toContain(`State: ${legStates[legOf("C6", "AM").ride.state].label}`);
    expect(html).toContain(`State: ${legStates[legOf("C6", "PM").ride.state].label}`);
    expect(html).toContain(escaped(nextStepCellText(legOf("C6", "PM"))));
  });

  /**
   * Vera's cut: the two rides are rows of one day, not two cards. A time column, where the ride
   * runs between, and the state as an icon and a label — morning first, because the order is
   * the information.
   */
  it("reads the day as two timeline rows: time, stops, state, in order", () => {
    expect(html).toContain("<ol");
    // No boxes: the card class is gone from the markup, not merely restyled.
    expect(html).not.toContain("rideCard");
    expect(html).toMatch(/<time[^>]*>6:45 AM<\/time>/);
    expect(html).toMatch(/<time[^>]*>4:15 PM<\/time>/);

    const stop = "Palm Beach State College, Lake Worth";
    const morning = fill(drawer.rideFromTo, { from: stop, to: places.center });
    const afternoon = fill(drawer.rideFromTo, { from: places.center, to: stop });
    expect(html).toContain(morning);
    expect(html).toContain(afternoon);

    // Morning before afternoon, and each ride's stops under its own heading.
    expect(html.indexOf(drawer.amRide)).toBeLessThan(html.indexOf(drawer.pmRide));
    expect(html.indexOf(morning)).toBeLessThan(html.indexOf(afternoon));
  });

  it("captions the needs so nobody reads one as a diagnosis (COPY-GUIDE §1)", () => {
    expect(html).toContain(drawer.needsCaption);
    expect(drawer.needsCaption).toBe("Derived from intake, not a diagnosis.");
  });

  it("names each need in words, never by the code the fixture stores it under", () => {
    for (const need of legsOf("C6")[0].child.needs) {
      expect(html).toContain(needCategories[need.category]);
    }
    expect(html).not.toMatch(/WHEELCHAIR_SECUREMENT|MEDICAL_DEVICE_POWER/);
  });

  it("greys the one reported-but-unapproved need and says it drives nothing (VEH-01)", () => {
    const unapproved = legsOf("C6")[0].child.needs.filter((n) => !n.usedForAllocation);
    expect(unapproved).toHaveLength(1);
    expect(html).toContain('data-approved="false"');
    expect(html).toContain(drawer.needNotApproved);
    expect(html).toContain(drawer.needNotUsed);
  });

  it("writes a planned time the way a screen does, not the way the fixture stores it", () => {
    // COPY-GUIDE §3: "8:12 AM". The plan is written "06:50"; no screen in this app says that.
    expect(clockLabel("06:50")).toBe("6:50 AM");
    expect(clockLabel("16:20")).toBe("4:20 PM");
    expect(clockLabel("00:05")).toBe("12:05 AM");
    // A fixture that is not a wall-clock time is visible in review, not rendered as midnight.
    expect(clockLabel("later")).toBe("later");
    expect(clockLabel("26:00")).toBe("26:00");

    expect(html).toContain("6:45 AM");
    // The words on the screen, not the markup under them: `<time dateTime="06:45">` is the
    // machine-readable half of the same fact, and it is the attribute's whole job.
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\b06:45\b/);
    expect(html).toMatch(/<time dateTime="06:45"/);
  });

  it("says which kind of vehicle check this is, and does not round it up", () => {
    expect(html).toContain(drawer.capabilityVerified);
    expect(html).toContain(drawer.fits);
  });

  /**
   * COPY-GUIDE §1 "name the person". Every sentence in this panel about a person says which
   * person: the child it is about, and the adult the family has on file to receive them.
   */
  it("names the receiving adult, their relationship and the child", () => {
    expect(html).toContain(
      escaped(
        fill(drawer.receiverOnFile, {
          adult: "Greta B.",
          relationship: "parent",
          child: "Zoe B.",
        }),
      ),
    );
    // The sentence that stood in for a name is gone.
    expect(html).not.toContain("An adult on file may receive this child");
    expect(html).not.toMatch(/this child/);
  });

  it("names the child in every empty section, and says what each one means", () => {
    for (const line of [drawer.noApprovals, drawer.noAgentChanges, drawer.historyEmpty]) {
      expect(line).toContain("{child}");
      expect(html).toContain(escaped(fill(line, { child: "Zoe B." })));
    }
  });

  it("carries no fixture code: not the child's, not the family's, not the layout's", () => {
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\bC6\b/);
    expect(text).not.toMatch(/\bF5\b/);
    expect(text).not.toMatch(/\bR1\b/);
    expect(text).not.toMatch(/\d+WC\/\d+A/);
  });
});

/**
 * §4.2: one primary action, and a disabled one explains itself in text beside the button. The
 * handoff is the AT-10 rule made into a control — it is a person's act, so it is never
 * available because a vehicle arrived somewhere. Each of its reasons opens with a verb and
 * names the child, because a disabled button is only useful if it says what would unblock it.
 */
describe("the one primary action, and why it is not available", () => {
  it("names the child it would commit a handoff for", () => {
    const html = drawerHtml("C6");
    expect(html).toContain(fill(drawer.confirmHandoff, { child: "Zoe B." }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Confirm handoff for Zoe B\./);
    expect(html).toContain(escaped(fill(drawer.handoffBlockedNotArrived, { child: "Zoe B." })));
    expect(html).toContain(escaped(fill(drawer.overrideWithReason, { child: "Zoe B." })));
  });

  it("names the ramp check when that is what is missing (§5 SURF-02)", () => {
    expect(drawerHtml("C1")).toContain(
      escaped(fill(drawer.handoffBlockedRamp, { child: "Mia R." })),
    );
  });

  it("asks for the receiving adult first when there is none on file (AT-13)", () => {
    const html = drawerHtml("C2");
    expect(html).toContain(escaped(fill(drawer.handoffBlockedNoReceiver, { child: "Noah O." })));
    expect(html).toContain(escaped(fill(drawer.receiverMissing, { child: "Noah O." })));
    // The afternoon ride says why it needs a person, and the step that answers it. On the demo
    // day that ride has ended holding him, so the reason is the hold itself (below).
    expect(html).toContain(escaped(fill(boardCopy.reasons.CHILD_HELD, { child: "Noah O." })));
    expect(html).toContain(escaped(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: "Noah O." })));
    // PRD §6.6: a child is held with the van; nothing drives them back on their own.
    expect(html).toContain(escaped(fill(drawer.heldNoReturn, { child: "Noah O." })));
  });

  it("says out loud that this slice does not write (§1 honesty)", () => {
    expect(drawerHtml("C2")).toContain(drawer.readOnly);
  });

  /**
   * Two disabled controls, two reasons, each under the button it is about (Vera, 2026-10-16).
   * The handoff's reason was the only sentence beside the override as well, so it read as the
   * child's missing receiver being what stops an override — which is not what stops it. What
   * stops it is this build, and the override now says so under itself.
   */
  it("gives the override its own reason, under the override's own button", () => {
    const html = drawerHtml("C2");
    const button = html.indexOf(escaped(fill(drawer.overrideWithReason, { child: "Noah O." })));
    const own = html.indexOf(escaped(drawer.overrideDisabled));
    expect(button).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(button);
    // The handoff's reason is still there, and still above its own button.
    const handoff = html.indexOf(escaped(fill(drawer.handoffBlockedNoReceiver, { child: "Noah O." })));
    expect(handoff).toBeGreaterThan(-1);
    expect(handoff).toBeLessThan(button);
  });

  /**
   * And it has to *look* unavailable. The reason is in text either way (above), but a button
   * drawn as a live secondary invites a click that does nothing — so both disabled controls take
   * the inert tokens from src/ui/tokens.ts, which tokens.test.ts holds to being weaker than
   * every tone a usable control wears.
   */
  it("draws both unavailable buttons as unavailable, in tokens and not by hand", () => {
    const html = drawerHtml("C2");
    const buttons = html.match(/<button[^>]*disabled[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(html).toContain(escaped(fill(drawer.overrideWithReason, { child: "Noah O." })));
    // The classes are the ones the stylesheet dresses; no inline style decides this.
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*style=/);
  });

  /**
   * AT-13 in the drawer: the ride that ended held, and the rule about no automatic return. Read
   * on the demo day, the board a walk opens, and on the finished day, where the same ride is one
   * of a whole day of outcomes.
   */
  describe("a ride that ended with nobody to receive the child (AT-13)", () => {
    const held = drawerHtml("C2");

    it("says the ride is held, on the afternoon row, and never that it was handed off", () => {
      expect(held).toContain(`State: ${legStates.HELD_NO_RECEIVER.label}`);
      expect(held).toContain(escaped(fill(boardCopy.reasons.CHILD_HELD, { child: "Noah O." })));
      expect(held).toContain(escaped(fill(boardCopy.nextSteps.CALL_CONTACTS, { child: "Noah O." })));
      // A hold is not a handoff, and the panel says nothing that could be read as one.
      expect(held).not.toMatch(/handed off/i);
    });

    it("reads the same on the finished day, whose morning was received at the ramp", () => {
      const ended = drawerHtml("C2", finished);
      expect(ended).toContain(`State: ${legStates.HELD_NO_RECEIVER.label}`);
      expect(ended).toContain(escaped(fill(boardCopy.reasons.CHILD_HELD, { child: "Noah O." })));
      expect(ended).toContain(
        `State: ${fill(legStates.COMPLETED_HANDOFF.label, { "receiver role": boardCopy.receivedByRamp })}`,
      );
    });

    it("says the child waits with the van and nothing brings them back (PRD §6.6 CA-04)", () => {
      expect(held).toContain(escaped(fill(drawer.heldNoReturn, { child: "Noah O." })));
      expect(held).toContain(escaped(fill(drawer.receiverMissing, { child: "Noah O." })));
      // No automatic return, and no handoff either: the only exit is a person's.
      expect(held).toContain(escaped(fill(drawer.handoffBlockedNoReceiver, { child: "Noah O." })));
    });
  });
});
