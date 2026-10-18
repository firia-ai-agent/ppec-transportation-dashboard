/**
 * The agent queue consumer (`/api/queues/agent`, topic `ppec-agent`, PRD §11.1 "each run = job").
 *
 * The run-driving half is `src/modules/agent/run/queue.test.ts` and `lease.test.ts`; what this
 * suite holds is the route's own three jobs:
 *
 *  1. **It is reachable only as a queue callback.** A request that is not one is refused by
 *     `handleCallback` before our handler is called at all — asserted against the *real*
 *     `@vercel/queue`, not a stand-in, because "the platform checks it" is the whole auth story
 *     this row claims (`src/auth/access.ts`, `queue-callback`).
 *  2. **What it does with a delivery**: a preview acks without work and without a database
 *     handle; everything else is driven, with an unreachable vendor named in the log rather than
 *     left to be inferred from the run's rows.
 *  3. **Its delivery knobs are the ones the lease was chosen against**, including the vercel.json
 *     trigger, which cannot import a constant and so is pinned here instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DELIVERIES } from "@/modules/jobs/scheduler";
import {
  AGENT_QUEUE_RETRY_AFTER_SECONDS,
  AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  AGENT_RUN_MAX_DURATION_SECONDS,
  AGENT_TOPIC,
} from "@/modules/agent/run/queue";

/**
 * The real `handleCallback`, with the handler and the options it was given captured on the way
 * through. So the `POST` under test is the platform's own wrapper — an unauthorized request meets
 * exactly what it would in production — and the consumer body is still reachable for the two
 * ack-without-work cases, which a queue callback cannot be made to deliver from a unit test.
 */
const seen = vi.hoisted(() => ({ calls: 0 } as {
  calls: number;
  handler?: (message: unknown) => Promise<void>;
  options?: { visibilityTimeoutSeconds?: number; retry?: (err: unknown, m: { deliveryCount: number }) => unknown };
}));

vi.mock("@vercel/queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vercel/queue")>();
  return {
    ...real,
    handleCallback: (handler: (message: unknown) => Promise<void>, options: unknown) => {
      seen.handler = async (message: unknown) => { seen.calls += 1; return handler(message); };
      seen.options = options as typeof seen.options;
      return real.handleCallback(seen.handler, options as Parameters<typeof real.handleCallback>[1]);
    },
  };
});

/**
 * A database handle that answers every read with no rows. Enough for the lease to refuse an
 * unknown run, which is the outcome this suite wants, and it keeps the route off a real
 * connection — `getNeonDb()` would throw without `DATABASE_URL`.
 */
vi.mock("@/db/exec", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/db/exec")>();
  return {
    ...real,
    getNeonDb: () => ({
      query: async () => ({ rows: [] }),
      tx: async (fn: (tx: unknown, after: (h: () => Promise<void>) => void) => unknown) =>
        fn({ query: async () => ({ rows: [] }) }, () => {}),
    }),
  };
});

const ROUTE_FILE = "src/app/api/queues/agent/route.ts";
const saved = { ...process.env };

beforeEach(() => { seen.calls = 0; });
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

/** The route, loaded with the environment a delivery would arrive in. */
async function load(env: Record<string, string | undefined> = {}) {
  process.env = { ...saved, DATABASE_URL: undefined, VERCEL_ENV: undefined, ...env };
  return import("./route");
}

describe("the route is reachable only as a queue callback", () => {
  /**
   * Four shapes a request can be wrong in, and all four are refused 400 by `@vercel/queue` with
   * our handler never invoked. That is the auth: a queue trigger is not internet-routable per the
   * Queues docs, and anything that does reach the function without the platform's CloudEvent
   * envelope is rejected before the consumer sees a payload. A staff session is not a second way
   * in — `src/auth/access.test.ts` reads this file and asserts there is no session path in it.
   */
  it.each([
    ["an ordinary POST with no CloudEvent headers", {}, "{}"],
    ["a CloudEvent content type with nothing in it", { "content-type": "application/cloudevents+json" }, "{}"],
    [
      "a CloudEvent missing its queue fields",
      { "content-type": "application/cloudevents+json" },
      JSON.stringify({ id: "1", type: "queue/v2beta" }),
    ],
    ["binary-mode headers without the queue ones", { "ce-type": "com.vercel.queue.v2beta" }, "{}"],
  ])("refuses %s, without calling the consumer", async (_why, headers, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await load();

    const res = await POST(new Request("https://example.test/api/queues/agent", { method: "POST", headers, body }));

    expect(res.status).toBe(400);
    expect(seen.calls).toBe(0);
  });
});

describe("what a delivery does", () => {
  /**
   * The §11.1 assembler exists now (`run/assembler.ts`), so a well-formed wake-up is **driven**:
   * it reaches the per-run lease, which refuses a run this database does not have and acks. The
   * database is a stub rather than a real one because what this asserts is the route's wiring —
   * the lease's own answers are `run/lease.test.ts`, against a real schema.
   *
   * It also asserts the thing the old "no runner" case used to: a deployment with no
   * `$OPENROUTER_API_KEY` still drives the run — and says, once per delivery, that no model will
   * answer it. There is no second reader behind the model (founder, 2026-10-17), so the run's
   * first turn is refused and the family's text goes to a person as the staff alert.
   */
  it("drives the wake-up, and says no model is available when there is no key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await load();

    await seen.handler!({ runId: "00000000-0000-7000-8000-00000000000a", siteId: "00000000-0000-7000-8000-000000000001" });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[queue:agent] no model available: "))).toBe(true);
    // The run was driven: the lease is what answered, and it refused a run this database has not
    // got rather than the route refusing to look.
    expect(lines.some((l) => l.startsWith("[queue:agent] refused missing run="))).toBe(true);
  });

  /**
   * The same delivery on a deployment that *has* confirmed demo-data operation but has no key:
   * still driven, still logged as having no model, and the reason names the environment variable
   * — never a value. This is the one that matters for the founder's deployment, where the two
   * demo vars are set.
   */
  it("names the missing key by its variable when the demo-data guard passes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await load({ AGENT_DEMO_DATA_ONLY: "true", APP_DATA_CLASS: "SYNTHETIC", OPENROUTER_API_KEY: undefined });

    await seen.handler!({ runId: "00000000-0000-7000-8000-00000000000a", siteId: "00000000-0000-7000-8000-000000000001" });

    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("$OPENROUTER_API_KEY");
    expect(lines).toContain("no model available");
  });

  it("previews ack without work, as on every queue route (DECISION-LEDGER #43)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await load({ VERCEL_ENV: "preview" });

    await seen.handler!({ runId: "00000000-0000-7000-8000-00000000000a", siteId: "00000000-0000-7000-8000-000000000001" });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[queue:agent] preview read-only \(preview read-only: /);
  });

  /**
   * The order is the point, not the style: both checks are above the first line that reads or
   * writes anything, so a delivery this deployment cannot act on never reaches a database handle,
   * a model turn or a claim on somebody's run.
   */
  it("checks the preview, then the runner, before it touches the database or the lease", () => {
    const source = readFileSync(join(process.cwd(), ROUTE_FILE), "utf8");
    const body = source.slice(source.indexOf("export const POST"));
    const at = (needle: string) => body.indexOf(needle);

    expect(at("previewSkip")).toBeGreaterThan(-1);
    // Nothing is read, claimed or driven above the preview check: not the database handle, not
    // the runner, not the lease.
    for (const later of ["getNeonDb()", "agentRunner(db)", "handleAgentWake"]) {
      expect({ later, after: at(later) > at("previewSkip") }, later).toEqual({ later, after: true });
    }
    expect(at("agentRunner(db)")).toBeLessThan(at("handleAgentWake"));
  });
});

describe("the delivery knobs", () => {
  it("the consumer is configured with the visibility timeout and the bounded retry the lease needs", async () => {
    await load();

    expect(seen.options?.visibilityTimeoutSeconds).toBe(AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS);
    expect(seen.options?.retry?.(new Error("x"), { deliveryCount: 1 })).toEqual({
      afterSeconds: AGENT_QUEUE_RETRY_AFTER_SECONDS,
    });
    expect(seen.options?.retry?.(new Error("x"), { deliveryCount: MAX_DELIVERIES })).toEqual({ acknowledge: true });
  });

  it("the route's maxDuration is the one the lease was chosen against", async () => {
    const { maxDuration, dynamic } = await load();
    // The route has to spell the number out — Next rejects a segment config export that is not a
    // literal — so this is what keeps the spelled-out 120 and the constant from drifting apart.
    expect(maxDuration).toBe(AGENT_RUN_MAX_DURATION_SECONDS);
    // A queue delivery is never answered from a static render.
    expect(dynamic).toBe("force-dynamic");
  });

  it("the vercel.json trigger names this topic and carries the lease as its retryAfterSeconds", () => {
    // vercel.json cannot import a constant, so pin the two together here instead of letting them drift.
    const vercelJson = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      functions: Record<string, { experimentalTriggers?: { topic: string; retryAfterSeconds?: number }[] }>;
    };
    expect(vercelJson.functions[ROUTE_FILE].experimentalTriggers?.[0]).toMatchObject({
      type: "queue/v2beta",
      topic: AGENT_TOPIC,
      retryAfterSeconds: AGENT_QUEUE_RETRY_AFTER_SECONDS,
    });
  });
});
