import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { consoleIdentity } from "@/auth/preview-viewer";
import { AppShell } from "@/ui/AppShell";

export const dynamic = "force-dynamic";

/**
 * The signed-in console. Auth is checked exactly as src/app/whoami does: the token's uid must
 * still be an active user in the DB, and the display name comes from the DB, not the token.
 * `consoleIdentity` holds that check, so the console and the two preview routes read a session
 * the same way — including the browser-test session, which is what lets a Playwright run
 * screenshot this shell without a database and is refused on every deployment.
 *
 * The DEMO bar and the one source-mode chip are **not** here: they come from the root layout
 * (src/app/layout.tsx), which puts them above every route, signed in or not (§7, §7.1,
 * NFR-09). shell.test.ts holds that line.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const identity = await consoleIdentity();
  if (!identity) redirect("/login");
  return <AppShell displayName={identity.displayName}>{children}</AppShell>;
}
