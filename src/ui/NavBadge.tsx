import { assistantUnavailable, fill } from "./copy";
import styles from "./NavBadge.module.css";

/**
 * The red count beside "Exceptions & Approvals" in the rail.
 *
 * A **number** and a screen-reader sentence, not a colour and not a dot: §9, and Vera's rule that
 * a badge may never carry its meaning in colour alone. The colour is the emphasis; the digit and
 * the label are the information, and both survive a greyscale screenshot and a screen reader.
 */
export function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className={styles.badge}>
      <span aria-hidden="true">{count}</span>
      <span className="srOnly">{fill(assistantUnavailable.badgeLabel, { count })}</span>
    </span>
  );
}
