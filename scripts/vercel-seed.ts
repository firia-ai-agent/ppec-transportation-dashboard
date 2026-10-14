// Vercel build step 2 (after vercel-db-step.mjs): seed the synthetic demo users on PREVIEW builds only.
// Idempotent; never resets an existing password (no --reset-passwords here). Never prints a URL or password.
// Production: never seeded from the build (demo reset/seed buttons are B-15, DECISION-LEDGER row 17).
import { withClientExec } from "../src/auth/client-exec";
import { seedDemoUsers, DEMO_USERS } from "../src/auth/seed";

export function decideSeed(env: Record<string, string | undefined>): { run: boolean; reason: string } {
  if (env.VERCEL_ENV !== "preview") return { run: false, reason: `not a preview build (VERCEL_ENV=${env.VERCEL_ENV ?? "unset"})` };
  if (env.APP_DATA_CLASS !== "SYNTHETIC") return { run: false, reason: "APP_DATA_CLASS is not SYNTHETIC" };
  const missing = DEMO_USERS.filter((u) => !env[u.env]).map((u) => u.env);
  if (missing.length) return { run: false, reason: `missing env: ${missing.join(", ")}` };
  if (!env.DATABASE_URL_UNPOOLED) return { run: false, reason: "DATABASE_URL_UNPOOLED is not set" };
  return { run: true, reason: "preview build" };
}

async function main() {
  const d = decideSeed(process.env);
  console.log(`[db-step] seed demo users: ${d.run ? "RUN" : "SKIP"} (${d.reason})`);
  if (!d.run) return;
  const r = await withClientExec(process.env.DATABASE_URL_UNPOOLED!, (db) => seedDemoUsers(db, process.env, { dryRun: false, resetPasswords: false }));
  console.log(`[db-step] seed demo users: OK (${"plan" in r ? r.plan.users.length : DEMO_USERS.length} users, passwords unchanged for existing users)`);
}

if (process.argv[1]?.endsWith("vercel-seed.ts")) {
  main().catch((e: Error) => { console.error(`[db-step] seed demo users: FAILED: ${String(e?.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")}`); process.exit(1); });
}
