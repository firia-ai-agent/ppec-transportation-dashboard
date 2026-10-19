/**
 * Demo reset authorization (ADR-014, ADR-015, DECISION-LEDGER row 17).
 *
 * Three gates, in this order:
 *  1. deployment — never from a Vercel preview. Previews are served production's DATABASE_URL
 *     (single-DB directive, DECISION-LEDGER #43), so a reset there would truncate the real demo data;
 *     it refuses (403) ahead of every other check, including the role check, so no DB is touched.
 *  2. environment — DEMO_MODE=1 and APP_DATA_CLASS=SYNTHETIC. With the flags off the endpoint behaves as
 *     if it did not exist (404); with real data it refuses outright (403), never "just this once".
 *  3. role and site — the role the access table names (DIRECTOR) **at the site being reset**. The
 *     site comes from the caller's own membership when the request does not name one; when it
 *     does, the id is checked against the caller's memberships, so a DIRECTOR at site A naming
 *     site B — or a random id, or an id that matches nothing — gets the same 404 and learns
 *     nothing about which sites exist (BUILD-PLAN §4).
 */
import { Forbidden, SiteNotFound, Unauthenticated, getMemberships, requireSiteAccess, type StaffRole } from "@/auth/core";
import { API, endpointRow } from "@/auth/access";
import { demoReset as copy } from "@/ui/copy";
import type { Db } from "@/db/exec";
import { seedStandardScenario, type SeedResult } from "./seed";
import { clearMemoryPlanStore } from "@/modules/plan/memory";

/**
 * Only this role may reset the demo (ADR-014) — read from the one access table rather than
 * written out again here, so the endpoint and the table cannot disagree about it.
 */
const RESET_ROW = endpointRow(API.demoReset)?.auth;
export const RESET_ROLES: readonly StaffRole[] =
  RESET_ROW?.kind === "session" ? RESET_ROW.roles : [];

import { demoControlsGate } from "./gate";

export { PREVIEW_REFUSAL, demoControlsGate, type Gate } from "./gate";

export type ResetRequest = { userId?: string; siteId?: string; now: Date };
export type ResetResponse =
  | { status: 200; body: { ok: true } & SeedResult }
  | { status: 400 | 401 | 403 | 404; body: { ok: false; error: string } };

/**
 * Runs the standard-scenario reset for a signed-in DIRECTOR. Never throws for an authorization
 * problem: the caller maps {status, body} straight onto the HTTP response.
 */
export async function handleDemoReset(
  db: Db,
  env: Record<string, string | undefined>,
  req: ResetRequest,
): Promise<ResetResponse> {
  const gate = demoControlsGate(env);
  if (!gate.allowed) return { status: gate.status, body: { ok: false, error: gate.reason } };
  if (!req.userId) return { status: 401, body: { ok: false, error: copy.signIn } };

  let siteId = req.siteId;
  if (!siteId) {
    const directorAt = (await getMemberships(db, req.userId)).filter((m) => m.role === "DIRECTOR");
    if (directorAt.length !== 1) {
      return directorAt.length === 0
        ? { status: 403, body: { ok: false, error: copy.directorOnly } }
        : { status: 400, body: { ok: false, error: copy.nameTheSite } };
    }
    siteId = directorAt[0].siteId;
  }

  try {
    await requireSiteAccess(db, req.userId, siteId, RESET_ROLES);
  } catch (e) {
    // A user who was disabled while holding a session is signed out, not refused a role.
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: copy.signIn } };
    // A site the caller is not a member of is a uniform not-found, whether it exists or not.
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: copy.noSuchSite } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: copy.directorOnly } };
    throw e;
  }

  const result = await seedStandardScenario(db, { now: req.now, siteId, env });
  /*
   * NO CARD, NO ALERT AND NO INBOUND TEXT ARE WRITTEN HERE (founder and user, 2026-10-18). A
   * decision is the model's to propose, from a parent's own text — which the demo sends when a
   * person presses "Simulate parent text" on Family texts (`demo/parent-text.ts`, ledger #78).
   */
  /*
   * The seed truncates the board's three tables and writes yesterday's van setups back
   * (src/modules/demo/seed.ts), so the plan itself is gone with the rest of the day's rows.
   * What a TRUNCATE cannot reach is the memory store — the fallback the browser check runs on,
   * where there is no database at all (src/modules/plan/memory.ts) — and a day that has just
   * been re-seeded must not still have last night's plan of it hanging about on either path.
   */
  clearMemoryPlanStore();
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
