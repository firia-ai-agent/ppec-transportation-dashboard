import { PAGES } from "@/auth/access";

/**
 * WHAT THE PAGE HEADER BAR SAYS — one screen, one title, read from the access table.
 *
 * Vera's audit §2 item 1: there is no full-width app header any more, and "each page's title
 * (h1) moves into a 64px-high page header bar inside the content column, at 20px semibold in
 * Teal Ink". So the bar needs the title of the screen the browser is on, and the one place this
 * app already writes a destination's words down is its row in the access table (`label`, which
 * is the screen's own heading from src/ui/copy.ts — never a second string).
 *
 * Reading it from there is what keeps the bar and the screen from drifting: a page cannot be
 * called one thing in the menu, another in the bar and a third in its own body, because all
 * three are that one `label`.
 *
 * Longest prefix wins, so `/today/<child>` is still "Today" — the same rule the rail highlights
 * a section with (`isCurrent`, src/ui/nav-items.ts). A path with no row and no parent row has no
 * title, and the bar draws nothing rather than guessing: the 404 and the sign-in screen are
 * outside this frame and carry their own heading.
 */
export function pageTitleFor(pathname: string): string {
  const matches = PAGES.filter(
    (row) =>
      row.kind === "page" &&
      row.label !== undefined &&
      (pathname === row.path || pathname.startsWith(`${row.path}/`)),
  );
  const best = matches.sort((a, b) => b.path.length - a.path.length)[0];
  return best?.label ?? "";
}
