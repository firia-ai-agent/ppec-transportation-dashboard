/**
 * The session half of the /map-preview guard. The policy it applies is in
 * src/domain/access/map-view.ts.
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

/**
 * The viewer for this request, or ANONYMOUS.
 *
 * The browser-test role is checked first and short-circuits the database, because the
 * Playwright run has no database at all. {@link demoSessionRole} is what keeps that safe: it
 * returns null on anything with `VERCEL_ENV` set, which is every deployment.
 */
export async function mapPreviewViewer(
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
