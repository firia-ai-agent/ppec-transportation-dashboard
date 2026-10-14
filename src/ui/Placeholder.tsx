import { placeholders } from "./copy";
import styles from "./Placeholder.module.css";

/**
 * A surface that exists in the nav but whose data and interactions land in a later build
 * step. It names the step rather than showing an empty frame, and it never shows invented data.
 */
export function Placeholder({ copy }: { copy: { heading: string; body: string } }) {
  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <h1 className={styles.heading}>{copy.heading}</h1>
        <span className={styles.tag}>{placeholders.comingSoonLabel}</span>
      </div>
      <p className={styles.body}>{copy.body}</p>
    </div>
  );
}
