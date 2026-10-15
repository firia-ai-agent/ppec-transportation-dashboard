/**
 * The server-side guard for the API routes that take a **session** (ADR-004).
 *
 * It answers in JSON, with real status codes, so a caller is never handed a 200 that happens to
 * be empty:
 *  - no session, or a session whose user is disabled or gone → **401**;
 *  - signed in, not one of the roles the access table names for this route → **403**;
 *  - a path with no row in the table, or a row whose auth is not a session (the cron secret, a
 *    queue callback, Auth.js's own handlers) → **403**, because a session must never be a way
 *    into those. They keep their own auth and this guard refuses to vouch for them.
 *
 * The bodies carry one plain sentence from src/ui/copy.ts and nothing else: no role name, no
 * route path, no flag, no secret. Site scoping is a second step, not this one — an endpoint that
 * takes an object or site id checks that id against the caller's memberships where it loads it
 * (`requireSiteAccess` in src/auth/core.ts), so another site's id is a uniform not-found.
 */
import { apiOutcome, endpointRow, type ApiOutcome } from "@/auth/access";
import { getCaller, type ResolvedCaller } from "@/auth/caller";
import { apiAccess as copy } from "@/ui/copy";

const noStore = { "cache-control": "no-store" };

/** The caller a session route is allowed to run for: signed in, active, and holding a role. */
export type StaffCaller = Extract<ResolvedCaller, { kind: "STAFF" }>;

export type ApiGuard =
  | { ok: true; caller: StaffCaller }
  | { ok: false; response: Response };

/** The JSON refusal for an outcome, in the same `{ ok: false, error }` shape every route uses. */
export function denial(outcome: Exclude<ApiOutcome, "ALLOW">): Response {
  const status = outcome === "UNAUTHENTICATED" ? 401 : 403;
  const error = outcome === "UNAUTHENTICATED" ? copy.signIn : copy.notYourRole;
  return Response.json({ ok: false, error }, { status, headers: noStore });
}

/**
 * Guards one API route. `path` is the route's key in the access table — the routes name it
 * through the `API` constants, so no `/api/...` literal is written on a screen's file.
 */
export async function requireApiSession(path: string): Promise<ApiGuard> {
  const row = endpointRow(path);
  /*
   * Only a session route may be guarded by a session. A route whose row says cron secret, queue
   * callback or Auth.js is refused here even for a director: those keep their own auth, and a
   * session must never become a second way in. A path with no row at all lands here too, so a
   * route that was never added to the table is closed rather than open.
   */
  if (row?.auth.kind !== "session") return { ok: false, response: denial("NOT_A_SESSION_ROUTE") };
  const caller = await getCaller();
  const outcome = apiOutcome(caller, path);
  // `ALLOW` on a session row means the caller holds one of its roles, so they are STAFF; the
  // check is written out because the type cannot know it.
  if (outcome === "ALLOW" && caller.kind === "STAFF") return { ok: true, caller };
  return { ok: false, response: denial(outcome === "ALLOW" ? "FORBIDDEN" : outcome) };
}
