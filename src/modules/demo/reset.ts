/**
 * Demo reset authorization (ADR-014, ADR-015, DECISION-LEDGER row 17).
 *
 * Three gates, in this order:
 *  1. deployment — never from a Vercel preview. Previews are served production's DATABASE_URL
 *     (single-DB directive, DECISION-LEDGER #43), so a reset there would truncate the real demo data;
 *     it refuses (403) ahead of every other check, including the role check, so no DB is touched.
 *  2. environment — DEMO_MODE=1 and APP_DATA_CLASS=SYNTHETIC. With the flags off the endpoint behaves as
 *     if it did not exist (404); with real data it refuses outright (403), never "just this once".
 *  3. role — DIRECTOR at the site being reset. The site comes from the caller's own membership, so a
 *     DIRECTOR at site A cannot reset site B by naming it.
 */
import { Forbidden, getMemberships, requireSiteRole } from "@/auth/core";
import type { Db } from "@/db/exec";
import { isReadOnlyDbEnv } from "@/db/read-only";
import { seedStandardScenario, type SeedResult } from "./seed";

/** Only this role may reset the demo (ADR-014). */
export const RESET_ROLES = ["DIRECTOR"] as const;

/** Shown to the caller on a preview deployment. No ticket, flag or connection detail in it. */
export const PREVIEW_REFUSAL =
  "Refusing: preview deployments share the one production database, so the demo reset is disabled here.";

export type Gate =
  | { allowed: true; status: 200; reason: string }
  | { allowed: false; status: 403 | 404; reason: string };

export function demoControlsGate(env: Record<string, string | undefined>): Gate {
  // Loud rather than invisible, and ahead of the DEMO_MODE 404: an operator on a preview (where the
  // demo flags are normally on) needs to read why the reset refused, and the shared DB is what is at stake.
  if (isReadOnlyDbEnv(env)) return { allowed: false, status: 403, reason: PREVIEW_REFUSAL };
  if (env.DEMO_MODE !== "1") return { allowed: false, status: 404, reason: "Demo controls are not enabled here." };
  if (env.APP_DATA_CLASS !== "SYNTHETIC") {
    return { allowed: false, status: 403, reason: "Refusing: this deployment is not marked as synthetic data." };
  }
  return { allowed: true, status: 200, reason: "Demo controls are enabled." };
}

export type ResetRequest = { userId?: string; siteId?: string; now: Date };
export type ResetResponse =
  | { status: 200; body: { ok: true } & SeedResult }
  | { status: 400 | 401 | 403 | 404; body: { ok: false; error: string } };

/**
 * Runs the standard-scenario reset for a signed-in DIRECTOR. Never throws for an authorization
 * problem: the caller maps {status, body} straight onto the HTTP response.
 */
export async function handleDemoReset(db: Db, env: Record<string, string | undefined>, req: ResetRequest): Promise<ResetResponse> {
  const gate = demoControlsGate(env);
  if (!gate.allowed) return { status: gate.status, body: { ok: false, error: gate.reason } };
  if (!req.userId) return { status: 401, body: { ok: false, error: "Sign in to continue." } };

  let siteId = req.siteId;
  if (!siteId) {
    const directorAt = (await getMemberships(db, req.userId)).filter((m) => m.role === "DIRECTOR");
    if (directorAt.length !== 1) {
      return directorAt.length === 0
        ? { status: 403, body: { ok: false, error: "Only a director can reset the demo." } }
        : { status: 400, body: { ok: false, error: "Name the site to reset." } };
    }
    siteId = directorAt[0].siteId;
  }

  try {
    await requireSiteRole(db, req.userId, siteId, [...RESET_ROLES]);
  } catch (e) {
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: "Only a director can reset the demo." } };
    throw e;
  }

  const result = await seedStandardScenario(db, { now: req.now, siteId, env });
  return { status: 200, body: { ok: true, ...result } };
}

/* ───────────────────────── operator CLI (scripts/demo-reset.ts) ───────────────────────── */

export type CliGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Gate for the operator CLI. Refuses whenever VERCEL_ENV is set to anything at all — preview,
 * production, development, even the empty string — so this truncate can only ever be typed into a
 * local/operator shell with its own DATABASE_URL, never run from a Vercel build, function, cron or
 * deploy hook against the one shared DB (DECISION-LEDGER #43). Pure: the caller does the exiting.
 */
export function demoResetCliGate(env: Record<string, string | undefined>, argv: string[]): CliGate {
  if (env.VERCEL_ENV !== undefined) {
    return { allowed: false, reason: `refusing: never run from a Vercel environment (VERCEL_ENV=${env.VERCEL_ENV || "empty"}); run it from a local operator shell` };
  }
  if (!argv.includes("--confirm")) return { allowed: false, reason: "refusing: this truncates the demo data; pass --confirm" };
  if (env.APP_DATA_CLASS !== "SYNTHETIC") return { allowed: false, reason: "refusing: APP_DATA_CLASS must be SYNTHETIC" };
  return { allowed: true };
}
