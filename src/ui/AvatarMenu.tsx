import { ChevronDown } from "lucide-react";
import { fill, identity } from "./copy";
import { icon } from "./tokens";
import type { RailAccount } from "./NavRail";
import { SignOutButton } from "./SignOutButton";
import styles from "./AvatarMenu.module.css";

/**
 * §2: one identity location — the avatar menu, top right. Built from <details>/<summary> so it
 * is keyboard-operable with no client JavaScript.
 *
 * **Below 1280**, as of Firia's 7:55 PM ET ruling on 2026-10-17: above it the rail's own account
 * block is the one identity entry point, and the header it sits in is gone. It used to be hidden
 * below 768 instead, where the hamburger drawer carried the name and Sign out; the drawer is
 * gone, so the phone's header carries this, compact — a 44 px pill of initials, with "Signed in
 * as {name}" and Sign out in the panel it opens. The name beside the initials is a desk's
 * luxury: at 390 px the row is full (the stylesheet says why).
 *
 * It renders what it is given and decides nothing: the name is "Dana M." and the initials "DM",
 * both from the one helper (src/ui/display-name.ts), applied once in src/ui/ConsoleShell.tsx —
 * which is why the rail's block, this pill and /whoami cannot name one person three ways.
 */
export function AvatarMenu({ account }: { account: RailAccount }) {
  return (
    <details className={styles.menu}>
      <summary className={styles.summary}>
        <span className={styles.avatar} aria-hidden="true">
          {account.initials}
        </span>
        <span className={styles.name}>{account.name}</span>
        <span className="srOnly">{identity.menuLabel}</span>
        <ChevronDown size={icon.chip} aria-hidden="true" />
      </summary>
      <div className={styles.panel}>
        <p className={styles.signedIn}>{fill(identity.signedInAs, { name: account.name })}</p>
        <SignOutButton />
      </div>
    </details>
  );
}
