// Usage: APP_DATA_CLASS=SYNTHETIC pnpm seed:demo-users [--apply] [--reset-passwords]
// Idempotent: existing users keep their passwords unless --reset-passwords; disabled users stay disabled.
// Default is a dry run. Reads DATABASE_URL_UNPOOLED (or DATABASE_URL) from the environment; never prints it.
// The password is not an env var: all three accounts share DEMO_SHARED_PASSWORD (src/auth/demo-accounts.ts,
// DECISION-LEDGER row 59), which /login prints on each demo card.
// Refuses to write when VERCEL_ENV=preview: previews share the one production DB (single-DB directive, DECISION-LEDGER #43).
import { withClientExec } from "../src/auth/client-exec";
import { seedDemoUsers } from "../src/auth/seed";

const apply = process.argv.includes("--apply");
const opts = { dryRun: !apply, resetPasswords: process.argv.includes("--reset-passwords") };
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
(apply
  ? (url ? withClientExec(url, (db) => seedDemoUsers(db, process.env, opts)) : Promise.reject(new Error("DATABASE_URL_UNPOOLED is not set")))
  : seedDemoUsers({ query: async () => ({ rows: [] }) }, process.env, opts))
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch((e: Error) => { console.error(`seed refused: ${e.message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")}`); process.exit(1); });
