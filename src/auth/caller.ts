/**
 * Who is asking, for every protected surface in the app.
 *
 * One session read, in one place, so a page, a layout and an API route cannot disagree about
 * the same request. The steps are the ones ADR-004 fixes, in this order:
 *  1. the browser-test session (src/domain/access/map-view.ts), which short-circuits the
 *     database because the Playwright run has no database at all, and which is refused outright
 *     whenever `VERCEL_ENV` is set — that is, on every deployment we own;
 *  2. the Auth.js token, which carries only a user id;
 *  3. that id must still be an **active** user in the database (not disabled, not deleted), so
 *     disabling someone takes effect on their next request;
 *  4. their roles, re-read from `ops.site_membership` on every request — never from the token.
 *
 * An active user who holds no membership anywhere is `NO_ROLE`, not `ANONYMOUS`: they are
 * signed in, so sending them to sign-in would only bounce them round the loop. They get the
 * no-access page and a 403 instead.
 */
import { auth } from "@/auth";
import { getActiveUser, getMemberships, type Membership } from "@/auth/core";
import { getExec } from "@/auth/exec";
import { mostCapable, type Caller } from "@/auth/access";
import { demoSessionRole } from "@/domain/access/map-view";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";

export type ResolvedCaller = Caller & {
  /** The name the console puts in its header. Absent for an anonymous caller. */
  displayName?: string;
  /** Every site this user is a member of, for the site-scoping checks. */
  memberships: readonly Membership[];
};

/** The caller for this request. Reads the session once and the database at most twice. */
export async function getCaller(
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedCaller> {
  const demoRole = demoSessionRole(env);
  /*
   * A role and nothing else: no user id, no site, so nothing that writes can accept it, and
   * nothing it reads is scoped to a centre (the day's readiness reads nothing for it at all,
   * src/domain/day/day-facts.ts).
   *
   * The name it renders is the demo staff roster's own, for that role — "SYN Dana Mercer
   * Director", which src/ui/display-name.ts turns into "Dana M." on a screen. It used to be the
   * role's *title*, and that is where "Director · Director" came from: the account page joins a
   * name to a role with a middle dot, and when the name is the role the line says one thing
   * twice. No person is invented here either — this is the same roster `seedDemoUsers` creates
   * the three accounts from (src/auth/demo-accounts.ts), read behind its own interface, so the
   * browser-test session is named exactly as the account it stands in for.
   */
  if (demoRole) {
    const account = DEMO_ACCOUNTS.find((a) => a.role === demoRole);
    return { kind: "STAFF", role: demoRole, displayName: account?.name, memberships: [] };
  }

  const session = await auth();
  const userId = session?.user?.id;
  // No token, no database round trip.
  if (!userId) return { kind: "ANONYMOUS", memberships: [] };

  const db = getExec();
  const user = await getActiveUser(db, userId);
  if (!user) return { kind: "ANONYMOUS", memberships: [] };

  const memberships = await getMemberships(db, user.id);
  const role = mostCapable(memberships.map((m) => m.role));
  if (!role) return { kind: "NO_ROLE", userId: user.id, displayName: user.displayName, memberships };
  return { kind: "STAFF", role, userId: user.id, displayName: user.displayName, memberships };
}
