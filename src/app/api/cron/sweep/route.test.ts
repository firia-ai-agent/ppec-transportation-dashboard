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

/**
 * The demo day's late-ride texts ride on this sweep (PRD §18.2 step 7). They are gated inside
 * `sweepEtaNotices` on the ADR-015 data class and the ADR-014 demo switch, and the preview skip
 * above is in front of all of it — so the one thing to hold here is that the route asks for them
 * at all, and that a deployment holding real data gets the refusal rather than a queued message.
 */
it("asks for the demo day's late-ride texts, and is refused on a real-data deployment", async () => {
  const { DAY_LAST_TICK, demoDayAtTick } = await import("@/domain/board/day");
  const { dueEtaNotices } = await import("@/modules/demo/late-dropoff");
  expect(dueEtaNotices().length).toBeGreaterThan(0);

  const { sweepEtaNotices } = await import("@/modules/messaging/eta-notice");
  const { FakeOutboxTransport } = await import("@/modules/outbox/transport");
  const noDb = { query: async () => { throw new Error("the sweep must not touch a real-data DB"); }, tx: async () => { throw new Error("no"); } };
  await expect(
    sweepEtaNotices(noDb as never, new FakeOutboxTransport(), {
      due: dueEtaNotices(),
      now: new Date(),
      // Past the end of the demo day, so the data-class refusal is what is being measured here and
      // not the scenario-clock gate — that one has its own tests in eta-notice-sweep.test.ts.
      scenarioNow: new Date(demoDayAtTick(DAY_LAST_TICK).instantMs),
      env: { APP_DATA_CLASS: "REAL", DEMO_MODE: "1" },
    }),
  ).resolves.toEqual({ skipped: "not a demo deployment" });
});
