/**
 * Demo reset authorization (ADR-014, ADR-015, DECISION-LEDGER row 17).
 *
 * Three gates, in this order:
 *  1. deployment — never from a Vercel preview. Previews are served production's DATABASE_URL
 *     (single-DB directive, DECISION-LEDGER #43), so a reset there would truncate the real demo data;
 *     it refuses (403) ahead of every other check, including the role check, so no DB is touched.
 *  2. environment — DEMO_MODE=1 and APP_DATA_CLASS=SYNTHETIC. With the flags off the endpoint behaves as
 *     if it did not exist (404); with real data it refuses outright (403), never "just this once".
 *  3. role and site — the roles the access table names **at the site being reset**. The
 *     site comes from the caller's own membership when the request does not name one; when it
 *     does, the id is checked against the caller's memberships, so a DIRECTOR at site A naming
 *     site B — or a random id, or an id that matches nothing — gets the same 404 and learns
 *     nothing about which sites exist (BUILD-PLAN §4).
 */
import { Forbidden, SiteNotFound, Unauthenticated, getMemberships, requireSiteAccess, type StaffRole } from "@/auth/core";
import { API, rolesWhoCanCall } from "@/auth/access";
import { demoReset as copy } from "@/ui/copy";
import type { Db } from "@/db/exec";
import { isReadOnlyDbEnv } from "@/db/read-only";
import { DEMO_RESET_REFUSAL, type DemoResetRefusal } from "./refusal";
import { seedStandardScenario, type SeedResult } from "./seed";
import { clearSavedPlans } from "./plan-store";

/**
 * The roles that may reset the demo — the director and the coordinator, by the founder's final
 * ruling (2026-10-17 14:44 ET, DECISION-LEDGER row 88; ADR-014 named the director alone). Read
 * from the one access table rather than written out again here, so the endpoint and the table
 * cannot disagree about it: the row is the single place either of them changes.
 */
export const RESET_ROLES: readonly StaffRole[] = rolesWhoCanCall(API.demoReset);

/** Shown to the caller on a preview deployment. No ticket, flag or connection detail in it. */
export const PREVIEW_REFUSAL = copy.previewRefusal;

export type Gate =
  | { allowed: true; status: 200; reason: string }
  | {
      allowed: false;
      status: 403 | 404;
      reason: string;
      /**
       * Set on the one refusal that is expected rather than wrong, so a surface can act on it
       * without matching on the sentence (./refusal.ts). Absent on every other refusal.
       */
      refusal?: DemoResetRefusal;
    };

export function demoControlsGate(env: Record<string, string | undefined>): Gate {
  // Loud rather than invisible, and ahead of the DEMO_MODE 404: an operator on a preview (where the
  // demo flags are normally on) needs to read why the reset refused, and the shared DB is what is at stake.
  if (isReadOnlyDbEnv(env)) {
    return { allowed: false, status: 403, reason: PREVIEW_REFUSAL, refusal: DEMO_RESET_REFUSAL.readOnlyDb };
  }
  if (env.DEMO_MODE !== "1") return { allowed: false, status: 404, reason: copy.notEnabled };
  if (env.APP_DATA_CLASS !== "SYNTHETIC") {
    return { allowed: false, status: 403, reason: copy.notSynthetic };
  }
  return { allowed: true, status: 200, reason: copy.enabled };
}

export type ResetRequest = { userId?: string; siteId?: string; now: Date };
export type ResetResponse =
  | { status: 200; body: { ok: true } & SeedResult }
  | { status: 400 | 401 | 403 | 404; body: { ok: false; error: string; refusal?: DemoResetRefusal } };

/**
 * Runs the standard-scenario reset for a signed-in caller holding one of `RESET_ROLES`. Never
 * throws for an authorization problem: the caller maps {status, body} straight onto the HTTP
 * response.
 */
export async function handleDemoReset(db: Db, env: Record<string, string | undefined>, req: ResetRequest): Promise<ResetResponse> {
  const gate = demoControlsGate(env);
  if (!gate.allowed) {
    const body = { ok: false as const, error: gate.reason, ...(gate.refusal ? { refusal: gate.refusal } : {}) };
    return { status: gate.status, body };
  }
  if (!req.userId) return { status: 401, body: { ok: false, error: copy.signIn } };

  let siteId = req.siteId;
  if (!siteId) {
    /*
     * The caller's own memberships, narrowed to the roles the table opens this endpoint to — so
     * a coordinator resolves their site the same way a director does, from one list. One row per
     * site, by `site_membership`'s own primary key (user_id, site_id), so these are sites: none
     * of them is a 403, and more than one is the question only the caller can answer.
     */
    const resetAt = (await getMemberships(db, req.userId)).filter((m) => RESET_ROLES.includes(m.role));
    if (resetAt.length !== 1) {
      return resetAt.length === 0
        ? { status: 403, body: { ok: false, error: copy.roleRefused } }
        : { status: 400, body: { ok: false, error: copy.nameTheSite } };
    }
    siteId = resetAt[0].siteId;
  }

  try {
    await requireSiteAccess(db, req.userId, siteId, RESET_ROLES);
  } catch (e) {
    // A user who was disabled while holding a session is signed out, not refused a role.
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: copy.signIn } };
    // A site the caller is not a member of is a uniform not-found, whether it exists or not.
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: copy.noSuchSite } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: copy.roleRefused } };
    throw e;
  }

  const result = await seedStandardScenario(db, { now: req.now, siteId, env });
  // The day those plans were plans of has just been re-seeded, so the demo's own plan state goes
  // with it: a reset that left yesterday's saved plan behind would be a half reset.
  clearSavedPlans();
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
