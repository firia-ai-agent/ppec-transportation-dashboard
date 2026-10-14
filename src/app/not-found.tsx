import Link from "next/link";
import { auth } from "@/auth";
import { notFound as copy } from "@/ui/copy";
import styles from "./not-found.module.css";

export const dynamic = "force-dynamic";

/**
 * A URL that matches no page, on the sign-in shell.
 *
 * One line, and exactly one way out: the board for a visitor who has a session, sign-in for one
 * who does not. Never both — a dead end is not the place to make someone choose, and offering
 * "Today" to a signed-out visitor would only bounce them through the sign-in redirect. The
 * session is read the way every other surface reads it, with `auth()`; the heading is the <h1>,
 * so the page has one and the link is the only thing to tab to.
 */
export default async function NotFound() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.heading}>{copy.heading}</h1>
        <Link className={styles.link} href={signedIn ? "/today" : "/login"}>
          {signedIn ? copy.today : copy.signIn}
        </Link>
      </div>
    </main>
  );
}
