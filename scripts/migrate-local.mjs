// Apply every drizzle migration to a **throwaway local Postgres**, with the same migrator the
// Vercel build step uses (drizzle-orm/node-postgres, migrationsFolder "drizzle").
//
// It exists so the DB-backed suites can be run against the real engine on a developer's box:
//   TEST_DATABASE_URL=postgres://…@127.0.0.1:55432/… pnpm db:migrate:local && pnpm test:db
//
// It refuses any host that is not loopback. PPEC has exactly one real database (Neon `main`,
// shared by production and previews, DECISION-LEDGER #43) and nothing here may ever point at it:
// the check is in code because a README line is not a guard.
import { readFileSync } from "node:fs";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("[migrate-local] set TEST_DATABASE_URL to a throwaway local Postgres");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
  console.error(`[migrate-local] refused: ${host} is not loopback. This command is for a throwaway local database only.`);
  process.exit(1);
}

const { Client } = await import("pg");
const { drizzle } = await import("drizzle-orm/node-postgres");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");

const client = new Client({ connectionString: url });
await client.connect();
try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  console.log(`[migrate-local] OK: ${journal.entries.length} migrations applied to ${host}`);
} finally {
  await client.end();
}
