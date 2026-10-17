import { Map as MapIcon, Route, Tablet, type LucideIcon } from "lucide-react";
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
export type StepItem = { key: StepKey; label: string; href: string; icon: LucideIcon };
export type StripStep = StepItem & { linked: boolean };

/**
 * Each step wears its *destination's* icon — the same one the menu gives that screen
 * (src/ui/nav-items.ts): the ramp iPad's tablet, Plan routes' route, the live map's map. Not a
 * state icon, and that is the point. REDESIGN-SPEC §9.2 draws a `circle-check` / `circle-alert`
 * / `lock` in the disc, which says Done / Needed / Locked — and none of those three is a thing
 * this build can know yet (TODO(data-model)). An icon that *looked* like a state would be the
 * strip claiming one. The destination's own icon says the true thing instead: this card opens
 * that screen.
 */
export const stepItems: readonly StepItem[] = [
  { key: "setup", label: flow.steps.setup, href: "/ramp-ipad", icon: Tablet },
  { key: "plan", label: flow.steps.plan, href: "/plan-routes", icon: Route },
  { key: "live", label: flow.steps.live, href: "/live-map", icon: MapIcon },
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
