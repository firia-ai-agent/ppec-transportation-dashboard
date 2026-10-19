import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { agentRetryConfig } from "@/config/live";
import { saveAutoPlan } from "@/test/save-plan";
import { ACTIONS, type ActionCtx } from "@/modules/actions/registry";
import { actionDepsFor } from "@/modules/actions/deps";
import { seedStandardScenario } from "@/modules/demo/seed";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import type { JobRow } from "@/modules/jobs/scheduler";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { raiseVanShortAlerts } from "@/modules/plan/van-short";
import { defaultsOfSlot, vanIdOfSlot } from "@/test/board-day";
import { siteInstantOn } from "@/modules/plan/leg-write";
import { serviceDateIso } from "@/ui/service-date";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { ALERT_TRIGGER } from "../alerts";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "../config";
import { createGateway } from "../gateway";
import { fakeProvider, toolCall } from "../providers/fake";
import { RemoteApiKeyMissing, RemoteProviderUnavailable } from "../providers/remote";
import type { LlmProvider as Provider } from "../providers/provider";
import { dbContextAssembler } from "./assembler";
import { liveExecutors, liveProposalWriter } from "./exec/registry";
import { driveRun } from "./loop";
import { AGENT_RETRY_JOB_KIND, agentRetryHandler } from "./timers";
import type { AgentWake, AgentWakeTransport } from "./wake";

/**
 * A BUSY MODEL IS A WAIT, NOT A FAILURE (ledger #75 — C3, C7).
 *
 * The prod afternoon of 2026-10-18: the ramp confirmed Van 1 short, the alert started a run, and
 * the free model answered 429 on every model — so the run failed and nobody heard anything. Now the
 * run is parked on a one-minute timer, the timer re-queues it and wakes it, and the next try ends
 * the way a reachable model ends it: a card. Past the trigger's window it fails as before.
 */
let db: Db;
let close: () => Promise<void>;
const saved = { ...process.env };
const ENV = {
  APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k",
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
};
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const woken: { m: AgentWake; key?: string }[] = [];
const wake: AgentWakeTransport = { publish: async (m, o) => void woken.push({ m, key: o?.idempotencyKey }) };
const routing = { model: "test-model", provider: "openrouter" };

/** The vendor as prod met it: every model rate-limited, once; then a scripted model. */
function busyThen(script: Parameters<typeof fakeProvider>[0], busyTurns = 1): Provider {
  const fake = fakeProvider(script);
  let busy = busyTurns;
  return {
    ...fake,
    async invoke(call) {
      if (busy > 0) {
        busy -= 1;
        throw new RemoteProviderUnavailable("busy", [
          { model: "a", status: 429, ok: false, failure: "rate_limited" },
          { model: "b", status: 429, ok: false, failure: "rate_limited" },
        ]);
      }
      return fake.invoke(call);
    },
  };
}

function drive(runId: string, provider: Provider, now: Date) {
  const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => now), transport: new FakeOutboxTransport() };
  return driveRun(
    {
      db,
      gateway: createGateway(provider, loadAgentConfig(ENV), { now: () => now.getTime() }),
      assemble: dbContextAssembler(db, { env: ENV }),
      executors: liveExecutors(execDeps),
      proposals: liveProposalWriter(execDeps),
      scheduler: execDeps.scheduler,
      now: () => now,
    },
    runId,
  );
}

const alertRun = async () =>
  (await db.query<{ id: string; state: string }>("SELECT id, state FROM ops.agent_run WHERE trigger_type = $1", [ALERT_TRIGGER])).rows[0];

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  const director = await seedStaff(db, "DIRECTOR", SITE);
  const deps = { ...actionDepsFor(db, SITE), vanShort: (i: Parameters<typeof raiseVanShortAlerts>[3]) => raiseVanShortAlerts(db, wake, routing, i) };
  const ctx: ActionCtx = { siteId: SITE, caller: { userId: director, role: "DIRECTOR" }, now: NOW, deps };
  expect((await saveAutoPlan(ctx, DATE, "PM")).status).toBe(200);
  const short = { ...defaultsOfSlot(1), seats: 2, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const };
  expect((await ACTIONS.confirm_van_setup.run(ctx, short)).status).toBe(200);
  // The alert run is stamped by the database's clock; the test's clock is set from it.
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("a rate-limited model parks a person's run and tries again (C3)", () => {
  it("parks the alert run on a retry timer instead of failing it", async () => {
    const run = await alertRun();
    const result = await drive(run.id, busyThen([toolCall("get_plan", { leg: "PM" }), toolCall("propose_plan_change", { leg: "PM", replan: true, note: "Van 1 came back short, so one child moves." })]), new Date());
    expect(result.state, JSON.stringify(result)).toBe("WAITING_TOOL");
    expect(result.reason).toMatch(/^model busy \(rate limited on every model\); retry 1 at /);
    const jobs = await db.query<{ key: string; state: string }>("SELECT key, state FROM ops.job WHERE kind = $1", [AGENT_RETRY_JOB_KIND]);
    expect(jobs.rows).toEqual([{ key: `${AGENT_RETRY_JOB_KIND}:${run.id}:0`, state: "SCHEDULED" }]);
  });

  it("re-queues and wakes the run when the timer fires, under a wake-up key of its own", async () => {
    const run = await alertRun();
    const job = (await db.query<JobRow>("SELECT * FROM ops.job WHERE kind = $1", [AGENT_RETRY_JOB_KIND])).rows[0];
    const hooks: (() => Promise<void>)[] = [];
    await db.tx((tx) => agentRetryHandler(wake)(tx, job, (h) => void hooks.push(h)));
    for (const h of hooks) await h();
    expect((await alertRun()).state).toBe("QUEUED");
    expect(woken.at(-1)).toMatchObject({ m: { runId: run.id }, key: expect.stringMatching(/:retry:0$/) });
  });

  it("ends the retried run the way a reachable model ends it: a card for a person", async () => {
    const run = await alertRun();
    // Before the afternoon vans leave: once they have, nobody moves between them (ledger #79).
    const beforeDeparture = siteInstantOn(serviceDateIso(new Date()), "13:00")!;
    const result = await drive(run.id, busyThen([toolCall("get_plan", { leg: "PM" }), toolCall("propose_plan_change", { leg: "PM", replan: true, note: "Van 1 came back short, so one child moves." })], 0), beforeDeparture);
    expect(result.state, JSON.stringify(result)).toBe("SUCCEEDED");
    const cards = await db.query("SELECT 1 FROM ops.approval_request WHERE proposal->>'kind' = 'STAFF_ACTION' AND decided_at IS NULL", []);
    expect(cards.rows).toHaveLength(1);
  });
});

describe("past the window it stops, and a family's text is unchanged (C3, C7)", () => {
  it("fails an alert run still busy after its window", async () => {
    const id = "01900000-0000-7000-8000-00000000c701";
    await db.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate, created_by, updated_by, source_mode)
       VALUES ($1, $2, 'VAN_SHORT', 'RED', 'OPEN', 'Van 2 no longer fits its afternoon riders', 'x', 'x', 't', 't', 'SIMULATED')`,
      ["01900000-0000-7000-8000-00000000c7a1", SITE],
    );
    await db.query(
      `INSERT INTO ops.agent_run (id, site_id, trigger_type, trigger_id, state, created_by, updated_by, source_mode, created_at)
       VALUES ($1, $2, $3, $4, 'QUEUED', 't', 't', 'SIMULATED', now() - make_interval(secs => $5))`,
      [id, SITE, ALERT_TRIGGER, "01900000-0000-7000-8000-00000000c7a1", agentRetryConfig.retryForSeconds[ALERT_TRIGGER] + 60],
    );
    const result = await drive(id, busyThen([], 1), new Date());
    expect(result.state, JSON.stringify(result)).toBe("FAILED");
  });

  it("does not wait out a missing key: that will not clear by waiting", async () => {
    const id = "01900000-0000-7000-8000-00000000c703";
    await db.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate, created_by, updated_by, source_mode)
       VALUES ($1, $2, 'VAN_SHORT', 'RED', 'OPEN', 'Van 3 no longer fits its riders this afternoon', 'x', 'x', 't', 't', 'SIMULATED')`,
      ["01900000-0000-7000-8000-00000000c7a3", SITE],
    );
    await db.query(
      `INSERT INTO ops.agent_run (id, site_id, trigger_type, trigger_id, state, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, $4, 'QUEUED', 't', 't', 'SIMULATED')`,
      [id, SITE, ALERT_TRIGGER, "01900000-0000-7000-8000-00000000c7a3"],
    );
    const fake = fakeProvider([]);
    const noKey: Provider = { ...fake, invoke: async () => { throw new RemoteApiKeyMissing("no key", "OPENROUTER_API_KEY"); } };
    expect((await drive(id, noKey, new Date())).state).toBe("FAILED");
  });

  it("never parks a family's text: that run fails at once, as the founder's rule says", async () => {
    const id = "01900000-0000-7000-8000-00000000c702";
    await db.query(
      `INSERT INTO ops.agent_run (id, site_id, trigger_type, trigger_id, state, created_by, updated_by, source_mode)
       VALUES ($1, $2, 'msg.inbound', $3, 'QUEUED', 't', 't', 'SIMULATED')`,
      [id, SITE, "01900000-0000-7000-8000-00000000c7a2"],
    );
    const result = await drive(id, busyThen([], 1), new Date()).catch((e: unknown) => ({ state: `threw ${String(e)}` }));
    // Whatever the assembler makes of a made-up message, it is never parked for a retry.
    expect(result.state).not.toBe("WAITING_TOOL");
    const jobs = await db.query("SELECT 1 FROM ops.job WHERE kind = $1 AND payload->>'runId' = $2", [AGENT_RETRY_JOB_KIND, id]);
    expect(jobs.rows).toHaveLength(0);
  });
});
