/**
 * Maximum bipartite matching for PRD §7 constraint 1: an injective f from the wheelchair riders
 * onboard after stop k to the usable wheelchair positions, with sec(f(c)) = sec(c) and the chair
 * inside the position footprint.
 *
 * Kuhn's augmenting-path algorithm. Both sides are iterated in input order, so the matching (not
 * just its size) is deterministic: the same inputs always produce the same seat assignment.
 * Sizes here are tiny (at most 4 positions, at most 4 chairs), so the O(V*E) bound is irrelevant.
 */

export type MatchResult = {
  /** childIndex -> positionIndex */
  pairs: Map<number, number>;
  size: number;
  /** Indices of children left unmatched, in input order. */
  unmatched: number[];
};

export function maxMatching(
  childCount: number,
  positionCount: number,
  allowed: (childIndex: number, positionIndex: number) => boolean,
): MatchResult {
  /** positionIndex -> childIndex */
  const takenBy = new Map<number, number>();

  const augment = (child: number, seen: Set<number>): boolean => {
    for (let p = 0; p < positionCount; p += 1) {
      if (seen.has(p) || !allowed(child, p)) continue;
      seen.add(p);
      const holder = takenBy.get(p);
      if (holder === undefined || augment(holder, seen)) {
        takenBy.set(p, child);
        return true;
      }
    }
    return false;
  };

  for (let c = 0; c < childCount; c += 1) augment(c, new Set<number>());

  const pairs = new Map<number, number>();
  for (const [position, child] of takenBy) pairs.set(child, position);
  const unmatched: number[] = [];
  for (let c = 0; c < childCount; c += 1) if (!pairs.has(c)) unmatched.push(c);
  return { pairs, size: pairs.size, unmatched };
}
