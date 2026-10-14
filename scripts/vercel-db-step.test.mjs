import { expect, it } from "vitest";
import { decideMigrate, scrub } from "./vercel-db-step.mjs";

it("migrates only on production + MIGRATE_PROD_ON_BUILD=1 + ref main (single DB, DECISION-LEDGER #43)", () => {
  expect(decideMigrate({ VERCEL_ENV: "production", MIGRATE_PROD_ON_BUILD: "1", VERCEL_GIT_COMMIT_REF: "main" }).run).toBe(true);
  // every other combination skips
  expect(decideMigrate({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "production", MIGRATE_PROD_ON_BUILD: "1", VERCEL_GIT_COMMIT_REF: "team/x" }).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "production", MIGRATE_PROD_ON_BUILD: "0", VERCEL_GIT_COMMIT_REF: "main" }).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "production", MIGRATE_PROD_ON_BUILD: "1" }).run).toBe(false);
  expect(decideMigrate({}).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "development" }).run).toBe(false);
});

it("never migrates on a preview, whatever else is set, and says why", () => {
  const reason = "preview: never migrates the shared DB (single-DB directive, DECISION-LEDGER #43)";
  for (const env of [
    { VERCEL_ENV: "preview" },
    { VERCEL_ENV: "preview", MIGRATE_PROD_ON_BUILD: "1" },
    { VERCEL_ENV: "preview", MIGRATE_PROD_ON_BUILD: "1", VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-x.neon.tech/db" },
  ]) {
    expect(decideMigrate(env)).toEqual({ run: false, reason });
  }
});

it("scrub removes URLs and credentials from error text", () => {
  const url = "postgresql://synuser:SynPassNotReal1@ep-abc-1.us-east-1.aws.neon.tech/neondb?sslmode=require";
  const out = scrub(`connect failed for ${url} and postgres://other:pw@host/db`, { DATABASE_URL_UNPOOLED: url });
  for (const f of ["synuser", "SynPassNotReal1", "://", "@", "neon.tech", "pw@"]) expect(out).not.toContain(f);
});
