import { expect, it } from "vitest";
import { healthPayload } from "./health";

it("reports commit and data class, no secrets", () => {
  const p = healthPayload({ VERCEL_GIT_COMMIT_SHA: "abc123", APP_DATA_CLASS: "SYNTHETIC", AUTH_SECRET: "x" });
  expect(p.commit).toBe("abc123");
  expect(p.dataClass).toBe("SYNTHETIC");
  expect(JSON.stringify(p)).not.toContain("AUTH_SECRET");
});

it("flags the preview read-only DB session (DECISION-LEDGER #43)", () => {
  expect(healthPayload({ VERCEL_ENV: "preview" }).dbReadOnly).toBe(true);
  expect(healthPayload({ VERCEL_ENV: "production" }).dbReadOnly).toBe(false);
  expect(healthPayload({}).dbReadOnly).toBe(false);
});

it("dbEndpoint exposes only the ep- id, never credentials, host or query", async () => {
  const user = "synuser_q7"; const password = "SynPassw0rdNotReal9x";
  const env = {
    DATABASE_URL_UNPOOLED: `postgresql://${user}:${password}@ep-abc-123.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`,
    DATABASE_URL: `postgres://${user}:${password}@ep-abc-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
  };
  const p = healthPayload(env);
  expect(p.dbEndpoint).toBe("ep-abc-123");
  // Same check on the real route response body.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { GET } = await import("@/app/api/health/route");
    const body = await GET().text();
    expect(JSON.parse(body).dbEndpoint).toBe("ep-abc-123");
    for (const frag of [user, password, "@", "://", "postgres", "neon.tech", "sslmode", "neondb"]) expect(body).not.toContain(frag);
  } finally { process.env = saved; }
});

it("dbEndpoint falls back to DATABASE_URL (pooler suffix stripped) and is null when absent or not Neon", () => {
  expect(healthPayload({ DATABASE_URL: "postgres://u:p@ep-x-9-pooler.c-2.us-east-1.aws.neon.tech/db" }).dbEndpoint).toBe("ep-x-9");
  expect(healthPayload({}).dbEndpoint).toBeNull();
  expect(healthPayload({ DATABASE_URL: "postgres://u:p@localhost:5432/db" }).dbEndpoint).toBeNull();
  expect(healthPayload({ DATABASE_URL: "not a url" }).dbEndpoint).toBeNull();
});
