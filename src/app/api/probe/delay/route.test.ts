import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROBE_DELAYS_SECONDS } from "./route";

// TEST-INF-01 delay probe (DECISION-LEDGER row 56), both halves: the GET starter here and its paired
// consumer src/app/api/queues/delay-probe/route.ts. Neither touches the DB, which is what lets the probe
// run on a preview, where the shared production DB is read-only and the timer/outbox routes no-op (#43).
// `send`/`handleCallback` are mocked: the live measurement is the point of the probe, not of this test.
const sent: { topic: string; body: { id: string; requested: number; sentAt: number }; opts: { delaySeconds: number; idempotencyKey?: string } }[] = [];
let failSend: string | null = null;

vi.mock("@vercel/queue", () => ({
  send: (topic: string, body: unknown, opts: unknown) => {
    if (failSend) return Promise.reject(new Error(failSend));
    sent.push({ topic, body, opts } as (typeof sent)[number]);
    return Promise.resolve();
  },
  // The consumer under test is the callback, so unwrap it instead of standing up a queue trigger.
  handleCallback: (fn: unknown) => fn,
}));

const secret = "test-cron-".padEnd(32, "x");
const saved = { ...process.env };
beforeEach(() => { sent.length = 0; failSend = null; });
afterEach(() => { process.env = { ...saved }; });

async function get(env: Record<string, string | undefined>, header: string | null = `Bearer ${secret}`) {
  process.env = { ...saved, CRON_SECRET: secret, DATABASE_URL: undefined, ...env };
  const { GET } = await import("./route");
  return GET(new Request("https://example.test/api/probe/delay", header ? { headers: { authorization: header } } : undefined));
}

it("sends 12 sub-second-precision probes on a preview, with no DB access", async () => {
  const res = await get({ VERCEL_ENV: "preview" });
  expect(res.status).toBe(200);
  // The ids come back so the caller can match requested against actual and separate missing from duplicate
  // deliveries (scripts/test-inf-01/delay-accuracy.ts).
  expect(await res.json()).toEqual({ sent: 12, ids: sent.map((s) => s.body.id) });

  expect(sent.length).toBe(12);
  expect(new Set(sent.map((s) => s.topic))).toEqual(new Set(["ppec-delay-probe"]));
  // Each requested delay twice, and each published as the fractional value, never rounded to a whole second.
  expect(sent.map((s) => s.opts.delaySeconds)).toEqual([...PROBE_DELAYS_SECONDS, ...PROBE_DELAYS_SECONDS]);
  for (const s of sent) {
    expect(s.opts.delaySeconds).not.toBe(Math.ceil(s.opts.delaySeconds));
    expect(s.body.requested).toBe(s.opts.delaySeconds);
    expect(s.body.sentAt).toBeGreaterThan(0); // the consumer measures Date.now() - sentAt
    expect(s.opts.idempotencyKey).toBe(s.body.id);
  }
  expect(new Set(sent.map((s) => s.body.id)).size).toBe(12); // no two probes dedupe each other
});

it("fails closed and never echoes the secret", async () => {
  expect((await get({ VERCEL_ENV: "preview" }, "Bearer nope")).status).toBe(401);
  expect((await get({ VERCEL_ENV: "preview" }, null)).status).toBe(401);
  expect((await get({ VERCEL_ENV: "preview", CRON_SECRET: undefined })).status).toBe(401);
  expect(sent.length).toBe(0);

  failSend = `send refused with ${secret}`; // a provider error that happens to carry the secret
  const res = await get({ VERCEL_ENV: "production" });
  expect(res.status).toBe(502);
  const body = JSON.stringify(await res.json());
  expect(body).toContain('"sent":0');
  expect(body).not.toContain(secret);
});

it("the consumer logs one measurement line per delivery", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { POST } = await import("../../queues/delay-probe/route");
    const consume = POST as unknown as (m: { id: string; requested: number; sentAt: number }) => Promise<void>;
    await consume({ id: "probe-1", requested: 0.25, sentAt: Date.now() - 260 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[delay-probe] id=probe-1 requested=0\.25 actual=\d+ ms$/);
  } finally {
    log.mockRestore();
  }
});
