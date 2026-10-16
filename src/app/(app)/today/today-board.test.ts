import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { buildBoard, type LegRow } from "@/domain/board/board";
import { board as boardCopy, drawer, fill, needCategories } from "@/ui/copy";
import { legStates, therapySessionStates } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
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
const legsOf = (key: string): LegRow[] => {
  const legs = board.legs.filter((l) => l.child.childKey === key);
  if (legs.length === 0) throw new Error(`no rows for ${key}`);
  return legs;
};
const legOf = (key: string, direction: "AM" | "PM"): LegRow => {
  const leg = legsOf(key).find((l) => l.ride.direction === direction);
  if (!leg) throw new Error(`no ${direction} row for ${key}`);
  return leg;
};

function boardHtml(query = ""): string {
  return renderToStaticMarkup(
    createElement(TodayBoard, {
      board,
      query,
      serviceDateLabel: "Wed, Oct 14",
      serviceDateIso: "2026-10-14",
    }),
  );
}

function drawerHtml(key: string): string {
  return renderToStaticMarkup(createElement(LegDrawer, { legs: legsOf(key), onClose: () => {} }));
}

describe("the board renders the day", () => {
  const html = boardHtml();

  it("has one heading and the service date it is showing", () => {
    expect(html).toContain(`>${boardCopy.heading}<`);
    expect(html).toMatch(/datetime="2026-10-14"/i);
    expect(html).toContain("Wed, Oct 14");
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
    expect(html).toContain(`State: ${boardCopy.windowPending}`);
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
    expect(html).toContain(escaped(fill(boardCopy.nextSteps.RECORD_RECEIVER, { child: "Noah O." })));
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

  it("says plainly how the keyboard moves through it (§4.1)", () => {
    expect(html).toContain(boardCopy.keyboardHint);
  });

  it("never prints 'Handed off' for a vehicle that merely arrived (AT-10)", () => {
    expect(html).not.toMatch(/handed off/i);
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
    expect(none).not.toContain(fill(boardCopy.empty, { date: "Wed, Oct 14" }));
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

  it("holds both rides, each with its own state and its own next step", () => {
    for (const heading of [drawer.amRide, drawer.pmRide]) expect(html).toContain(heading);
    expect(html).toContain(`State: ${legStates[legOf("C6", "AM").ride.state].label}`);
    expect(html).toContain(`State: ${legStates[legOf("C6", "PM").ride.state].label}`);
    expect(html).toContain(escaped(nextStepCellText(legOf("C6", "PM"))));
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
    expect(html).not.toMatch(/\b06:45\b/);
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
    // The afternoon ride says why it needs a person, and the step that answers it.
    expect(html).toContain(escaped(fill(boardCopy.reasons.NO_RECEIVING_ADULT, { child: "Noah O." })));
    expect(html).toContain(escaped(fill(boardCopy.nextSteps.RECORD_RECEIVER, { child: "Noah O." })));
    // PRD §6.6: a child is held with the van; nothing drives them back on their own.
    expect(html).toContain(escaped(fill(drawer.heldNoReturn, { child: "Noah O." })));
  });

  it("says out loud that this slice does not write (§1 honesty)", () => {
    expect(drawerHtml("C2")).toContain(drawer.readOnly);
  });
});
