import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getActiveUser } from "@/auth/core";
import { getExec } from "@/auth/exec";
import { AppShell } from "@/ui/AppShell";

export const dynamic = "force-dynamic";

/**
 * The signed-in console. Auth is checked exactly as src/app/whoami does: the token's uid must
 * still be an active user in the DB, and the display name comes from the DB, not the token.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  // No token, no database round trip: an anonymous visitor goes straight to /login.
  const userId = session?.user?.id;
  if (!userId) redirect("/login");
  const user = await getActiveUser(getExec(), userId);
  if (!user) redirect("/login");
  return <AppShell displayName={user.displayName}>{children}</AppShell>;
}
