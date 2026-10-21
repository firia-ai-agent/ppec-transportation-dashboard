/**
 * A LEG'S PLAN, AS THE AGENT READS IT (ledger #77, #87): when each van leaves, its counts, its riders
 * with their ≈ times, who is unassigned (with what placing them needs), who does not fit, and who is
 * outside a time their family agreed. One reading, for `get_plan` and for the staff ask's own prompt,
 * so the two can never describe the board differently.
 */
import { hhmmOf, plannedStopTimes } from "@/domain/plan/arrivals";
import { ridersInVan, shortfallsOfDay, usedInVan } from "@/domain/plan/board";
import { fits } from "@/domain/plan/fit";
import { outsideSlots } from "@/domain/plan/slots";
import type { BoardView } from "@/modules/plan/store";
import { clockLabel } from "@/ui/service-date";

const at = (minute: number | undefined) => (minute === undefined ? "" : clockLabel(hhmmOf(Math.round(minute))));
const yes = (b: boolean) => (b ? "yes" : "no");

/**
 * "Mia R. (carSeat; stop Greenacres Branch Library; window 7:30 AM)": an unassigned rider with what
 * Auto-plan places them by. It is all on file — said here so the model has no reason to look it up.
 */
export function riderFacts(r: {
  readonly name: string;
  readonly needs: Readonly<Record<string, boolean>>;
  readonly stopLabel: string;
  readonly window: string;
}): string {
  const needs = Object.entries(r.needs).filter(([, on]) => on).map(([need]) => need).join(", ") || "no special needs";
  return `${r.name} (${needs}${r.stopLabel ? `; stop ${r.stopLabel}` : ""}${r.window ? `; window ${clockLabel(r.window)}` : ""})`;
}

export function planFacts(view: BoardView): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = { leg: view.day.direction, saved: view.version > 0 };
  const times = plannedStopTimes(view.day, view.plan, view.departs);
  for (const van of view.day.vans) {
    const riders = ridersInVan(view.day, view.plan, van.id);
    const used = usedInVan(view.day, view.plan, van.id);
    facts[van.name] =
      `leaves ${at(view.departs[van.id])}, seats ${used.seats}/${van.setup.seats}, wheelchair ${used.wheelchairSpots}/${van.setup.wheelchairSpots}, ` +
      `car seats ${used.carSeats}/${van.setup.carSeats}, oxygen ${used.oxygenMounts}/${van.setup.oxygenMounts}, lift ${yes(van.setup.hasLift)}, ` +
      `fits ${yes(fits(van.setup, riders))}, riders: ${riders.map((r) => `${r.name} ≈${at(times.get(r.token)?.arrivesAtMinute)}`).join(", ") || "none"}`;
  }
  // Who the plan already has outside a time their family agreed (ledger #84), by name.
  const outside = [...outsideSlots(view.day, view.plan, view.departs)].filter(([, off]) => off > 0);
  if (outside.length > 0) {
    facts.outside_agreed = outside.map(([token, off]) => `${view.day.riders.find((r) => r.token === token)?.name ?? token} ${off} min`).join(", ");
  }
  for (const bucket of ["UNASSIGNED", "FAMILY_DRIVES", "ABSENT"] as const) {
    const here = view.day.riders.concat(view.day.others).filter((r) => view.plan[r.token]?.bucket === bucket);
    if (here.length > 0) facts[bucket.toLowerCase()] = here.map((r) => (bucket === "UNASSIGNED" ? riderFacts(r) : r.name)).join(", ");
  }
  const short = shortfallsOfDay(view.day, view.plan);
  facts.does_not_fit = short.map((s) => `${view.day.riders.find((r) => r.token === s.token)?.name ?? s.token} (${s.shortfall.reason})`).join(", ") || "none";
  return facts;
}
