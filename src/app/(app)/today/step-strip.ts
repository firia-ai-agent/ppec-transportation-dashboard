/**
 * The three steps of the day, as the strip at the top of Today draws them.
 *
 * SOURCE: redesign spec §9.2 ("Step strip (Today only, under the page header)") and §9.5's `flow`
 * block; Vera's binding interim rules of 2026-10-17 3:00 PM ET ("three steps Vans, Plan, Live.
 * Each clickable, state Done / Needed / Locked, always icon + word, never colour alone").
 *
 * Pure: a `DayReadiness` in (src/domain/day/readiness.ts — the one helper the empty states and
 * the server guards also read), three cards out. Nothing here re-decides what is done; it only
 * says it in words, which is what keeps the strip and the screens it links to in agreement.
 */
import { CircleAlert, CircleCheck, Lock, Radio, type LucideIcon } from "lucide-react";
import type { DayReadiness, StepState } from "@/domain/day/readiness";
import { fill, flow } from "@/ui/copy";
import { siteTimeLabel } from "@/ui/service-date";
import { boardHref } from "@/modules/plan/when";
import type { Tone } from "@/ui/tokens";

export type Step = {
  /** `setup` | `plan` | `live`, which is also the test's handle on the card. */
  key: "setup" | "plan" | "live";
  name: string;
  /** One line about where this step is: "1/3 checked", "Saved 2:41 PM", "Plan first". */
  detail: string;
  state: StepState;
  /** The word on the chip — never only a tone (§0's rule 2). */
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** Where the card goes, carrying the day and the leg (§9.2). */
  href: string;
};

const CHIP: Record<StepState, { label: string; tone: Tone; icon: LucideIcon }> = {
  DONE: { label: flow.state.done, tone: "ok", icon: CircleCheck },
  NEEDED: { label: flow.state.needed, tone: "warn", icon: CircleAlert },
  LOCKED: { label: flow.state.locked, tone: "neutral", icon: Lock },
  RUNNING: { label: flow.state.running, tone: "info", icon: Radio },
};

/** The three cards, in the order of the day (§9.1). */
export function stepsOf(readiness: DayReadiness): Step[] {
  const where = { date: readiness.date, leg: readiness.leg };
  return [
    {
      key: "setup",
      name: flow.steps.setup,
      /*
       * How many vans the ramp has confirmed today — and, only while **none** has, which day the
       * setups being planned against came from, which is the same thing the board's banner says.
       * §9.6 #5 is the case that fixes the order: after one Confirm the card reads "1/3 checked",
       * because a count that has started moving is the more useful of the two facts.
       */
      detail:
        readiness.setup.checked > 0 || !readiness.setup.fromDay
          ? fill(flow.setup.detail, { checked: readiness.setup.checked, total: readiness.setup.total })
          : fill(flow.setup.detailFrom, { day: readiness.setup.fromDay }),
      state: readiness.setup.state,
      ...CHIP[readiness.setup.state],
      href: boardHref("/ramp-ipad", where),
    },
    {
      key: "plan",
      name: flow.steps.plan,
      detail: planDetail(readiness),
      state: readiness.plan.state,
      ...CHIP[readiness.plan.state],
      href: boardHref("/plan-routes", where),
    },
    {
      key: "live",
      name: flow.steps.live,
      detail: liveDetail(readiness),
      state: readiness.live.state,
      ...CHIP[readiness.live.state],
      href: boardHref("/live-map", where),
    },
  ];
}

function planDetail(readiness: DayReadiness): string {
  if (readiness.plan.state === "LOCKED") return flow.plan.detailNotStarted;
  if (readiness.plan.savedAt) {
    return fill(flow.plan.detailSaved, { time: siteTimeLabel(new Date(readiness.plan.savedAt)) });
  }
  return flow.plan.detailNone;
}

function liveDetail(readiness: DayReadiness): string {
  if (readiness.live.state === "RUNNING") {
    return fill(flow.live.detailRunning, { n: readiness.live.vansOut });
  }
  // Locked by the missing plan or by the day itself; both say what is missing rather than why.
  if (readiness.live.state === "LOCKED") {
    return readiness.live.blockedBy === "START" ? flow.plan.detailNotStarted : flow.live.detailLocked;
  }
  return flow.live.detailNeeded;
}

/**
 * The first step that is not done, which is the one the strip marks as current (§9.2).
 *
 * `aria-current="step"` and a brand ring, so "where am I in the day" is answered the same way to
 * a screen reader and to an eye. A day with everything done marks nothing.
 */
export function currentStep(steps: readonly Step[]): Step | null {
  return steps.find((step) => step.state !== "DONE" && step.state !== "RUNNING") ?? null;
}
