/** Restart demo day, as an action (ledger #74): the director's, and a person confirms it. */
import { z } from "zod";
import { API } from "@/auth/access";
import { getNeonDb } from "@/db/exec";
import { handleDemoReset } from "@/modules/demo/reset";
import { actionSummaries } from "@/ui/copy";
import { entry } from "./types";

export const DEMO_ACTIONS = {
  /** Restart demo day (the director's; a person confirms). */
  restart_demo_day: entry({
    name: "restart_demo_day",
    endpoint: API.demoReset,
    input: z.strictObject({ siteId: z.string().uuid().optional() }),
    confirm: true,
    describe: () => actionSummaries.restart,
    run: (ctx, i) =>
      // The site asked for, or none: the reset resolves the director's own centre itself, and asks
      // which one when there are several (demo/reset.ts) — exactly what the screen's button gets.
      handleDemoReset(getNeonDb(), process.env, { userId: ctx.caller.userId, siteId: i.siteId, now: ctx.now }),
  }),
} as const;
