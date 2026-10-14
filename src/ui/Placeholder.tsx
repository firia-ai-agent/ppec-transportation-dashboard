import { fill, unbuilt } from "./copy";
import styles from "./Placeholder.module.css";

/**
 * A surface that exists in the nav but whose data and interactions are not built yet. The
 * heading says so in the page's own words — "Health & ROI isn't built yet" — and one plain
 * sentence says what the page will do. No build-step codes: they mean nothing to a
 * coordinator, and this frame must never show invented data.
 */
export function Placeholder({ page, body }: { page: string; body: string }) {
  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <h1 className={styles.heading}>{fill(unbuilt.heading, { page })}</h1>
        <span className={styles.tag}>{unbuilt.tag}</span>
      </div>
      <p className={styles.body}>{body}</p>
    </div>
  );
}
