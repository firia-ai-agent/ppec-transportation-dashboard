/**
 * The three synthetic demo staff accounts, in one place (ADR-004, synthetic-seed-data-rules).
 *
 * Two surfaces read this list and must never disagree about it: `seedDemoUsers`
 * (src/auth/seed.ts), which creates the users, and /login, which offers them as demo cards once
 * the demo flags are on. Email, role, id and icon live here; the words shown on screen live in
 * src/ui/copy.ts (`demoLogins`), keyed by role.
 *
 * Each stored name is the synthetic marker, a first name, a family name and the role — the form
 * ADR-015 asks a seeded row to carry, so a developer reading `ops.app_user` can tell the three
 * apart. None of that is what a screen shows: src/ui/display-name.ts turns the row into the
 * person ("Dana M."), and the screen says their role in its own words beside it. The family
 * name is there so there is an initial to say; before it, every demo account was a first name
 * and a role, and the console could only ever read "Dana".
 */
export const DEMO_ACCOUNTS = [
  {
    id: "01900000-0000-7000-8000-0000000000d1",
    email: "director@example.com",
    name: "SYN Dana Mercer Director",
    role: "DIRECTOR",
    icon: "shield-check",
  },
  {
    id: "01900000-0000-7000-8000-0000000000c1",
    email: "coordinator@example.com",
    name: "SYN Casey Ruiz Coordinator",
    role: "COORDINATOR",
    icon: "clipboard-list",
  },
  {
    id: "01900000-0000-7000-8000-0000000000f1",
    email: "frontdesk@example.com",
    name: "SYN Frankie Lowell FrontDesk",
    role: "FRONT_DESK",
    icon: "concierge-bell",
  },
] as const;

/**
 * The one password all three demo accounts share — founder decision, DECISION-LEDGER row 59,
 * which supersedes the per-role `DEMO_*_PASSWORD` env vars of row 57.
 *
 * It is deliberately *not* a secret and deliberately not read from the environment: /login
 * prints it next to each demo email, so a visitor can sign in without being handed anything.
 * Keeping it here means the three places that must agree — the words on /login, the seed that
 * hashes it for local/PGlite, and the production migration that hashes it for Neon — read one
 * value. These accounts hold synthetic data only (APP_DATA_CLASS=SYNTHETIC, ADR-015), and the
 * demo cards still need both demo flags on (`showDemoLogins`), so nothing real is reachable
 * with it. Every other secret stays out of the repo, under the usual rules (ARCHITECTURE §5).
 *
 * Changing this value means re-running the seed locally *and* writing a new migration with a
 * fresh bcrypt hash: the production hash is baked into drizzle/0005_demo_shared_password.sql.
 */
export const DEMO_SHARED_PASSWORD = "PPEC";

export type DemoAccount = (typeof DEMO_ACCOUNTS)[number];

/** DIRECTOR | COORDINATOR | FRONT_DESK — the `site_membership` roles these accounts hold. */
export type DemoRole = DemoAccount["role"];

/** Lucide icon names (§2: one set, 1.75 stroke). Mapped to components by the card. */
export type DemoAccountIcon = DemoAccount["icon"];

/** The three emails the shared password belongs to. Used by the migration test, so keep it exact. */
export const DEMO_EMAILS: readonly string[] = DEMO_ACCOUNTS.map((a) => a.email);
