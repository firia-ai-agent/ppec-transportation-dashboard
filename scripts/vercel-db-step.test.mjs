import { expect, it } from "vitest";
import { decideMigrate, scrub } from "./vercel-db-step.mjs";

it("migrates on preview only by default; prod needs the flag AND main", () => {
  expect(decideMigrate({ VERCEL_ENV: "preview" }).run).toBe(true);
  expect(decideMigrate({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "production", MIGRATE_PROD_ON_BUILD: "1", VERCEL_GIT_COMMIT_REF: "team/x" }).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "production", MIGRATE_PROD_ON_BUILD: "1", VERCEL_GIT_COMMIT_REF: "main" }).run).toBe(true);
  expect(decideMigrate({}).run).toBe(false);
  expect(decideMigrate({ VERCEL_ENV: "development" }).run).toBe(false);
});

it("scrub removes URLs and credentials from error text", () => {
  const url = "postgresql://synuser:SynPassNotReal1@ep-abc-1.us-east-1.aws.neon.tech/neondb?sslmode=require";
  const out = scrub(`connect failed for ${url} and postgres://other:pw@host/db`, { DATABASE_URL_UNPOOLED: url });
  for (const f of ["synuser", "SynPassNotReal1", "://", "@", "neon.tech", "pw@"]) expect(out).not.toContain(f);
});
