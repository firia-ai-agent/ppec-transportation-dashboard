import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { buildBoard, type BoardRow } from "@/domain/board/board";
import { board as boardCopy, drawer, fill, needCategories } from "@/ui/copy";
import { legStates } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import { TodayBoard } from "./TodayBoard";
import { LegDrawer } from "./LegDrawer";

/**
 * The board and the drawer as markup (SURF-01 / SURF-02).
 *
 * These are the assertions a browser cannot make cheaply and a unit test can: which words are
 * on the screen, which state is announced, whether the one primary action is disabled and
 * whether the reason for that is *in text* beside it rather than in a tooltip (§4.2, §9).
 * e2e/today-board.spec.ts then walks the same screen in a real browser for the things that are
 * only true once something is laid out.
 */

/** `renderToStaticMarkup` escapes an apostrophe, and half this copy has one in it. */
function escaped(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

const board = buildBoard();
const rowOf = (key: string): BoardRow => {
  const row = board.rows.find((r) => r.childKey === key);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
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

function drawerHtml(row: BoardRow): string {
  return renderToStaticMarkup(createElement(LegDrawer, { row, onClose: () => {} }));
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
        count: g.rows.length,
      }),
    );
    for (const heading of headings) expect(html).toContain(heading);
    const positions = headings.map((h) => html.indexOf(h));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("names every child exactly once, as an opener a keyboard can reach", () => {
    for (const row of board.rows) {
      expect(html, row.childKey).toContain(fill(boardCopy.openRow, { child: row.childLabel }));
    }
  });

  it("every state on screen is an icon plus a label, announced as a state (§3, §9)", () => {
    // The chip writes "State: <label>" for a screen reader; the eye gets the icon and the label.
    expect(html).toContain(`State: ${legStates.EN_ROUTE_PICKUP.label}`);
    expect(html).toContain(`State: ${legStates.CAPABILITY_PENDING.label}`);
    expect(html.match(/class="lucide/g)?.length ?? 0).toBeGreaterThan(board.rows.length);
  });

  it("every row carries a source chip (NFR-09)", () => {
    const badges = html.match(/Source: Simulated/g) ?? [];
    expect(badges.length).toBe(board.rows.length);
  });

  it("says plainly how the keyboard moves through it (§4.1)", () => {
    expect(html).toContain(boardCopy.keyboardHint);
  });

  it("never prints 'Handed off' for a vehicle that merely arrived (AT-10)", () => {
    expect(html).not.toMatch(/handed off/i);
  });

  it("filters to one child when the shell's search box carried a name in", () => {
    const filtered = boardHtml("Zoe");
    expect(filtered).toContain(fill(boardCopy.openRow, { child: "Zoe B." }));
    expect(filtered).not.toContain(fill(boardCopy.openRow, { child: "Mia R." }));
    expect(filtered).toContain(fill(boardCopy.showing, { shown: 1, total: board.rows.length }));
    expect(filtered).toContain(boardCopy.clearSearch);
  });

  it("says the day is empty rather than showing an empty table", () => {
    const none = boardHtml("no child is called this");
    expect(none).toContain(fill(boardCopy.empty, { date: "Wed, Oct 14" }));
    expect(none).not.toContain("<table");
  });
});

describe("the drawer reads one child's day", () => {
  const html = drawerHtml(rowOf("C6"));

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

  it("captions the needs so nobody reads one as a diagnosis (COPY-GUIDE §1)", () => {
    expect(html).toContain(drawer.needsCaption);
    expect(drawer.needsCaption).toBe("Derived from intake, not a diagnosis.");
  });

  it("names each need in words, never by the code the fixture stores it under", () => {
    const row = rowOf("C6");
    for (const need of row.needs) expect(html).toContain(needCategories[need.category]);
    expect(html).not.toMatch(/WHEELCHAIR_SECUREMENT|MEDICAL_DEVICE_POWER/);
  });

  it("greys the one reported-but-unapproved need and says it drives nothing (VEH-01)", () => {
    const row = rowOf("C6");
    const unapproved = row.needs.filter((n) => !n.usedForAllocation);
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
});

/**
 * §4.2: one primary action, and a disabled one explains itself in text beside the button. The
 * handoff is the AT-10 rule made into a control — it is a person's act, so it is never
 * available because a vehicle arrived somewhere.
 */
describe("the one primary action, and why it is not available", () => {
  it("is disabled while the van is still on its way, with the reason in text", () => {
    const html = drawerHtml(rowOf("C6"));
    expect(html).toContain(drawer.confirmHandoff);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Confirm handoff/);
    expect(html).toContain(escaped(drawer.handoffBlockedNotArrived));
    expect(html).toContain(drawer.overrideWithReason);
  });

  it("names the ramp check when that is what is missing (§5 SURF-02)", () => {
    const html = drawerHtml(rowOf("C1"));
    expect(html).toContain(escaped(drawer.handoffBlockedRamp));
  });

  it("asks for the receiving adult first when there is none on file (AT-13)", () => {
    const html = drawerHtml(rowOf("C2"));
    expect(html).toContain(drawer.handoffBlockedNoReceiver);
    expect(html).toContain(drawer.receiverMissing);
    // PRD §6.6: a child is held with the van; nothing drives them back on their own.
    expect(html).toContain(drawer.heldNoReturn);
  });

  it("says out loud that this slice does not write (§1 honesty)", () => {
    expect(drawerHtml(rowOf("C2"))).toContain(drawer.readOnly);
  });
});
