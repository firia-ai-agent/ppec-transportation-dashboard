import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { getMemberships } from "@/auth/core";
import { getExec } from "@/auth/exec";

export const dynamic = "force-dynamic";

// Minimal protected page: proves the session works and roles come from ops.site_membership.
export default async function WhoAmI() {
  const session = await auth();
  const uid = session?.user?.id;
  if (!uid) redirect("/login");
  const memberships = await getMemberships(getExec(), uid);
  return (
    <main style={{ padding: 24 }}>
      <h1>Signed in</h1>
      <p>{session?.user?.name}</p>
      <ul>{memberships.map((m) => <li key={m.siteId}>{m.role} at site {m.siteId}</li>)}</ul>
      <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
