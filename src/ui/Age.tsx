import { humanizeAge, spokenAge } from "./age";

/**
 * An age, written twice: the short form the eye reads ("12 s", "1 h 5 min") and the same age
 * in full words for a screen reader ("12 seconds", "1 hour 5 minutes"), because "12 s" is read
 * out as "twelve ess" (§9). The visible half is `aria-hidden`, so the age is announced once.
 *
 * The sr-only half uses the global `.srOnly` utility in src/app/globals.css, the same one the
 * state chip and the source badge use.
 */
export function Age({ seconds, className }: { seconds: number; className?: string }) {
  return (
    <span className={className}>
      <span aria-hidden="true">{humanizeAge(seconds)}</span>
      <span className="srOnly">{spokenAge(seconds)}</span>
    </span>
  );
}
