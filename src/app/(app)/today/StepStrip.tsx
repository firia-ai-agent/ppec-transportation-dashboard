import { ChevronRight } from "lucide-react";
import { canOpenPage, type Caller } from "@/auth/access";
import type { DayReadiness } from "@/domain/day/readiness";
import { flow } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import { currentStep, stepsOf } from "./step-strip";
import styles from "./step-strip.module.css";

/**
 * The order of the day, at the top of Today (redesign spec §9.2; Vera's §9 interim rules).
 *
 * Three cards — Van setup, Plan routes, Live map — each with a state icon in a disc, a name, one
 * detail line, a chip and a chevron. Every state has a **word** as well as an icon, so a
 * greyscale screenshot still tells them apart, and the first card that is not done carries
 * `aria-current="step"` and a brand ring.
 *
 * A locked card is still a link: it opens its page, and that page's own empty state names the
 * step that is missing (§9.2 — "no dead click and no `disabled` link"). What a role cannot open
 * is plain status instead of a link, which is the same rule the rail follows: hide what they
 * cannot use rather than refuse it afterwards.
 *
 * It reads `getDayReadiness` and decides nothing of its own (src/domain/day/readiness.ts).
 */
export function StepStrip({ readiness, caller }: { readiness: DayReadiness; caller: Caller }) {
  const steps = stepsOf(readiness);
  const current = currentStep(steps);

  return (
    <nav aria-label={flow.steps.aria} className={styles.strip}>
      <ol className={styles.list}>
        {steps.map((step) => {
          const Icon = step.icon;
          const open = canOpenPage(caller, hrefPath(step.href));
          const body = (
            <>
              <span className={styles.disc} data-tone={step.tone}>
                <Icon size={icon.nav} aria-hidden="true" />
              </span>
              <span className={styles.words}>
                <span className={styles.name}>{step.name}</span>
                <span className={styles.detail}>{step.detail}</span>
              </span>
              <span className={styles.chip} data-tone={step.tone}>
                {step.label}
              </span>
              {open ? <ChevronRight size={icon.inline} aria-hidden="true" /> : null}
            </>
          );
          return (
            <li
              key={step.key}
              className={styles.card}
              data-day-step={step.key}
              data-state={step.state}
              data-current={current?.key === step.key ? "true" : undefined}
              aria-current={current?.key === step.key ? "step" : undefined}
            >
              {open ? (
                <a className={styles.link} href={step.href}>
                  {body}
                </a>
              ) : (
                <span className={styles.link}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The path part of a step's address, which is what the access table is keyed by. */
function hrefPath(href: string): string {
  return href.split("?")[0];
}
