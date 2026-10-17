import Link from "next/link";
import { ChevronRight, Map as MapIcon, Route, Tablet, type LucideIcon } from "lucide-react";
import { flow } from "./copy";
import type { StepKey, StripStep } from "./step-strip";
import { icon } from "./tokens";
import styles from "./StepStrip.module.css";

/**
 * Each step wears its *destination's* icon — the same one the menu gives that screen
 * (src/ui/nav-items.ts): the ramp iPad's tablet, Plan routes' route, the live map's map. Not a
 * state icon, and that is the point. REDESIGN-SPEC §9.2 draws a `circle-check` / `circle-alert`
 * / `lock` in the disc, which says Done / Needed / Locked — and none of those three is a thing
 * this build can know yet (TODO(data-model)). An icon that *looked* like a state would be the
 * strip claiming one. The destination's own icon says the true thing instead: this card opens
 * that screen.
 *
 * Here rather than beside the steps themselves because the steps cross the server/client
 * boundary and a component is a function; the two rails build their icons on this side for the
 * same reason (src/ui/NavRail.tsx).
 */
const STEP_ICONS: Readonly<Record<StepKey, LucideIcon>> = {
  setup: Tablet,
  plan: Route,
  live: MapIcon,
};

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
          const StepIcon = STEP_ICONS[step.key];
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
