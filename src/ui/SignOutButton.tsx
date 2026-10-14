import { signOut } from "@/auth";
import { identity } from "./copy";
import styles from "./SignOutButton.module.css";

/**
 * The one sign-out control, reused by the avatar menu (≥768) and the hamburger drawer (<768)
 * so there is still exactly one identity location per width (§2). Uses the existing
 * `signOut` from @/auth; the session lands back on /login.
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
