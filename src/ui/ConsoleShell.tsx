import type { ReactNode } from "react";
import type { ResolvedCaller } from "@/auth/caller";
import { AppShell } from "./AppShell";

/**
 * The console shell as a layout mounts it: one place that turns the caller its guard just
 * returned into the two things the shell needs — the name in the identity menu, and the role the
 * nav is filtered by.
 *
 * Four layouts mount it (src/app/(app)/layout.tsx and one each in the three route folders that
 * sit outside that group), and this file is why none of them holds its own opinion about either.
 * A second mapping of caller → nav role is exactly how a menu ends up different on one screen,
 * which is the bug the founder found on 2026-10-17: the three screens outside the group had no
 * menu at all, and the way to be sure they now have *the same* one is for there to be a single
 * expression producing it.
 *
 * It takes the caller rather than calling the guard, so each layout still names its own row in
 * the access table in its own file (`requirePage(LAYOUT.…)`) and src/auth/access.test.ts can
 * read it there.
 */
export function ConsoleShell({
  caller,
  pageOwnsMain,
  children,
}: {
  caller: ResolvedCaller;
  /** Passed through to {@link AppShell}: the screen inside already has a `main` landmark. */
  pageOwnsMain?: boolean;
  children: ReactNode;
}) {
  return (
    <AppShell
      displayName={caller.displayName ?? ""}
      role={caller.kind === "STAFF" ? caller.role : null}
      pageOwnsMain={pageOwnsMain}
    >
      {children}
    </AppShell>
  );
}
