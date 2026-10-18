import type { ReactNode } from "react";
import type { ResolvedCaller } from "@/auth/caller";
import { AppShell } from "./AppShell";
import { fill, identity, roleNames } from "./copy";
import { accountLines, initialsOf } from "./display-name";
import type { RailAccount } from "./NavRail";

/** The account page, which is where both identity entry points go (src/auth/access.ts). */
const ACCOUNT_PATH = "/whoami";

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
 *
 * The name is the person's, not the database row's: the helpers in src/ui/display-name.ts drop
 * the synthetic `SYN` prefix and the role and shorten what is left to "Dana M." (Vera's review,
 * 2026-10-17; the founder's mockups). Applied here, the one place a caller becomes what the
 * shell renders, so the rail's account block, the phone's avatar and /whoami cannot disagree
 * about who is signed in — and `accountLines` is the one that decides a session whose whole
 * name *is* a role says that role once rather than twice.
 */
export function ConsoleShell({
  caller,
  title,
  pageOwnsMain,
  children,
}: {
  caller: ResolvedCaller;
  /**
   * Passed through to {@link AppShell}: the page header bar's title, for the one screen whose
   * path has no row in the access table to read one from — the refusal (src/ui/RefusedPage.tsx).
   */
  title?: string;
  /** Passed through to {@link AppShell}: the screen inside already has a `main` landmark. */
  pageOwnsMain?: boolean;
  children: ReactNode;
}) {
  const role = caller.kind === "STAFF" ? caller.role : null;
  const lines = accountLines(caller.displayName, role ? roleNames[role].one : null);
  const account: RailAccount | null = lines.name
    ? {
        ...lines,
        initials: initialsOf(lines.name),
        label: lines.role
          ? fill(identity.account, { name: lines.name, role: lines.role })
          : fill(identity.accountRoleOnly, { role: lines.name }),
        href: ACCOUNT_PATH,
      }
    : null;
  return (
    <AppShell account={account} role={role} title={title} pageOwnsMain={pageOwnsMain}>
      {children}
    </AppShell>
  );
}
