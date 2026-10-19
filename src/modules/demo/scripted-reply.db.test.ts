import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import type { AgentWake, AgentWakeTransport } from "@/modules/agent/run/wake";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler, type JobRow } from "@/modules/jobs/scheduler";
import { enqueue } from "@/modules/outbox/outbox";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { freshPlanDb, SITE } from "@/test/pglite";
import { familyTexts } from "@/ui/copy";
import { DEMO_INBOUND, childTokenOf, demoLegId } from "./fixtures/standard";
import { SCRIPTED_REPLY_JOB_KIND, scheduleScriptedReply, scriptedReplyHandler } from "./scripted-reply";
import { seedStandardScenario } from "./seed";

/**
 * The scenario parent answers the re-plan's late text once it is delivered (user ruling
 * 2026-10-18) — once, through the real inbound path, and only on a synthetic demo deployment.
 */

const NOW = new Date("2026-10-16T19:30:00.000Z");
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "syn-pepper-0123456789", DATA_KEY: "k" };
const CHILD = () => childTokenOf(DEMO_INBOUND.childKey);

let db: Db;
let close: () => Promise<void>;
// The identity gateway reads the process's own env (pepper, data key), as on a deployment.
const saved = { ...process.env };
const outbox = new FakeOutboxTransport();
const wakes = new FakeTransport();
const scheduler = () => new VercelQueueScheduler(db, wakes, () => NOW);

/** One text to the scenario family, as it is once the carrier has said DELIVERED. */
async function deliveredText(templateId: string, vars: Record<string, unknown>, key: string): Promise<string> {
  const [recipientToken] = await authorizedContactsForChild(db, { siteId: SITE, childToken: CHILD(), at: NOW });
  const id = await db.tx(async (tx, afterCommit) => {
    const sent = await enqueue(tx, afterCommit, outbox, {
      siteId: SITE, purpose: FAMILY_SMS.purpose, recipientRule: FAMILY_SMS.recipientRule, recipientToken,
      channel: FAMILY_SMS.channel, templateId, vars, childToken: CHILD(),
      tripLegId: demoLegId(DEMO_INBOUND.childKey, "PM"), planVersionBasis: 1,
      notAfter: new Date(NOW.getTime() + 3600_000), idempotencyKey: key, by: "test",
    });
    return sent.id;
  });
  await db.query("UPDATE ops.outbound_message SET state = 'DELIVERED' WHERE id = $1", [id]);
  return id;
}

const schedule = (outboundMessageId: string, env = ENV) =>
  db.tx((tx, afterCommit) =>
    scheduleScriptedReply(tx, afterCommit, scheduler(), { outboundMessageId, status: "DELIVERED", now: NOW, env }),
  );

const replyJobs = async () =>
  (await db.query<JobRow>("SELECT * FROM ops.job WHERE kind = $1", [SCRIPTED_REPLY_JOB_KIND])).rows;

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("the scenario parent replies to the re-plan's late text", () => {
  it("answers nothing on a deployment that is not a synthetic demo", async () => {
    const id = await deliveredText("dropoff.late_eta", { delayMinutes: 25, eta: "16:45", stopLabel: "OKEE-PARK" }, "k-off");
    expect(await schedule(id, { ...ENV, DEMO_MODE: "0" })).toBe("off");
    expect(await replyJobs()).toEqual([]);
  });

  it("answers no other text: the stall replay's late notice is not the one", async () => {
    const id = await deliveredText("dropoff.late", { delayMinutes: 10, stopLabel: "OKEE-PARK" }, "k-stall");
    expect(await schedule(id)).toBe("not-this-text");
    expect(await replyJobs()).toEqual([]);
  });

  it("schedules one reply for the delivered re-plan text, and never a second", async () => {
    const first = await deliveredText("dropoff.late_eta", { delayMinutes: 25, eta: "16:45", stopLabel: "OKEE-PARK" }, "k-1");
    const second = await deliveredText("dropoff.late_eta", { delayMinutes: 30, eta: "16:50", stopLabel: "OKEE-PARK" }, "k-2");
    expect(await schedule(first)).toBe("scheduled");
    expect(await schedule(second)).toBe("already");
    const jobs = await replyJobs();
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].due_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("the job sends the parent's words through the real inbound path and wakes the agent", async () => {
    const [job] = await replyJobs();
    const agentWakes: AgentWake[] = [];
    const agent: AgentWakeTransport = { publish: async (msg) => void agentWakes.push(msg) };
    const handler = scriptedReplyHandler({ agentTransport: agent, outboxTransport: outbox, env: ENV, now: () => NOW });
    await db.tx((tx, afterCommit) => handler(tx, job, afterCommit));

    const inbound = await db.query<{ body_tokenized: string }>(
      "SELECT body_tokenized FROM ops.message WHERE direction = 'IN'", [],
    );
    expect(inbound.rows).toHaveLength(1);
    expect(inbound.rows[0].body_tokenized).toContain(familyTexts.demoReply);
    const runs = await db.query<{ id: string }>("SELECT id FROM ops.agent_run WHERE trigger_type = 'msg.inbound'", []);
    expect(runs.rows).toHaveLength(1);
    expect(agentWakes).toEqual([{ runId: runs.rows[0].id, siteId: SITE }]);

    // A redelivered job is the webhook's own duplicate: still one message and one run.
    await db.tx((tx, afterCommit) => handler(tx, job, afterCommit));
    expect((await db.query("SELECT 1 FROM ops.message WHERE direction = 'IN'", [])).rows).toHaveLength(1);
  });
});
