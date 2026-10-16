import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ServiceDay } from "@/domain/board/day";
import { serviceDate as copy } from "./copy";
import { icon } from "./tokens";
import styles from "./ServiceDateSwitcher.module.css";

/**
 * The service date in the board's header, and the two arrows that change it (§2, PRD §6.1).
 *
 * One date for the screen, which is the point: the shell's header used to carry today's real
 * date while the board carried the seeded day the scenario replays, both labelled "Service date"
 * (docs/ui/B12-SLICE1-DEFERRED.md §5). The board is about one day, this says which, and the
 * arrows are how another one is reached — so "the board shows today only" is a shape rather than
 * a promise, and no row ever belongs to a day the screen has not named.
 *
 * Links, not buttons: a day is a place, so it has a URL that can be sent to somebody, and the
 * board for it is rendered on the server like every other page. There is no state in here and
 * nothing to hydrate. At the ends of the range the arrow is absent rather than inert — there is
 * no day behind it to go to, and a dead control is worse than no control (§9).
 */
export function ServiceDateSwitcher({ day, query }: { day: ServiceDay; query: string }) {
  const href = (dateIso: string) => {
    const params = new URLSearchParams({ date: dateIso });
    if (query.trim().length > 0) params.set("q", query);
    return `/today?${params.toString()}`;
  };
  return (
    <nav className={styles.switcher} aria-label={copy.groupLabel}>
      {day.previousIso === null ? null : (
        <a className={styles.arrow} href={href(day.previousIso)} aria-label={copy.previousDay}>
          <ChevronLeft size={icon.inline} aria-hidden="true" />
        </a>
      )}
      <p className={styles.current}>
        <span className={styles.label}>{copy.groupLabel}</span>{" "}
        <time dateTime={day.iso} className="tabularNums">
          {day.label}
        </time>{" "}
        {/* Which kind of day this is — the answer to "why is every ride on it finished". */}
        <span className={styles.phase} data-phase={day.phase}>
          {copy.phases[day.phase]}
        </span>
      </p>
      {day.nextIso === null ? null : (
        <a className={styles.arrow} href={href(day.nextIso)} aria-label={copy.nextDay}>
          <ChevronRight size={icon.inline} aria-hidden="true" />
        </a>
      )}
    </nav>
  );
}
