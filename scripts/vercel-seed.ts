// Vercel build step 2 (after vercel-db-step.mjs): it no longer seeds anything.
// PPEC has exactly ONE database (Neon `main`) and previews get production's DATABASE_URL
// (single-DB directive, DECISION-LEDGER #43), so no build — preview or production — writes to it.
// Demo users are seeded manually instead: `pnpm seed:demo-users --apply` (refuses when VERCEL_ENV=preview).
// Kept in `pnpm vercel-build` so the build log records the decision; it never prints a URL or password.

/** Pure decision, unit-tested. Always false: the build never seeds the one shared DB. */
export function decideSeed(env: Record<string, string | undefined>): { run: boolean; reason: string } {
  if (env.VERCEL_ENV === "preview") {
    return { run: false, reason: "preview: never writes to the shared DB (single-DB directive, DECISION-LEDGER #43)" };
  }
  return {
    run: false,
    reason: `build never seeds the shared DB; seeding is manual only via pnpm seed:demo-users (single-DB directive, DECISION-LEDGER #43) (VERCEL_ENV=${env.VERCEL_ENV ?? "unset"})`,
  };
}

function main() {
  const d = decideSeed(process.env);
  console.log(`[db-step] seed demo users: ${d.run ? "RUN" : "SKIP"} (${d.reason})`);
}

if (process.argv[1]?.endsWith("vercel-seed.ts")) main();
