import {
  Accessibility,
  ArrowUpFromLine,
  Armchair,
  Baby,
  HeartPulse,
  Wind,
  type LucideIcon,
} from "lucide-react";
import type { CounterKey, NeedFlags } from "@/config/equipment";
import { equipment } from "./copy";
import { icon } from "./tokens";

/**
 * One icon per thing a van carries and a child needs — the §0 vocabulary table, in one place.
 *
 * The redesign's §0 rule is that the equipment icons are the *same* everywhere they appear: a
 * child's chip, a van's meter, a stepper on the ramp iPad, a popup on the map. Two screens
 * choosing two icons for a car seat is two vocabularies for one thing, so both read this.
 *
 * Every icon is paired with a word for a screen reader (§0's copy rule 2: a state is an icon plus
 * a label, never colour or shape alone), and the words come from `equipment` in src/ui/copy.ts.
 */
export const COUNTER_ICON: Readonly<Record<CounterKey, LucideIcon>> = {
  seats: Armchair,
  wheelchairSpots: Accessibility,
  carSeats: Baby,
  oxygenMounts: Wind,
};

/** What a van's counter is called. */
export const COUNTER_LABEL: Readonly<Record<CounterKey, string>> = {
  seats: equipment.seats,
  wheelchairSpots: equipment.wheelchair,
  carSeats: equipment.carSeats,
  oxygenMounts: equipment.oxygen,
};

/** The lift, which is a yes or a no rather than a count. */
export const LIFT_ICON: LucideIcon = ArrowUpFromLine;

export const NEED_ICON: Readonly<Record<keyof NeedFlags, LucideIcon>> = {
  wheelchair: Accessibility,
  carSeat: Baby,
  oxygen: Wind,
  nurse: HeartPulse,
};

export const NEED_LABEL: Readonly<Record<keyof NeedFlags, string>> = {
  wheelchair: equipment.need.wheelchair,
  carSeat: equipment.need.carSeat,
  oxygen: equipment.need.oxygen,
  nurse: equipment.need.nurse,
};

/** The needs a child has, in the §0 order, as icons with their words beside them. */
export const NEED_ORDER: ReadonlyArray<keyof NeedFlags> = ["wheelchair", "carSeat", "oxygen", "nurse"];

/**
 * A child's needs as icons on their card.
 *
 * The icons are decorative and the words are real: one `srOnly` list, so a screen reader hears
 * "Wheelchair, Nurse" rather than two unnamed images, and a greyscale screenshot still reads.
 */
export function NeedIcons({ needs, size = icon.chip }: { needs: NeedFlags; size?: number }) {
  const has = NEED_ORDER.filter((need) => needs[need]);
  if (has.length === 0) return null;
  return (
    <span data-needs="">
      <span className="srOnly">{has.map((need) => NEED_LABEL[need]).join(", ")}</span>
      {has.map((need) => {
        const Icon = NEED_ICON[need];
        return <Icon key={need} size={size} aria-hidden="true" />;
      })}
    </span>
  );
}
