import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getActiveUser, getMemberships } from "@/auth/core";
import { getExec } from "@/auth/exec";
import { SignOutButton } from "@/ui/SignOutButton";
import { fill, whoami } from "@/ui/copy";

export const dynamic = "force-dynamic";

// Minimal protected page: the token's uid must still be an active user in the DB; name and roles come from the DB.
export default async function WhoAmI() {
  const session = await auth();
  const db = getExec();
  const user = await getActiveUser(db, session?.user?.id);
  if (!user) redirect("/login");
  const memberships = await getMemberships(db, user.id);
  return (
    <main style={{ padding: 24 }}>
      <h1>{whoami.heading}</h1>
      <p>{user.displayName}</p>
      <ul>
        {memberships.map((m) => (
          <li key={m.siteId}>{fill(whoami.membership, { role: m.role, siteId: m.siteId })}</li>
        ))}
      </ul>
      <SignOutButton />
    </main>
  );
}
