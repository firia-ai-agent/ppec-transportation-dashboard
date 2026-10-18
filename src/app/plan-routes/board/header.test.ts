import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { planBoard } from "@/ui/copy";
import { BoardToolbar } from "./BoardToolbar";

/**
 * ONE `h1` PER SCREEN, AND IT IS THE FRAME'S.
 *
 * #74 gave every screen the same 64 px header bar with the one title on it, read from the access
 * table (src/ui/PageHeader.tsx). The board and the ramp iPad were written before that and drew
 * titles of their own, so after the merge each of those screens had **two** — the same words
 * twice, and two landmarks where §9 allows one. The titles are gone from the screens; what stays
 * on that row is what png/plan-board.png draws beside the title: the date, Morning | Afternoon,
 * the placed count, Undo, Auto-plan and Save, rendered into the frame's slot
 * (src/ui/HeaderSlot.tsx) rather than into a second strip under the bar.
 *
 * Read as source as well as rendered, because the thing being prevented is a heading tag
 * reappearing in one of these four files.
 */
const APP = path.resolve(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(APP, ...parts), "utf8");
/** Comments are not markup: a file may say the word h1, it may not render one. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const TOOLBAR = {
  dateLabel: "Sat, Oct 17",
  direction: "PM" as const,
  hrefFor: (leg: "AM" | "PM") => `/plan-routes?leg=${leg}`,
  placed: 10,
  total: 12,
  save: { kind: "DIRTY" } as const,
  canUndo: false,
  onUndo: () => {},
  onAutoPlan: () => {},
  autoPlanPrimary: false,
  onSave: () => {},
  canSave: true,
};

describe("the board's header row", () => {
  const html = renderToStaticMarkup(createElement(BoardToolbar, TOOLBAR));

  it("renders no heading of its own: the frame draws the only one", () => {
    expect(html).not.toMatch(/<h1\b/);
    expect(html).not.toMatch(/<h2\b/);
    expect(html).not.toContain(planBoard.heading.toUpperCase());
  });

  it("carries what plan-board.png puts on that row, and nothing else", () => {
    expect(html).toContain("Sat, Oct 17");
    expect(html).toContain(planBoard.morning);
    expect(html).toContain(planBoard.afternoon);
    expect(html).toContain("data-placed");
    expect(html).toContain("data-save-state");
    expect(html).toContain("data-undo");
    expect(html).toContain("data-auto-plan");
    expect(html).toContain("data-save");
  });

  it("is rendered into the frame's header slot, not into a strip of its own", () => {
    const board = code(read("plan-routes", "board", "PlanBoard.tsx"));
    expect(board).toMatch(/<HeaderSlot>\s*<BoardToolbar/);
    expect(board).toContain('import { HeaderSlot } from "@/ui/HeaderSlot";');
  });
});

describe("the screens inside the frame draw no title of their own", () => {
  it.each([
    ["plan-routes/page.tsx", ["plan-routes", "page.tsx"]],
    ["plan-routes/board/BoardToolbar.tsx", ["plan-routes", "board", "BoardToolbar.tsx"]],
    ["ramp-ipad/page.tsx", ["ramp-ipad", "page.tsx"]],
    ["ramp-ipad/arrival/VanArrival.tsx", ["ramp-ipad", "arrival", "VanArrival.tsx"]],
  ])("%s renders no h1", (_name, parts) => {
    expect(code(read(...parts))).not.toMatch(/<h1\b/);
  });

  it("…because the frame renders exactly one, from the access table's label", () => {
    const bar = code(readFileSync(path.join(APP, "..", "ui", "PageHeader.tsx"), "utf8"));
    expect(bar.match(/<h1\b/g)).toHaveLength(1);
    expect(bar).toContain("pageTitleFor(pathname)");
  });
});
