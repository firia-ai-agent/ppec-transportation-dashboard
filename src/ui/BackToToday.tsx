import Link from "next/link";
import { canOpenPage, pageLabel, type Caller } from "@/auth/access";
import { fill, nav } from "./copy";
import styles from "./BackToToday.module.css";

/**
 * THE WAY BACK, on the three screens that have no rail of their own.
 *
 * Plan routes, the live map and the ramp iPad are full-screen routes outside the console layout
 * (src/app/(app)), so none of them renders the nav rail. A founder walking the three in one
 * sitting had the browser's Back button and nothing else — and on the ramp iPad, which is a
 * tablet surface, not even that is obvious. This is the link that answers it (Firia,
 * 2026-10-17), and it is one component rather than three copies of a paragraph of JSX, so the
 * three screens cannot drift in where they go, what they say, or who is offered it.
 *
 * It respects the access table. The board is the two console roles' page (`/today`,
 * src/auth/access.ts), so the front desk — whose own surface is the ramp iPad — is offered no
 * link at all rather than a link to a 403. The filter *is* `canOpenPage`, the same function the
 * nav rail filters with and the same one the guard answers from, so there is no second opinion
 * here about who may open the board.
 *
 * And it is a courtesy, not a guard: /today checks the table again on the server for every
 * request (src/auth/page-guard.ts), because a hidden link is not a closed door.
 *
 * The words are `nav.backTo` filled with the destination's own label out of the access table,
 * so the link cannot call the board something the board does not call itself.
 */
const TODAY = "/today";

export function BackToToday({ caller }: { caller: Caller }) {
  if (!canOpenPage(caller, TODAY)) return null;
  return (
    <p className={styles.row}>
      <Link className={styles.link} href={TODAY}>
        {fill(nav.backTo, { page: pageLabel(TODAY) })}
      </Link>
    </p>
  );
}

export default BackToToday;
