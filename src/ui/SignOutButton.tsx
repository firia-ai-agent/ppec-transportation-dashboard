import { signOut } from "@/auth";
import { identity } from "./copy";
import styles from "./SignOutButton.module.css";

/**
 * The one sign-out control, inside the avatar menu — which is the one identity location, at
 * every width now that the phone's hamburger drawer is gone (§2, Firia 2026-10-17 3:08 PM ET).
 * Uses the existing `signOut` from @/auth; the session lands back on /login.
 */
export function SignOutButton() {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
    >
      <button type="submit" className={styles.button}>
        {identity.signOut}
      </button>
    </form>
  );
}
