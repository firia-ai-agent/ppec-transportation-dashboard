import { ChevronDown } from "lucide-react";
import { fill, identity } from "./copy";
import { icon } from "./tokens";
import { SignOutButton } from "./SignOutButton";
import styles from "./AvatarMenu.module.css";

/** Initials for the avatar. Synthetic names only on staff screens (COPY-GUIDE §3). */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * §2: one identity location — the avatar menu, top right. Built from <details>/<summary> so it
 * is keyboard-operable with no client JavaScript.
 *
 * At every width, as of Firia's 3:08 PM ET ruling on 2026-10-17. It used to be hidden below 768
 * and the hamburger drawer carried the name and Sign out; the drawer is gone, so the phone's
 * header carries this instead, compact — a 44 px pill of initials, with "Signed in as {name}"
 * and Sign out in the panel it opens. The name beside the initials is a desk's luxury: at 390
 * px the row has the demo readout and its Start in it already (the stylesheet says why).
 *
 * The name it is given is the person's, not the row's: "Dana", not "SYN Dana Director"
 * (src/ui/display-name.ts, applied once in src/ui/ConsoleShell.tsx).
 */
export function AvatarMenu({ displayName }: { displayName: string }) {
  return (
    <details className={styles.menu}>
      <summary className={styles.summary}>
        <span className={styles.avatar} aria-hidden="true">
          {initials(displayName)}
        </span>
        <span className={styles.name}>{displayName}</span>
        <span className="srOnly">{identity.menuLabel}</span>
        <ChevronDown size={icon.chip} aria-hidden="true" />
      </summary>
      <div className={styles.panel}>
        <p className={styles.signedIn}>{fill(identity.signedInAs, { name: displayName })}</p>
        <SignOutButton />
      </div>
    </details>
  );
}
