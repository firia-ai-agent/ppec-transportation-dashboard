/**
 * A screen's session as the actor of an action (`registry.ts`): the signed-in person, at the centre
 * the screen is for, now. The one place a route or a server action turns its caller into an
 * `ActionCtx`, so every screen acts the same way the agent acts for the person who asked.
 */
import type { StaffCaller } from "@/auth/api-guard";
import { siteOf } from "@/modules/plan/api";
import type { ActionCtx } from "./types";

export function screenCtx(caller: StaffCaller, now: Date = new Date()): ActionCtx {
  return { siteId: siteOf(caller), caller: { userId: caller.userId, role: caller.role }, now };
}
