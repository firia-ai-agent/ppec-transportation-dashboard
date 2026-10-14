// Usage: APP_DATA_CLASS=SYNTHETIC pnpm seed:demo-users [--apply] [--reset-passwords]
// Idempotent: existing users keep their passwords unless --reset-passwords; disabled users stay disabled.
// Default is a dry run. Reads DATABASE_URL and DEMO_*_PASSWORD from the environment; never prints them.
import { getExec } from "../src/auth/exec";
import { seedDemoUsers } from "../src/auth/seed";

const apply = process.argv.includes("--apply");
seedDemoUsers(apply ? getExec() : { query: async () => ({ rows: [] }) }, process.env, { dryRun: !apply, resetPasswords: process.argv.includes("--reset-passwords") })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch((e: Error) => { console.error(`seed refused: ${e.message}`); process.exit(1); });
