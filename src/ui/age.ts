/**
 * Humanized ages for the screen. COPY-GUIDE §1 writes durations as "6 min" and §3 writes the
 * GPS bands as "Live · 12 s", "Stale · 4 min"; nothing above a minute is ever printed as raw
 * seconds, because "247 s" makes a coordinator do arithmetic while a child waits.
 *
 * Bands:
 *  - under a minute: whole seconds, "12 s"
 *  - under an hour: whole minutes, "4 min" (truncated, so an age never reads older than it is)
 *  - an hour or more: "1 h 5 min", and "1 h" exactly on the hour
 *
 * The short units are for the eye. A screen reader reads "12 s" as "twelve ess", so
 * `spokenAge` gives the same age in full words ("12 seconds", "1 hour 5 minutes") for the
 * sr-only half of `<Age>`; the two always describe the same instant.
 *
 * Words live in copy.ts (`age`, and `age.spoken`); this file only chooses the template.
 */
import { age, fill } from "./copy";

const MINUTE = 60;
const HOUR = 3600;

/**
 * An age is clamped at 0 (a clock skew must not print "-3 s") and truncated to whole units,
 * so it never reads older than it is. Non-finite input is 0 rather than "NaN min".
 */
function wholeSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}

/** Singular at exactly one: "1 minute", never "1 minutes". */
function plural(one: string, many: string, n: number): string {
  return n === 1 ? one : many;
}

/** The visible age: short units, the forms §1 and §3 write. */
export function humanizeAge(seconds: number): string {
  const total = wholeSeconds(seconds);

  if (total < MINUTE) return fill(age.seconds, { n: total });
  if (total < HOUR) return fill(age.minutes, { n: Math.floor(total / MINUTE) });

  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  return minutes === 0
    ? fill(age.hours, { h: hours })
    : fill(age.hoursMinutes, { h: hours, m: minutes });
}

/**
 * The same age in full words, for screen readers only (§9). Same bands and same truncation as
 * `humanizeAge`, so the ear and the eye never disagree: 59.9 s is "59 seconds" either way.
 */
export function spokenAge(seconds: number): string {
  const total = wholeSeconds(seconds);
  const words = age.spoken;

  if (total < MINUTE) return fill(plural(words.second, words.seconds, total), { n: total });

  if (total < HOUR) {
    const mins = Math.floor(total / MINUTE);
    return fill(plural(words.minute, words.minutes, mins), { n: mins });
  }

  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  const spokenHours = fill(plural(words.hour, words.hours, hours), { h: hours });
  if (minutes === 0) return spokenHours;
  const spokenMinutes = fill(plural(words.minute, words.minutes, minutes), { n: minutes });
  return `${spokenHours}${words.separator}${spokenMinutes}`;
}
