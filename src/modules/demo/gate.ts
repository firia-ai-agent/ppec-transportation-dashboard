/**
 * THE DEMO CONTROLS' ENVIRONMENT GATE (ADR-014, ADR-015), on its own so a demo control can ask it
 * without importing the reset — and the seed behind it — into its graph.
 *
 *  1. never from a Vercel preview: previews are served production's DATABASE_URL (ledger #43), so
 *     it refuses (403) ahead of every other check;
 *  2. DEMO_MODE=1 and APP_DATA_CLASS=SYNTHETIC: with the flags off the control does not exist (404);
 *     with real data it refuses outright (403).
 */
import { isReadOnlyDbEnv } from "@/db/read-only";
import { demoReset as copy } from "@/ui/copy";

/** Shown to the caller on a preview deployment. No ticket, flag or connection detail in it. */
export const PREVIEW_REFUSAL = copy.previewRefusal;

export type Gate =
  | { allowed: true; status: 200; reason: string }
  | { allowed: false; status: 403 | 404; reason: string };

export function demoControlsGate(env: Record<string, string | undefined>): Gate {
  // Loud rather than invisible, and ahead of the DEMO_MODE 404: an operator on a preview (where the
  // demo flags are normally on) needs to read why the control refused, and the shared DB is what is at stake.
  if (isReadOnlyDbEnv(env)) return { allowed: false, status: 403, reason: PREVIEW_REFUSAL };
  if (env.DEMO_MODE !== "1") return { allowed: false, status: 404, reason: copy.notEnabled };
  if (env.APP_DATA_CLASS !== "SYNTHETIC") {
    return { allowed: false, status: 403, reason: copy.notSynthetic };
  }
  return { allowed: true, status: 200, reason: copy.enabled };
}
