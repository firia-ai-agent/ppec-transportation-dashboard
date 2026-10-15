import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { login as copy } from "@/ui/copy";
import { DemoLogins } from "./DemoLogins";
import { visibleDemoLogins } from "./demo-logins";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

const ERROR_ID = "login-error";

async function doLogin(formData: FormData) {
  "use server";
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      /*
       * The entry route, not the board: it reads the new session and sends each role to its own
       * first page (src/auth/access.ts). A front-desk sign-in used to land on /today, which is a
       * console page their role does not open — the right answer for them is the ramp check, and
       * one redirect through "/" is what keeps that answer in one place.
       */
      redirectTo: "/",
    });
  } catch (e) {
    if (e instanceof AuthError) redirect("/login?error=1");
    throw e;
  }
}

/**
 * Staff sign in. §9: visible labels (never placeholder-only), and the error is text next to
 * the fields, wired with aria-describedby. The message never says which half was wrong.
 *
 * Under the button, on a demo deployment, the three synthetic accounts as cards (founder
 * decision, DECISION-LEDGER row 57). The passwords are read here, server-side, per request —
 * `visibleDemoLogins` reads only the three env vars the shared demo-accounts config names, and
 * returns an empty list wherever the demo flags are off, which is what makes the cards vanish.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const described = error ? ERROR_ID : undefined;
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.heading}>{copy.heading}</h1>
        <p className={styles.intro}>{copy.intro}</p>
        {error ? (
          <p id={ERROR_ID} role="alert" className={styles.error}>
            {copy.error}
          </p>
        ) : null}
        <form action={doLogin} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">
              {copy.emailLabel}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className={styles.input}
              autoComplete="username"
              aria-describedby={described}
              aria-invalid={error ? true : undefined}
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">
              {copy.passwordLabel}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className={styles.input}
              autoComplete="current-password"
              aria-describedby={described}
              aria-invalid={error ? true : undefined}
              required
            />
          </div>
          <button type="submit" className={styles.submit}>
            {copy.submit}
          </button>
          {/* Inside the form, so a card can reach the fields through its own button.form. */}
          <DemoLogins accounts={visibleDemoLogins()} />
        </form>
      </div>
    </main>
  );
}
