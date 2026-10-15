import { DEMO_ACCOUNTS, DEMO_SHARED_PASSWORD, type DemoAccountIcon, type DemoRole } from "@/auth/demo-accounts";
import { showDemoLogins } from "@/lib/env";

/**
 * One demo account, as far as the sign-in page is concerned: who it is, and the two values
 * that go in the two fields. Nothing else from the environment travels with it — no env name,
 * no flag, no id.
 */
export type DemoLogin = {
  role: DemoRole;
  email: string;
  password: string;
  icon: DemoAccountIcon;
};

/**
 * The demo accounts this deployment may offer: the three in `DEMO_ACCOUNTS`, each with the one
 * shared password (`DEMO_SHARED_PASSWORD`, founder decision, DECISION-LEDGER row 59), or none
 * at all. Both switches, or nothing: the demo controls on AND synthetic data (ADR-014,
 * ADR-015), asked as one question of src/lib/env.ts. The tests in login.test.ts hold that.
 *
 * Nothing is read from the environment here any more. Row 59 replaced the three
 * `DEMO_*_PASSWORD` env vars with one value that lives in config and is printed on screen on
 * purpose, so there is no secret to fetch and no card that can appear without a password —
 * either the flags are on and all three are offered, or the page is the plain form. The `env`
 * argument is still the whole environment, because the flags are read from it.
 */
export function visibleDemoLogins(
  env: Record<string, string | undefined> = process.env,
): DemoLogin[] {
  if (!showDemoLogins(env)) return [];
  return DEMO_ACCOUNTS.map((account) => ({
    role: account.role,
    email: account.email,
    password: DEMO_SHARED_PASSWORD,
    icon: account.icon,
  }));
}
