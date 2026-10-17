import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { flow } from "./copy";
import type { StripStep } from "./step-strip";
import { icon } from "./tokens";
import styles from "./StepStrip.module.css";

/**
 * TODAY'S STEP STRIP (REDESIGN-SPEC §9.2, and png/shell-flow-1440.png / -390.png).
 *
 * Three cards in one row under the board's own header: a 32 px icon disc, the step's name, and
 * a chevron. Each one is a link to the screen that does that step, inside the frame — the order
 * of the day as something you can walk rather than something you are told.
 *
 * **No states.** §9.2 also draws a chip on each card (Done · Needed · Locked) and a detail line
 * under the name ("3/3 checked", "Not saved", "Plan first"). Every one of those is read from
 * the day's readiness, and docs/DATA-MODEL.md has not signed the section that says how — so
 * there is nothing here to derive them from, and a strip that guessed would be the one thing on
 * this screen that is not a fact. TODO(data-model): the chip, the detail line and the
 * `aria-current="step"` on the first card that is not done land together, from that model, when
 * it is signed. Until then the cards are what they honestly are: three ways in.
 *
 * A step whose screen this role may not open is plain text — no chevron, no pointer, no hover.
 * §9.2 asks for exactly that for the front desk, who sees all three cards and can open one.
 *
 * At 390 the three cards stay in one row and stack inside: the disc over the name, with the
 * chevron in the corner (the stylesheet, and the PNG).
 */
export function StepStrip({ steps }: { steps: readonly StripStep[] }) {
  return (
    <nav aria-label={flow.stepsAria} className={styles.strip}>
      <ol className={styles.list}>
        {steps.map((step) => {
          const StepIcon = step.icon;
          const body = (
            <>
              <span className={styles.disc} aria-hidden="true">
                <StepIcon size={icon.nav} />
              </span>
              <span className={styles.name}>{step.label}</span>
            </>
          );
          return (
            <li key={step.key} className={styles.item}>
              {step.linked ? (
                <Link
                  href={step.href}
                  className={`${styles.card} ${styles.link}`}
                  data-step={step.key}
                >
                  {body}
                  <ChevronRight className={styles.chevron} size={icon.inline} aria-hidden="true" />
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
