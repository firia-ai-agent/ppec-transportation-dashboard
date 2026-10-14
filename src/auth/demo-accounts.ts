/**
 * The three synthetic demo staff accounts, in one place (ADR-004, synthetic-seed-data-rules).
 *
 * Two surfaces read this list and must never disagree about it: `seedDemoUsers`
 * (src/auth/seed.ts), which creates the users, and /login, which offers them as demo cards once
 * the demo flags are on. Email, role, id and the name of the env var holding the password live
 * here; the words shown on screen live in src/ui/copy.ts (`demoLogins`), keyed by role.
 *
 * `passwordEnv` is a *name*, never a value: nothing in this file, and nothing derived from it,
 * may carry a password or print an env name to a screen. The value is read server-side, at
 * render time, by the caller.
 */
export const DEMO_ACCOUNTS = [
  {
    id: "01900000-0000-7000-8000-0000000000d1",
    email: "director@example.com",
    name: "SYN Dana Director",
    role: "DIRECTOR",
    passwordEnv: "DEMO_DIRECTOR_PASSWORD",
    icon: "shield-check",
  },
  {
    id: "01900000-0000-7000-8000-0000000000c1",
    email: "coordinator@example.com",
    name: "SYN Casey Coordinator",
    role: "COORDINATOR",
    passwordEnv: "DEMO_COORDINATOR_PASSWORD",
    icon: "clipboard-list",
  },
  {
    id: "01900000-0000-7000-8000-0000000000f1",
    email: "frontdesk@example.com",
    name: "SYN Frankie FrontDesk",
    role: "FRONT_DESK",
    passwordEnv: "DEMO_FRONT_DESK_PASSWORD",
    icon: "concierge-bell",
  },
] as const;

export type DemoAccount = (typeof DEMO_ACCOUNTS)[number];

/** DIRECTOR | COORDINATOR | FRONT_DESK — the `site_membership` roles these accounts hold. */
export type DemoRole = DemoAccount["role"];

/** Lucide icon names (§2: one set, 1.75 stroke). Mapped to components by the card. */
export type DemoAccountIcon = DemoAccount["icon"];

/** The only env names /login is allowed to read. Used by the leak test, so keep it exact. */
export const DEMO_PASSWORD_ENV_NAMES: readonly string[] = DEMO_ACCOUNTS.map((a) => a.passwordEnv);
