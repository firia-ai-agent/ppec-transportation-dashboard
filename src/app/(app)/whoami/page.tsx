import { requirePage } from "@/auth/page-guard";
import { roleNames, whoami } from "@/ui/copy";
import { shortName } from "@/ui/display-name";
import { SignOutButton } from "@/ui/SignOutButton";
import styles from "./whoami.module.css";

export const dynamic = "force-dynamic";

/**
 * The account page: who you are signed in as, and the way to stop being signed in as them.
 *
 * **Inside the frame**, which is the change. It was a route of its own outside src/app/(app),
 * so it rendered a bare padded block with no header, no menu and no way back
 * but the browser's Back button — the same gap the founder's walk found on Plan routes, the
 * live map and the ramp iPad. It is in the group now, so the shell above it is the one every
 * other screen has (src/ui/one-menu.test.ts holds the property for every destination).
 *
 * **One line**: "Dana M. · Director". What it used to say was three things nobody signed in can
 * use — the stored row's name with its synthetic marker and its role in it ("SYN Dana
 * Director"), and a membership list reading "DIRECTOR at site
 * 01900000-0000-7000-8000-00000000000a" — a role *key*, which COPY-GUIDE §2 bars from every
 * screen, and a site UUID, which is an internal id on a page a founder opens in front of a
 * customer. The name comes from the one helper the shell's identity menu and the phone avatar
 * use (src/ui/display-name.ts), so a person is named the same way everywhere, and the role is
 * the plain word `roleNames` already holds.
 *
 * Nothing about anyone else, which is why every staff role may open it: there is no other
 * person's row to reach from here. The guard still runs first — `/whoami` is in the access
 * table and a caller outside its row gets the no-access card and a 403 (forbidden.tsx beside
 * this file) — and the name and the role are the database's answer for this request, never the
 * token's (ADR-004).
 */
export default async function WhoAmI() {
  // The guard already read the session, the active-user row and the memberships, once.
  const caller = await requirePage("/whoami");
  const role = caller.kind === "STAFF" ? roleNames[caller.role].one : null;
  const name = shortName(caller.displayName ?? "");
  /*
   * "Dana M. · Director" — unless the two are the same word, which is the browser-test session:
   * it has no user row behind it, so its whole display name *is* the role's own title
   * (src/auth/caller.ts). "Director · Director" would be the one sentence on this page that
   * says nothing, so the name is said once.
   */
  const line = role && name && name !== role ? `${name}${whoami.separator}${role}` : name || role;
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{whoami.heading}</h1>
      <p className={styles.identity}>{line}</p>
      <SignOutButton />
    </div>
  );
}
