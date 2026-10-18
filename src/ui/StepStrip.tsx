import Link from "next/link";
import { ChevronRight, CircleAlert, CircleCheck, Lock } from "lucide-react";
import type { StepState } from "@/domain/day/readiness";
import { flow } from "./copy";
import { StateChip } from "./StateChip";
import type { StateDescriptor } from "./states";
import type { StripStep } from "./step-strip";
import { icon } from "./tokens";
import styles from "./StepStrip.module.css";

/**
 * §9.2's state table, verbatim: Done is `circle-check` on ok, Needed is `circle-alert` on warn,
 * Locked is `lock` on neutral. Every one of them is an icon **and** a word, so a greyscale
 * screenshot of this strip still reads and colour is only ever the third cue (§3, §9). Violet
 * never appears here — it is the demo's, and the bar above the screen is where it lives.
 *
 * Written as the §3 `StateDescriptor` the rest of the app's chips take, so the strip's chip is
 * the same object as the board's rather than a second kind of chip that happens to look alike.
 *
 * Here rather than beside the steps themselves because the steps cross the server/client
 * boundary and a React component is a function; the two rails build their icons on this side
 * for the same reason (src/ui/NavRail.tsx).
 */
const STATE_MARKS: Readonly<Record<StepState, StateDescriptor>> = {
  DONE: { icon: CircleCheck, label: flow.state.done, tone: "ok" },
  NEEDED: { icon: CircleAlert, label: flow.state.needed, tone: "warn" },
  LOCKED: { icon: Lock, label: flow.state.locked, tone: "neutral" },
};

/**
 * TODAY'S STEP STRIP (REDESIGN-SPEC §9.2, and png/shell-flow-1440.png / -390.png).
 *
 * Three cards in one row under the board's own header: a 32 px state disc, the step's name, the
 * one line its own data says, a state chip and a chevron. The order of the day as something a
 * person can walk rather than something they are told — and, since the step states landed, as
 * something that is *true*: the states are read from today's own rows
 * (src/domain/day/readiness.ts) rather than left off the card, which is what the cards used to
 * say they were waiting for.
 *
 * The disc takes a hairline in the tone's own ink, so its edge is ≥3:1 against the card it sits
 * on while the icon inside it keeps the §8 pair's 6.5:1 (§9.2's two contrast rules, which are
 * about two different edges).
 *
 * The first card that is not Done carries `aria-current="step"` and the brand ring: the thing to
 * do next, marked once. A card whose destination this role may not open is plain text — no
 * chevron, no pointer, no hover — which is what §9.2 asks for the front desk, who sees all three
 * cards and can open one.
 *
 * At 390 the three cards stay in one row and stack inside: the disc over the name, the detail
 * and the chip under it, with the chevron in the corner (the stylesheet, and the PNG).
 */
export function StepStrip({ steps }: { steps: readonly StripStep[] }) {
  return (
    <nav aria-label={flow.stepsAria} className={styles.strip}>
      <ol className={styles.list}>
        {steps.map((step) => {
          const mark = STATE_MARKS[step.state];
          const StateIcon = mark.icon;
          const body = (
            <>
              <span className={styles.disc} data-tone={mark.tone} aria-hidden="true">
                <StateIcon size={icon.inline} />
              </span>
              <span className={styles.text}>
                <span className={styles.name}>{step.label}</span>
                <span className={styles.detail}>{step.detail}</span>
              </span>
              <StateChip state={mark} className={styles.chip} />
            </>
          );
          return (
            <li key={step.key} className={styles.item}>
              {step.linked ? (
                /*
                 * A Locked card opens the step it is waiting on, not the one it names (§9.2),
                 * so the accessible name says where it goes — `ariaLabel` carries that, and it
                 * replaces what is inside the link rather than being read on top of it.
                 */
                <Link
                  href={step.href}
                  className={`${styles.card} ${styles.link}`}
                  data-step={step.key}
                  data-state={step.state}
                  aria-current={step.current ? "step" : undefined}
                  aria-label={step.ariaLabel}
                >
                  {body}
                  <ChevronRight className={styles.chevron} size={icon.inline} aria-hidden="true" />
                </Link>
              ) : (
                <span
                  className={`${styles.card} ${styles.plain}`}
                  data-step={step.key}
                  data-state={step.state}
                  aria-current={step.current ? "step" : undefined}
                >
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
