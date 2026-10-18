/**
 * Which half of the day a screen is looking at.
 *
 * The morning run brings children to the centre and the afternoon run takes them home (PRD §8),
 * and every surface in the rebuild — the board, the ramp, the stores, the endpoints — is about
 * one of the two. It is declared here, in a module with no imports at all, so a screen can say
 * which leg it means without importing the capacity solver to borrow its type (Firia's rule 2:
 * nothing under src/app or src/components imports src/domain/solver).
 */
export type Direction = "AM" | "PM";

/**
 * The leg to open on when the address does not name one (§9.1): the morning until noon at the
 * centre, the afternoon after it. `hour` is the centre's own hour, read with
 * {@link SITE_TIME_ZONE} by the caller rather than the browser's clock.
 */
export function defaultLeg(centreHour: number): Direction {
  return centreHour < 12 ? "AM" : "PM";
}
