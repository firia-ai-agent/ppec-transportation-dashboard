import { requirePage } from "@/auth/page-guard";
import { SignOutButton } from "@/ui/SignOutButton";
import { fill, whoami } from "@/ui/copy";

export const dynamic = "force-dynamic";

/**
 * Minimal protected page: the token's uid must still be an active user in the DB, and the name
 * and roles come from the DB, never from the token (ADR-004). `requirePage` holds that check for
 * every page now, with this route's row in src/auth/access.ts deciding the roles — signed out is
 * a redirect to sign-in, a signed-in person whose role does not include the page gets a 403.
 *
 * It shows the caller their *own* name and their *own* memberships and nothing about anyone
 * else, which is why every role may open it: there is no other person's row to reach from here.
 */
export default async function WhoAmI() {
  // The guard already read the session, the active-user row and the memberships, once.
  const caller = await requirePage("/whoami");
  return (
    <main style={{ padding: 24 }}>
      <h1>{whoami.heading}</h1>
      <p>{caller.displayName}</p>
      <ul>
        {caller.memberships.map((m) => (
          <li key={m.siteId}>{fill(whoami.membership, { role: m.role, siteId: m.siteId })}</li>
        ))}
      </ul>
      <SignOutButton />
    </main>
  );
}
