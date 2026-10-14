import { defineConfig } from "drizzle-kit";

// Migrations use the UNPOOLED URL (ADR-009). `push` is for disposable local DBs only (database-lifecycle).
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? "postgres://localhost/ppec_local" },
  schemaFilter: ["ops", "identity", "public"],
  strict: true,
  verbose: true,
});
