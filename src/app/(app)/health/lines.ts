/**
 * The words for one number and for one adapter row — the join between src/domain/health, which
 * counts, and the screen, which only places boxes.
 *
 * It is its own module and not part of the component for the same reason
 * `src/app/(app)/today/next-step.ts` is: a sentence picked from a count is the part of a screen
 * most worth a unit test, and a test should not have to render a page to read it.
 *
 * Every string comes from src/ui/copy.ts. What is decided here is *which* of a metric's
 * sentences is true of today's count — the zero, the one or the many — because a count is a
 * grammatical subject and "1 rides need a person" is the kind of line that makes a reader
 * distrust the number beside it.
 */

import { Plug, Unplug } from "lucide-react";
import type { RoiMetric, RoiMetricKey } from "@/domain/health/metrics";
import type { AdapterKey, AdapterStatus } from "@/domain/health/adapters";
import { countable, fill, health, pluralize } from "@/ui/copy";
import type { StateDescriptor } from "@/ui/states";

/** "9 of 9" for a ratio, "6" for a count that stands on its own. */
export function metricValue(metric: RoiMetric): string {
  return fill(health.metrics[metric.key].value, {
    count: metric.count,
    total: metric.outOf ?? metric.count,
  });
}

export function metricLabel(key: RoiMetricKey): string {
  return health.metrics[key].label;
}

/** Why this number is worth a line on the screen at all. Said once, under the sentence. */
export function metricWhy(key: RoiMetricKey): string {
  return health.metrics[key].why;
}

/** "{count} rides" / "1 ride" — a count never reaches this screen without its noun. */
function rides(count: number): string {
  return pluralize(count, countable.ride);
}

/**
 * The one plain sentence under a number.
 *
 * Each metric has a sentence for nothing counted, one for exactly one, and one for several,
 * because the three do not share a verb. The "one" sentence names the child, which is what makes
 * it worth having: "Noah O. has a ride that needs a person right now" is a line a coordinator can
 * act on, and "1 ride needs a person" is one they have to go and look up.
 */
export function metricLine(metric: RoiMetric): string {
  const { count, outOf, children, minutes } = metric;
  switch (metric.key) {
    case "CHILDREN_PLACED": {
      const words = health.metrics.CHILDREN_PLACED;
      const total = outOf ?? count;
      if (total === 0) return words.nobody;
      if (count === total) return words.all;
      if (count === 0) return words.none;
      if (count === 1) return fill(words.one, { total });
      return fill(words.many, { count, total });
    }
    case "VAN_UNCHECKED": {
      const words = health.metrics.VAN_UNCHECKED;
      if (count === 0) return words.none;
      if (count === 1) return words.one;
      return fill(words.many, { rides: rides(count) });
    }
    case "ARRIVING_LATE": {
      const words = health.metrics.ARRIVING_LATE;
      if (count === 0 || minutes === null) return words.none;
      const late = pluralize(minutes, countable.minute);
      if (count === 1) return fill(words.one, { child: children[0], minutes: late });
      return fill(words.many, { rides: rides(count), minutes: late });
    }
    case "NEEDS_A_PERSON": {
      const words = health.metrics.NEEDS_A_PERSON;
      if (count === 0) return words.none;
      if (count === 1) return fill(words.one, { child: children[0] });
      return fill(words.many, { rides: rides(count) });
    }
  }
}

/**
 * "Needs a person: 1 ride" — the heading of the list a number opens.
 *
 * Counted off `legKeys` and not off `count`, because the two are not always the same thing: a
 * number about *children* opens their rides, and "Children with a seat: 9 rides" over a list of
 * eighteen would be the first thing on the screen a reader could catch out.
 */
export function ridesHeading(metric: RoiMetric): string {
  return fill(health.ridesHeading, {
    label: metricLabel(metric.key),
    rides: rides(metric.legKeys.length),
  });
}

/* ───────────────────────────── the adapter panel ───────────────────────────── */

export function adapterName(key: AdapterKey): string {
  return health.adapterPanel.names[key];
}

/**
 * The mode chip (§3: icon and label carry the meaning, colour is the third cue).
 *
 * `unplug` for a mocked part and `plug` for a live one — neither is a §3 state icon and neither
 * is `flask-conical`, which §2 reserves for the Simulated source badge, so this chip cannot be
 * mistaken for the screen's own source chip or for a state of the day.
 *
 * A mocked row is **neutral**, never `ok`: a green chip on a simulated adapter is the exact
 * over-claim SURF-06 exists to prevent. It is not `warn` either, because a mocked adapter on a
 * demo deployment is what was intended rather than something going wrong — the panel says in
 * words, above the table, that none of it is live.
 */
export function adapterModeChip(row: AdapterStatus): StateDescriptor {
  return row.mode === "MOCK"
    ? { icon: Unplug, label: health.adapterPanel.modes.MOCK, tone: "neutral" }
    : { icon: Plug, label: health.adapterPanel.modes.LIVE, tone: "ok" };
}

/** Why this row is not live, or null when it is. */
export function adapterMockedBecause(row: AdapterStatus): string | null {
  return row.mockedBecause === null
    ? null
    : health.adapterPanel.mocked[row.mockedBecause];
}

/** What the row is doing on today's data, in the numbers the domain counted. */
export function adapterDoing(row: AdapterStatus): string {
  const words = health.adapterPanel.doing;
  switch (row.key) {
    case "SMS": {
      const { considered = 0, sent = 0 } = row.facts;
      return sent === 0
        ? fill(words.SMS_NONE_SENT, { considered })
        : fill(words.SMS, { considered, sent });
    }
    case "MAPS": {
      const { vans = 0, locating = 0, paused = 0 } = row.facts;
      return paused === 0
        ? fill(words.MAPS_NONE_PAUSED, { vans, locating })
        : fill(words.MAPS, { vans, locating, paused });
    }
    case "AGENT":
      return row.facts.liveCallsRefused === 1 ? words.AGENT_REFUSED : words.AGENT_ALLOWED;
  }
}

/** The one thing a coordinator does when this part stops working (PRD l.1200's runbook). */
export function adapterDegraded(key: AdapterKey): string {
  return health.adapterPanel.degraded[key];
}
