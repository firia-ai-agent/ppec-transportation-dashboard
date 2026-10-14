/**
 * The session half of the guard on every signed-in surface: the two developer preview routes
 * — /map-preview and /ramp-preview — and the console shell behind src/app/(app). The policy
 * each one applies is in src/domain/access/map-view.ts.
 *
 * Same shape as every other protected surface (src/app/whoami/page.tsx,
 * src/app/(app)/layout.tsx): the token carries only a user id (ADR-004), that id must still be
 * an active user in the database, and the roles are read from the database per request — never
 * from the token, so disabling a user takes effect on their next request.
 */
import { auth } from "@/auth";
import { getActiveUser, getMemberships } from "@/auth/core";
import { getExec } from "@/auth/exec";
import { demoSessionRole, mapViewerFor, type MapViewer } from "@/domain/access/map-view";
import { demoLogins } from "@/ui/copy";

/**
 * The viewer for this request, or ANONYMOUS. Both preview routes share it, so there is one
 * answer to "who is asking" and no chance of the two drifting apart.
 *
 * The browser-test role is checked first and short-circuits the database, because the
 * Playwright run has no database at all. {@link demoSessionRole} is what keeps that safe: it
 * returns null on anything with `VERCEL_ENV` set, which is every deployment.
 */
export async function previewViewer(
  env: Record<string, string | undefined> = process.env,
): Promise<MapViewer> {
  const demoRole = demoSessionRole(env);
  if (demoRole) return demoRole;

  const session = await auth();
  const db = getExec();
  const user = await getActiveUser(db, session?.user?.id);
  if (!user) return "ANONYMOUS";
  return mapViewerFor((await getMemberships(db, user.id)).map((m) => m.role));
}

/**
 * Who the signed-in console is rendering for: the display name the shell puts in the header,
 * or null for "send them to /login".
 *
 * Same two steps as {@link previewViewer} and in the same order. The browser-test session is a
 * role and nothing else — there is no user row behind it — so the name it renders is that
 * role's own words from COPY-GUIDE, never an invented person. Every gate on
 * {@link demoSessionRole} still applies, including the one that refuses outright whenever
 * `VERCEL_ENV` is set, so no deployment can reach this branch.
 */
export async function consoleIdentity(
  env: Record<string, string | undefined> = process.env,
): Promise<{ displayName: string } | null> {
  const demoRole = demoSessionRole(env);
  if (demoRole) return { displayName: demoLogins.roles[demoRole].title };

  const session = await auth();
  // No token, no database round trip: an anonymous visitor goes straight to /login.
  const userId = session?.user?.id;
  if (!userId) return null;
  return await getActiveUser(getExec(), userId);
}
