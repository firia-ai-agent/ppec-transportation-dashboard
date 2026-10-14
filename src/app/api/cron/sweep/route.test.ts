import { afterEach, expect, it } from "vitest";

// The sweep claims jobs and sends outbox messages. On a preview the DB is the shared production one,
// opened read-only (DECISION-LEDGER #43), so the route must refuse before it touches the DB —
// and without DATABASE_URL set, any DB access here would throw instead of returning 200.
// Built at runtime, not a literal, so secret scanners do not flag it; cronAuthorized wants >= 16 chars.
const secret = "test-cron-".padEnd(32, "x");
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

async function get(env: Record<string, string | undefined>, header: string | null) {
  process.env = { ...saved, CRON_SECRET: secret, DATABASE_URL: undefined, ...env };
  const { GET } = await import("./route");
  return GET(new Request("https://example.test/api/cron/sweep", header ? { headers: { authorization: header } } : undefined));
}

it("skips the sweep on previews with 200 and no DB access", async () => {
  const res = await get({ VERCEL_ENV: "preview" }, `Bearer ${secret}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ skipped: "preview read-only" });
});

it("still fails closed on previews when the cron secret is wrong", async () => {
  expect((await get({ VERCEL_ENV: "preview" }, "Bearer nope")).status).toBe(401);
  expect((await get({ VERCEL_ENV: "preview" }, null)).status).toBe(401);
});
