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
 * is keyboard-operable with no client JavaScript. Hidden below 768 px, where the hamburger
 * drawer carries identity instead.
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
