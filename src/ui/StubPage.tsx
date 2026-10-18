import type { ReactNode } from "react";
import styles from "./StubPage.module.css";

/**
 * A SCREEN WHOSE DATA IS NOT BUILT: its own title, one line, and nothing else.
 *
 * This is not `Placeholder` (src/ui/Placeholder.tsx) and the difference is the menu. A page
 * that is off the menu and reached by typing a URL can afford to say "Health & ROI isn't built
 * yet" — the only person there typed the address. REDESIGN-SPEC §0 puts these on the menu,
 * because nothing on a menu may 404 and a founder mid-demo clicks rather than types, and a
 * menu item that lands on an apology is the dead end the whole redesign is about. So what they
 * find is a screen: the heading the menu promised, and one line saying what will be on it.
 *
 * It renders no data and reads none — there is nothing here to be wrong about, which is the
 * other half of the rule (a page that invents a row to look finished is worse than an empty
 * one). `children` is for the single in-frame link one of these needs: Family texts carries
 * "For you" to the approvals queue, which §9.2 keeps off the menu.
 */
export function StubPage({
  title,
  line,
  children,
}: {
  title: string;
  /** One short sentence about what the page will hold. §0: never a paragraph. */
  line: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{title}</h1>
      <p className={styles.line}>{line}</p>
      {children}
    </div>
  );
}
