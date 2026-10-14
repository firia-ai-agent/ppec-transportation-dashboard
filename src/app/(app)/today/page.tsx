import { board, fill } from "@/ui/copy";
import { serviceDateLabel } from "@/ui/service-date";
import styles from "../page.module.css";

/**
 * SURF-01 board (§4.1). There is no data layer yet, so the page shows its header and the
 * documented empty state rather than invented rides.
 */
export default function TodayPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{board.heading}</h1>
      <p className={styles.empty}>{fill(board.empty, { date: serviceDateLabel() })}</p>
    </div>
  );
}
