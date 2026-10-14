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
 * Words live in copy.ts (`age`); this file only chooses the template.
 */
import { age, fill } from "./copy";

const MINUTE = 60;
const HOUR = 3600;

/**
 * `seconds` is an age, so it is clamped at 0 (a clock skew must not print "-3 s") and
 * truncated to whole units. Non-finite input is treated as 0 rather than printing "NaN min".
 */
export function humanizeAge(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;

  if (total < MINUTE) return fill(age.seconds, { n: total });
  if (total < HOUR) return fill(age.minutes, { n: Math.floor(total / MINUTE) });

  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  return minutes === 0
    ? fill(age.hours, { h: hours })
    : fill(age.hoursMinutes, { h: hours, m: minutes });
}
