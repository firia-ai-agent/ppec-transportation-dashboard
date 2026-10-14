// Vercel build step: apply drizzle migrations from inside the Vercel build, so no connection string leaves Vercel.
// Runs as part of `pnpm vercel-build` (package.json). It never prints a URL, host or credential.
//   VERCEL_ENV=preview     → migrate the preview's own Neon branch (DATABASE_URL_UNPOOLED). Missing URL fails the build.
//   VERCEL_ENV=production  → OFF by default. Runs only if MIGRATE_PROD_ON_BUILD=1 AND the commit ref is `main`
//                            (prod-release-gate: prod migrates only from main, with an explicit flag).
//   anything else          → skip (local `next build`, CI).
import { pathToFileURL } from "node:url";

/** Pure decision, unit-tested. */
export function decideMigrate(env) {
  const target = env.VERCEL_ENV;
  if (target === "preview") return { run: true, reason: "preview build" };
  if (target === "production") {
    if (env.MIGRATE_PROD_ON_BUILD !== "1") return { run: false, reason: "production: MIGRATE_PROD_ON_BUILD is not 1 (off by default)" };
    if (env.VERCEL_GIT_COMMIT_REF !== "main") return { run: false, reason: "production: refusing, commit ref is not main" };
    return { run: true, reason: "production from main with MIGRATE_PROD_ON_BUILD=1" };
  }
  return { run: false, reason: `not a Vercel preview/production build (VERCEL_ENV=${target ?? "unset"})` };
}

/** Remove anything URL-like and the raw secret values from a message before it is logged. */
export function scrub(msg, env) {
  let s = String(msg);
  for (const v of [env.DATABASE_URL_UNPOOLED, env.DATABASE_URL]) if (v) s = s.split(v).join("[redacted-url]");
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]").replace(/\bep-[a-z0-9-]+(?:\.[a-z0-9.-]+)?/gi, (m) => m.split(".")[0]);
  return s;
}

export function endpointId(url) {
  try { const id = new URL(url).hostname.split(".")[0].replace(/-pooler$/, ""); return /^ep-[a-z0-9-]+$/.test(id) ? id : null; } catch { return null; }
}

async function main(env = process.env) {
  const d = decideMigrate(env);
  console.log(`[db-step] migrate: ${d.run ? "RUN" : "SKIP"} (${d.reason})`);
  if (!d.run) return;
  const url = env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set for this environment (Neon integration)");
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    const t0 = Date.now();
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    const n = await client.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations");
    console.log(`[db-step] migrate: OK, ${n.rows[0].n} migrations recorded, endpoint ${endpointId(url) ?? "?"}, ${Date.now() - t0} ms`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    // drizzle wraps the driver error: print the Postgres cause (code + message), scrubbed. Never the URL.
    const c = e?.cause;
    const cause = c ? ` | cause: ${c.code ?? ""} ${scrub(c.message ?? c, process.env)}` : "";
    console.error(`[db-step] migrate: FAILED: ${scrub(String(e?.message ?? e).split("\n")[0], process.env)}${cause}`);
    process.exit(1);
  });
}
