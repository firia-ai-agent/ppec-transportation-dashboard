import { canOpenPage } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { flow } from "./copy";

/**
 * The step strip's three steps, in the order of the day (REDESIGN-SPEC §9.1): check the vans,
 * plan the routes, watch them run. Each one is the screen that does it, so every step is a link
 * inside the frame — never a page of its own, never a lock (TODO(data-model): states and locks
 * are wired from docs/DATA-MODEL.md once it is signed).
 */
export type StepKey = keyof typeof flow.steps;
export type StepItem = { key: StepKey; label: string; href: string };
export type StripStep = StepItem & { linked: boolean };

/**
 * Words and addresses only — no icon, and that is a boundary rather than a preference. These
 * are computed on the server (src/app/(app)/today/page.tsx, which is where the access table's
 * answer lives) and handed to a client component, and a React component is a function: a
 * `LucideIcon` in this object is "Functions cannot be passed directly to Client Components" on
 * every render of the board. The strip picks the icon for a step's `key` on its own side
 * (src/ui/StepStrip.tsx), exactly as the two rails build their icons from `navItems` there.
 */
export const stepItems: readonly StepItem[] = [
  { key: "setup", label: flow.steps.setup, href: "/ramp-ipad" },
  { key: "plan", label: flow.steps.plan, href: "/plan-routes" },
  { key: "live", label: flow.steps.live, href: "/live-map" },
];

/**
 * The strip as one role sees it. A step is a link only where the access table opens its screen
 * to that role — the same `canOpenPage` the menu filters with — so no role is ever handed a link
 * that bounces. A step the role cannot open stays as plain text: it still names the order of the
 * day, and nothing about it looks tappable.
 */
export function stepsFor(role: StaffRole | null): readonly StripStep[] {
  const caller = role ? ({ kind: "STAFF", role } as const) : ({ kind: "ANONYMOUS" } as const);
  return stepItems.map((item) => ({ ...item, linked: canOpenPage(caller, item.href) }));
}
