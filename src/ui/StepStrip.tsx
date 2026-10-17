import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { flow } from "./copy";
import type { StripStep } from "./step-strip";
import styles from "./StepStrip.module.css";

/**
 * Today's step strip (REDESIGN-SPEC §9.2): an ordered list of the day's three steps, each a link
 * to its screen inside the frame. A step the role cannot open renders as plain text with no
 * chevron, no pointer and no hover — never a dead link.
 */
export function StepStrip({ steps }: { steps: readonly StripStep[] }) {
  return (
    <nav aria-label={flow.stepsAria} className={styles.strip}>
      <ol className={styles.list}>
        {steps.map((step, index) => {
          const body = (
            <>
              <span className={styles.disc} aria-hidden="true">
                {index + 1}
              </span>
              <span className={styles.name}>{step.label}</span>
            </>
          );
          return (
            <li key={step.key} className={styles.item}>
              {step.linked ? (
                <Link href={step.href} className={`${styles.card} ${styles.link}`} data-step={step.key}>
                  {body}
                  <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
                </Link>
              ) : (
                <span className={`${styles.card} ${styles.plain}`} data-step={step.key}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
