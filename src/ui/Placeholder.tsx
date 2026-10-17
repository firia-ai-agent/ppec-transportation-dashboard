import { fill, unbuilt } from "./copy";
import styles from "./Placeholder.module.css";

/**
 * A surface that exists in the nav but whose data and interactions are not built yet. The
 * heading says so in the page's own words — "Health & ROI isn't built yet" — and one plain
 * sentence says what the page will do. No build-step codes: they mean nothing to a
 * coordinator, and this frame must never show invented data.
 *
 * It says it **once**. There used to be a "Not built yet" chip next to the heading, which was
 * the same sentence a second time, in smaller type, on the only line of the screen that already
 * carried it — and a chip beside a title reads as a *state* of something real (§3's vocabulary
 * is chips), so it made an empty page look like a page with a status.
 */
export function Placeholder({ page, body }: { page: string; body: string }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{fill(unbuilt.heading, { page })}</h1>
      <p className={styles.body}>{body}</p>
    </div>
  );
}
