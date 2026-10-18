import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StateChip } from "./StateChip";
import { SourceBadge } from "./SourceBadge";
import { vocabularies } from "./states";
import { fontSize, layout, lineHeight, radius, space } from "./tokens";

/**
 * ONE PILL, AND NO SECOND ONE — Vera's audit §4 item 1, which is the founder's own bug: "the
 * pills wrap and overlap at 390".
 *
 * They wrapped because each surface had drawn its own chip — the §3 state chip here, the van's
 * outlined fact chip there, the ramp iPad's two in inline styles — and not one of them said it
 * may not wrap or shrink. So the fix is a single declaration block (src/ui/Pill.module.css) with
 * the audit's own metrics, used by every chip in the app, and this file is what keeps it single:
 *
 *  1. the shared block *is* those metrics, including `white-space: nowrap`;
 *  2. every chip component renders it;
 *  3. no other file under src/ contains a pill of its own — asserted as a property of the
 *     stylesheets and the inline styles, not as a list of the ones we happened to find.
 */
const UI = __dirname;
const SRC = path.resolve(UI, "..");
const PILL_CSS = path.join(UI, "Pill.module.css");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Every source file under src/, so (3) is a property rather than a spot check. */
function walkSrc(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walkSrc(full);
    return /\.(?:ts|tsx|css)$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

/** A CSS rule block, by its selector, with comments stripped so a comment cannot satisfy it. */
function blockOf(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = bare.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return bare.slice(at, bare.indexOf("}", at));
}

describe("the one pill", () => {
  const css = read(PILL_CSS);

  /** The audit's line, declaration by declaration: `display:inline-flex; … 9999px`. */
  it("is the audit's metrics, in tokens", () => {
    const pill = blockOf(css, ".pill");
    expect(pill).toMatch(/display: inline-flex/);
    expect(pill).toMatch(/align-items: center/);
    expect(pill).toMatch(/height: var\(--layout-pill-height\)/);
    expect(pill).toMatch(/padding: 0 var\(--space-3\)/);
    expect(pill).toMatch(/border-radius: var\(--radius-pill\)/);
    expect(pill).toMatch(/font-size: var\(--text-11\)/);
    expect(pill).toMatch(/font-weight: var\(--weight-semibold\)/);
    expect(pill).toMatch(/line-height: var\(--leading-one\)/);
    // And the token values are the numbers the audit names.
    expect(layout.pillHeight).toBe("22px");
    expect(space["3"]).toBe("8px");
    expect(radius.pill).toBe("9999px");
    expect(fontSize["11"]).toBe("11px");
    expect(lineHeight.one).toBe("1");
  });

  /**
   * The two declarations the overlap bug is actually about. `nowrap` stops a three-word label
   * becoming two lines; `flex-shrink: 0` stops a chip in a tight flex row being squeezed under
   * its neighbour instead of pushing the row.
   */
  it("may not wrap and may not shrink", () => {
    const pill = blockOf(css, ".pill");
    expect(pill).toMatch(/white-space: nowrap/);
    expect(pill).toMatch(/flex-shrink: 0/);
  });

  /** Rendered, not read: every §3 state is one `data-pill` span whose text is on one line. */
  it("is what a state chip renders, for every state in every vocabulary", () => {
    for (const [vocabulary, states] of Object.entries(vocabularies)) {
      for (const [state, descriptor] of Object.entries(states)) {
        const html = renderToStaticMarkup(StateChip({ state: descriptor, values: NUMBERS }));
        const where = `${vocabulary}.${state}`;
        expect(html.match(/data-pill="true"/g), where).toHaveLength(1);
        expect(html, where).toContain("_pill_");
      }
    }
  });

  /** And the §7.1 source chip, which is the same pill with a §7.1 token on it (audit §2 item 4). */
  it("is what the source chip renders", () => {
    const html = renderToStaticMarkup(SourceBadge({ mode: "SIMULATED" }));
    expect(html).toContain('data-pill="true"');
    expect(html).toContain('data-variant="source"');
    expect(html).toContain('data-token="src-sim"');
    expect(html).toContain("_pill_");
  });

  /**
   * NO OTHER PILL CSS, as a rule about shapes rather than a list of files: a rule that rounds a
   * box to the pill radius *and* pads it is a chip with words in it, and the only file allowed
   * to hold one is Pill.module.css. A disc — the rail's count badge, an avatar, the step strip's
   * state disc, the plan map's line swatch — is fully rounded and has no padding, which is what
   * tells the two apart without an allowlist anybody can add to.
   */
  /*
   * ONE EXCEPTION, and it is a text field rather than a chip: the agent bubble's compose bar
   * (src/ui/AgentCompose.module.css `.field`), which Vera's mockup draws as a 44 px pill with
   * "Ask the agent…" in it — mockups/agent-bubble.html `.cmp .in2`:
   * `{height:44px;border:1px solid var(--disabled-border);border-radius:999px;padding:0 16px}`.
   *
   * The rule above is about *status chips*: a rounded, padded box with a word in it that claims
   * something about the day, and the reason there may be only one is that two of them drift. An
   * `<input>` the person types into claims nothing and is read as a control, not a state — and
   * the shape test cannot tell the two apart, because the difference is the element and not the
   * CSS. So the file is named here, with its source, rather than the rule being widened to any
   * box that happens to have a border: a second entry on this list has to be argued for in the
   * same way, which is the property the no-allowlist comment above is protecting.
   */
  const PILL_SHAPED_FIELD = path.join(UI, "AgentCompose.module.css");

  it("is the only pill in the repository", () => {
    const offenders: Array<{ file: string; rule: string }> = [];
    for (const file of walkSrc().filter((f) => f.endsWith(".css") && f !== PILL_CSS && f !== PILL_SHAPED_FIELD)) {
      const bare = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const rounded = /border-radius:\s*(?:var\(--radius-pill\)|9{3,}px)/.test(body);
        if (rounded && /\bpadding(?:-inline)?:/.test(body)) {
          offenders.push({ file: path.relative(SRC, file), rule: selector.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /** And the exception is exactly one rule in that one file: the field, and nothing beside it. */
  it("lets the compose field be pill-shaped, and nothing else in its stylesheet", () => {
    const bare = read(PILL_SHAPED_FIELD).replace(/\/\*[\s\S]*?\*\//g, "");
    const padded: string[] = [];
    for (const [, selector, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const rounded = /border-radius:\s*(?:var\(--radius-pill\)|9{3,}px)/.test(body);
      if (rounded && /\bpadding(?:-inline)?:/.test(body)) padded.push(selector.trim());
    }
    expect(padded).toEqual([".field"]);
    // It is a field, not a chip: no status token on it, and it carries no words of its own.
    expect(bare).not.toMatch(/data-pill|data-variant|--color-(?:ok|warn|crit|info)-/);
  });

  /**
   * AND NOTHING MAY UNWRAP IT. The board used to set `white-space: normal` on every chip in a
   * cell, which is the founder's bug in one declaration: a chip that wraps is two lines of pill
   * in a 40 px column, landing on its neighbour at 390 px. A rule *about a chip* may size it or
   * place it; it may not let its words break.
   *
   * A container of several chips is a different thing and may still wrap — a row of a van's
   * facts takes a second row rather than running off the card — so the rule is about the chip
   * and not about the list it is in. What it must never be is two chips stacked in one *cell*,
   * which is the board's `.van`: a row, nowrap (src/app/(app)/today/today.module.css).
   */
  it("lets nothing unwrap a pill", () => {
    const offenders: Array<{ file: string; rule: string }> = [];
    for (const file of walkSrc().filter((f) => f.endsWith(".css"))) {
      const bare = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/chip|pill/i.test(selector) || /chips\b/.test(selector)) continue;
        if (/white-space:\s*normal/.test(body)) {
          offenders.push({ file: path.relative(SRC, file), rule: selector.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
    // And the one cell that carries two of them keeps them side by side, never stacked.
    const board = read(path.join(SRC, "app", "(app)", "today", "today.module.css"));
    expect(blockOf(board, ".van")).toMatch(/flex-wrap: nowrap/);
  });

  /** The same rule for the two screens built in inline styles, where a chip is an object. */
  it("leaves no pill in an inline style either", () => {
    const offenders: string[] = [];
    for (const file of walkSrc().filter((f) => f.endsWith(".tsx"))) {
      const source = read(file);
      for (const [match] of source.matchAll(/\{[^{}]*radius-pill[^{}]*\}/g)) {
        if (/padding/.test(match)) offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * And 11 px is the pill's alone: §2's floor is 12, allowed down to 12 only for a chip with an
   * icon, so a sentence may never read at 11.
   */
  it("keeps the 11 px step inside the pill", () => {
    const readers = walkSrc().filter(
      (f) => f !== PILL_CSS && f !== path.join(UI, "tokens.ts") && /--text-11\b/.test(read(f)),
    );
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([
      // The two count badges, which are a number in a 20 px disc rather than a sentence.
      "ui/NavRail.module.css",
      "ui/TabBar.module.css",
    ]);
  });
});

/** Some §3 labels carry a `{placeholder}`; the chip is rendered with them filled. */
const NUMBERS = { count: 2, time: "4:20 PM", "receiver role": "front desk", minutes: 5, n: 2 };
