import { DEMO_ACCOUNTS, type DemoAccountIcon, type DemoRole } from "@/auth/demo-accounts";
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
 * The demo accounts this deployment may offer, read from the environment server-side at render
 * time (/login is `force-dynamic`, so this runs per request and never gets baked into a build).
 *
 * Three rules, and the tests in login.test.ts hold each of them:
 *  - both switches, or nothing: demo controls on AND synthetic data (ADR-014, ADR-015);
 *  - only the three `DEMO_*_PASSWORD` values named by `DEMO_ACCOUNTS` are ever read — the lookup
 *    is by that list, so no other variable can reach the page even if one were named here;
 *  - an account whose password is unset is skipped, because a card that cannot sign anyone in
 *    is worse than no card.
 */
export function visibleDemoLogins(
  env: Record<string, string | undefined> = process.env,
): DemoLogin[] {
  if (!showDemoLogins(env)) return [];
  return DEMO_ACCOUNTS.flatMap((account) => {
    const password = env[account.passwordEnv];
    return password
      ? [{ role: account.role, email: account.email, password, icon: account.icon }]
      : [];
  });
}
