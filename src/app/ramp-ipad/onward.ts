/**
 * Where a ramp check can be carried on to, for the person holding the iPad.
 *
 * The re-plan panel's two links hand the finding to the two screens that decide about it — Plan
 * routes, where a coordinator approves the moves, and the Today board, where the day is watched.
 * Both were on the screen for every role, and the front desk can open neither: the ramp iPad is
 * their surface (PRD §6.2), the two console routes are not in their row of the access table, and
 * tapping either answered a 403 (Vera's prod walk, 2026-10-17). A link that refuses is worse
 * than no link — the person tapping it is left working out whether the check was lost.
 *
 * So the list is filtered by the same table the rail is filtered by (`canRoleOpen`), and there is
 * no second opinion about roles written here. Pure and exported, because what a role is offered
 * is the half worth asserting without a browser; the screen only maps over what it returns.
 *
 * This hides a link, which is never the guard: Plan routes and the board check the server
 * themselves, and guard-matrix.test.ts asks them with no browser involved (hiding ≠ denying).
 */
import type { StaffRole } from "@/auth/core";
import { ARRIVAL_PARAM } from "@/domain/plan/arrival";
import { rampReplan } from "@/ui/copy";
import { canRoleOpen } from "@/ui/nav-items";

export type OnwardLink = { href: string; label: string };

/** The screens this check can be opened on, as this role's own links. Empty is a valid answer. */
export function onwardLinks(role: StaffRole | null, findingCode: string): readonly OnwardLink[] {
  const carrying = `${ARRIVAL_PARAM}=${encodeURIComponent(findingCode)}`;
  return (
    [
      { page: "/plan-routes", label: rampReplan.openPlan },
      { page: "/today", label: rampReplan.openBoard },
    ] as const
  )
    .filter((link) => canRoleOpen(role, link.page))
    .map((link) => ({ href: `${link.page}?${carrying}`, label: link.label }));
}
