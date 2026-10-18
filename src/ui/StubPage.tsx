import type { ReactNode } from "react";
import styles from "./StubPage.module.css";

/**
 * A SCREEN WHOSE DATA IS NOT BUILT: its title, and nothing else.
 *
 * The title is not here any more — it is in the frame's page header bar, where every screen's
 * title is (src/ui/PageHeader.tsx, audit §2 item 1) — and neither is the one line that used to
 * sit under it. Firia, 2026-10-17 8:36 PM ET: "delete the explanatory helper sentence under
 * every page heading; each page keeps only its title". The audit's §3 reads the same way, screen
 * by screen: one title, no helper paragraph, and the §9.3 empty state is what a finished screen
 * says in place of a sentence about itself.
 *
 * So this is the page column and whatever single in-frame link the screen needs — Family texts
 * carries "For you" to the approvals queue, which §9.2 keeps off the menu. It renders no data
 * and reads none: a page that invents a row to look finished is worse than an empty one, and
 * the screens themselves are a rebuild of their own (audit §4, items 3 and 6).
 */
export function StubPage({ children }: { children?: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}
