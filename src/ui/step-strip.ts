import { canOpenPage } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import type { DayReadiness, StepState } from "@/domain/day/readiness";
import { fill, flow } from "./copy";
import { siteTimeLabel } from "./service-date";

/**
 * The step strip's three steps, in the order of the day (REDESIGN-SPEC §9.1): check the vans,
 * plan the routes, watch them run. Each one is the screen that does it, so every step is a way
 * into the frame rather than a page of its own.
 *
 * The states on them are read, not decided here: `deriveReadiness` (src/domain/day/readiness.ts)
 * turns the day's own rows into Done / Needed / Locked and this file turns those into a card.
 */
export type StepKey = keyof typeof flow.steps;
export type StepItem = { key: StepKey; label: string; href: string };

export type StripStep = StepItem & {
  /** Done, Needed or Locked for this step, today (§9.2's table). */
  state: StepState;
  /** The one line under the name: "3/3 checked", "Saved 2:41 PM", "Plan first". */
  detail: string;
  /** Is this card a link for this role? A step they cannot open is plain status text. */
  linked: boolean;
  /** The first card that is not Done: `aria-current="step"` and the brand ring (§9.2). */
  current: boolean;
  /** What the card is announced as — the step, its state, its detail, and where it opens. */
  ariaLabel: string;
};

/**
 * Words and addresses only — no icon, and that is a boundary rather than a preference. These
 * are computed on the server (src/app/(app)/today/page.tsx, which is where the access table's
 * answer and the day's readiness both live) and handed to a client component, and a React
 * component is a function: a `LucideIcon` in this object is "Functions cannot be passed directly
 * to Client Components" on every render of the board. The strip picks the icons for a step's
 * `key` and `state` on its own side (src/ui/StepStrip.tsx), exactly as the two rails build
 * their icons from `navItems` there.
 */
export const stepItems: readonly StepItem[] = [
  { key: "setup", label: flow.steps.setup, href: "/ramp-ipad" },
  { key: "plan", label: flow.steps.plan, href: "/plan-routes" },
  { key: "live", label: flow.steps.live, href: "/live-map" },
];

/** The step a locked one is waiting on, so a locked card opens the thing that would unlock it. */
const UNLOCKED_BY: Readonly<Partial<Record<StepKey, StepKey>>> = { live: "plan" };

const hrefOf = (key: StepKey): string =>
  stepItems.find((item) => item.key === key)!.href;

const labelOf = (key: StepKey): string =>
  stepItems.find((item) => item.key === key)!.label;

/**
 * THE STRIP AS ONE ROLE SEES IT, ON THIS DAY.
 *
 * Three decisions, in this order, and each of them is somebody else's answer rather than this
 * file's opinion:
 *
 *  1. **What each card says.** From the readiness: Van setup counts the vans checked, Plan
 *     routes names the minute it was saved at, and the live map says what it is waiting for
 *     (§9.5's `flow.detail.*`). Nothing is guessed — a day that could not be read comes back
 *     Needed, Needed and Locked (src/domain/day/readiness.ts), which is what a browser check
 *     with no database sees and what a failed query shows a founder.
 *
 *  2. **Where a card goes.** Its own screen, except a Locked one: §9.2 says a locked card is
 *     still a link and opens the page whose empty state names the missing step, and the clearer
 *     version of that — Firia, 7:55 PM ET — is for the card to open the missing step *itself*.
 *     So `Live map · Locked` opens `/plan-routes`, and its accessible name says so, because a
 *     chevron that quietly went somewhere else would be the one surprising click on the screen.
 *
 *  3. **Whether it is a link at all.** `canOpenPage` on whatever it would open — the same answer
 *     the menu is filtered by — so no role is handed a link that bounces. The front desk's Plan
 *     routes is plain status because that screen is not theirs; their Live map is plain too
 *     *while it is locked*, because the step it would open is the one they cannot have. It
 *     still shows all three cards: the order of the day is the same for everybody (§9.2).
 *
 * The brand ring goes on the first card that is not Done, which on a fresh day is Van setup —
 * "the thing to do next", said once rather than three times.
 */
export function stepsFor(role: StaffRole | null, readiness: DayReadiness): readonly StripStep[] {
  const caller = role ? ({ kind: "STAFF", role } as const) : ({ kind: "ANONYMOUS" } as const);
  const states: Readonly<Record<StepKey, StepState>> = {
    setup: readiness.setup.state,
    plan: readiness.plan.state,
    live: readiness.live.state,
  };
  const firstUndone = stepItems.find((item) => states[item.key] !== "DONE")?.key;

  return stepItems.map((item) => {
    const state = states[item.key];
    const detail = detailFor(item.key, state, readiness);
    const opens = state === "LOCKED" ? (UNLOCKED_BY[item.key] ?? item.key) : item.key;
    const href = hrefOf(opens);
    const values = { step: item.label, state: flow.state[wordOf(state)], detail };
    return {
      ...item,
      state,
      detail,
      href,
      linked: canOpenPage(caller, href),
      current: item.key === firstUndone,
      ariaLabel:
        opens === item.key
          ? fill(flow.stepAria, values)
          : fill(flow.stepAriaLocked, { ...values, target: labelOf(opens) }),
    };
  });
}

/** The state's own word, which is also the key its copy entry is under. */
function wordOf(state: StepState): keyof typeof flow.state {
  return state.toLowerCase() as keyof typeof flow.state;
}

/**
 * The one line under a step's name (§9.5). Each step says the thing *it* is measured by, which
 * is why there is no single sentence here: "3/3 checked" is a count, "Saved 2:41 PM" is a
 * minute, and "Plan first" is the step in front of this one.
 */
function detailFor(key: StepKey, state: StepState, readiness: DayReadiness): string {
  if (key === "setup") {
    return fill(flow.detail.setup, {
      checked: readiness.setup.checked,
      total: readiness.setup.total,
    });
  }
  if (key === "plan") {
    return readiness.plan.savedAt
      ? fill(flow.detail.planSaved, { time: siteTimeLabel(new Date(readiness.plan.savedAt)) })
      : flow.detail.planNone;
  }
  return state === "LOCKED" ? flow.detail.liveLocked : flow.detail.liveNeeded;
}
