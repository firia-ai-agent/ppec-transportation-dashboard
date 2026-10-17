import type { Direction } from "@/domain/day/leg";

/**
 * The ramp checks the afternoon.
 *
 * PRD §9 l.863–865 puts the two halves of a day in two different pairs of hands: a morning ride
 * is confirmed at the kerb by the provider's driver, and an afternoon ride is checked at the
 * centre's own ramp before the van is released. So the run a ramp check is about is always the
 * afternoon one — the same constant PR #60's arrival module names, kept here so this screen does
 * not import that module's whole flow to read one value.
 */
export const RAMP_DIRECTION: Direction = "PM";
