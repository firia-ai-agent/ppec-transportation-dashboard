import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planBoard } from "@/ui/copy";
import { slotSnapshot, subscribeToSlot } from "@/ui/HeaderSlot";
import { boardHref, resolveLeg } from "@/modules/plan/when";
import { BoardToolbar } from "./BoardToolbar";

/**
 * S1 (Firia 7:55 AM ET): Morning | Afternoon is always on the board, Morning by default, at 390,
 * 1280 and 1440 (png/plan-board.png, png/plan-board-390.png).
 */
const APP = path.resolve(__dirname, "..", "..", "..");
const css = readFileSync(path.join(APP, "app", "plan-routes", "board", "board.module.css"), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

const toolbar = (leg: "AM" | "PM") =>
  renderToStaticMarkup(
    createElement(BoardToolbar, {
      dateLabel: "Sun, Oct 18",
      direction: leg,
      hrefFor: (next) => boardHref("/plan-routes", { date: "2026-10-18", leg: next }),
      placed: 0,
      total: 9,
      save: { kind: "DIRTY" },
      canUndo: false,
      onUndo: () => {},
      onAutoPlan: () => {},
      autoPlanPrimary: true,
      onSave: () => {},
      canSave: false,
    }),
  );

describe("the default board: both legs, Morning current", () => {
  it("a /plan-routes with no leg= opens Morning", () => {
    expect(resolveLeg(undefined)).toBe("AM");
    expect(resolveLeg("")).toBe("AM");
    expect(resolveLeg("pm")).toBe("PM");
  });

  it("renders both segments as links, with Morning marked current", () => {
    const html = toolbar(resolveLeg(undefined));
    const am = html.match(/<a[^>]*data-leg="AM"[^>]*>/)?.[0] ?? "";
    const pm = html.match(/<a[^>]*data-leg="PM"[^>]*>/)?.[0] ?? "";
    expect(am).toContain('aria-current="page"');
    expect(pm).not.toContain("aria-current");
    expect(pm).toContain('href="/plan-routes?date=2026-10-18&amp;leg=pm"');
    expect(html).toContain(planBoard.morning);
    expect(html).toContain(planBoard.afternoon);
  });
});

describe("the leg switch cannot be squeezed or scrolled out of sight", () => {
  it("the header row wraps instead of scrolling sideways with a hidden scrollbar", () => {
    const row = rule(".toolbar");
    expect(row).toContain("flex-wrap: wrap");
    expect(row).not.toMatch(/overflow-x:\s*auto/);
    expect(row).not.toContain("scrollbar-width: none");
  });

  it("nothing on the row shrinks (`.segmented` has overflow: hidden, so it would shrink to 0)", () => {
    expect(rule(".toolbar > *")).toContain("flex: none");
  });
});

describe("HeaderSlot finds a header bar mounted after it rendered (soft navigation)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("re-reads the slot when the document changes, and stops on unsubscribe", () => {
    let slot: object | null = null;
    let fire: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("document", { body: {}, querySelector: () => slot });
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const onChange = vi.fn();
    const unsubscribe = subscribeToSlot(onChange);
    expect(slotSnapshot()).toBeNull(); // the new bar is not in the document yet
    slot = { tag: "div" };
    fire(); // the commit that mounts the bar
    expect(onChange).toHaveBeenCalled();
    expect(slotSnapshot()).toBe(slot);
    unsubscribe();
    expect(disconnect).toHaveBeenCalled();
  });
});
