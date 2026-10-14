import { uiSourceMode } from "@/lib/env";
import { SourceBadge } from "./SourceBadge";
import styles from "./ScreenSource.module.css";

/**
 * The screen-level source-mode badge (NFR-09, §7.1: "on every screen, record and outbound
 * message"), placed next to the DEMO banner.
 *
 * It lives in the *root* layout, not in the app shell, because "every screen" includes the
 * ones outside the shell: /login, the whoami developer page, and any future signed-link page.
 * A visitor must never see a PPEC screen without being told where its data comes from.
 * Rendering it once here is also what keeps a second, contradicting badge from appearing.
 */
export function ScreenSource() {
  return (
    <div className={styles.strip}>
      <SourceBadge mode={uiSourceMode()} />
    </div>
  );
}
