/**
 * THE DEMO, END TO END, WITH NOTHING PRE-WRITTEN (founder, 2026-10-18).
 *
 *  1. Restart seeds the day and Dara's text arrives through the real inbound path — one message,
 *     one `msg.inbound` run, one agent wake-up. No card, no alert.
 *  2. The model reads the thread and the plan with its tools and calls `propose_dropoff_change`;
 *     the policy engine holds it as a PROPOSAL, so nothing changes yet.
 *  3. The alert and the reply are the model's own words — written in the prompt's tokens and
 *     stored in names — and match no template.
 *  4. The card is one row, read by Family texts (`approvalQueue`) and the bubble (`readAgentThread`).
 *  5. Approve moves the plan to 5 PM, records Dara as the receiver and queues exactly that text.
 *
 * The model is a stand-in that reads the **real assembled prompt** and answers in the tokens it was
 * given, the way a live model has to — so this proves the prompt carries what a model needs, not
 * that a script can name ids it already knew. On PGlite over the real migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { demoDay } from "@/domain/board/day";
import { loadAgentConfig } from "@/modules/agent/config";
import { createGateway } from "@/modules/agent/gateway";
import type { LlmProvider, ProviderCall, ProviderResponseBody } from "@/modules/agent/providers/provider";
import { dbContextAssembler } from "@/modules/agent/run/assembler";
import { liveExecutors, liveProposalWriter } from "@/modules/agent/run/exec/registry";
import { driveRun, type RunDeps } from "@/modules/agent/run/loop";
import type { AgentWake, AgentWakeTransport } from "@/modules/agent/run/wake";
import { readAgentThread } from "@/modules/agent/ask/thread";
import { decideApproval, pendingApprovals } from "@/modules/approvals/decide";
import { boardPlacementPort } from "@/modules/approvals/plan-placement-port";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { renderTemplate } from "@/modules/messaging/templates";
import { siteInstantOn } from "@/modules/plan/leg-write";
import { sqlPlanStoreIn } from "@/modules/plan/sql";
import { sqlDaySource } from "@/modules/roster/sql";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { approvalQueue } from "@/app/(app)/family-texts/queue";
import { agentBubble, fill } from "@/ui/copy";
import { KIND, childTokenOf, demoId, demoLegId } from "./fixtures/standard";
import { sendDemoInbound } from "./inbound-script";
import { seedStandardScenario } from "./seed";

const NOW = new Date("2026-10-16T19:30:00.000Z");
const SERVICE_DATE = "2026-10-16";
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "syn-pepper-0123456789", DATA_KEY: "k" };
const DARA_CONTACT = demoId(KIND.contact, 2);
/** The model's reply, back in names — and what Dara gets, behind the sender prefix every family text carries. */
const REPLY = "Hi Dara, yes, we can drop Noah off at 5 today. Thank you for letting us know.";

let db: Db;
let close: () => Promise<void>;
let coordinator: string;
const saved = { ...process.env };

class WakeSpy implements AgentWakeTransport {
  readonly sent: AgentWake[] = [];
  async publish(msg: AgentWake): Promise<void> {
    this.sent.push(msg);
  }
}

/**
 * A model that reads the prompt. Turn 1 reads the thread it was given; turn 2 proposes moving the
 * PM leg of the child the thread is about to the time the parent asked for — every id taken from
 * the prompt's own tokens. What it writes is in tokens too, as the prompt tells a model to.
 */
function promptReadingModel(vendor: string): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    kind: "fake",
    vendor,
    endpoint: "/api/v1/chat/completions",
    prompts,
    async invoke(call: ProviderCall): Promise<ProviderResponseBody> {
      prompts.push(call.prompt);
      const thread = /thread=(\S+)/.exec(call.prompt)?.[1];
      const leg = /leg=(\S+) child=(\S+) part=PM state=\S+ version=(\d+)/.exec(call.prompt);
      const family = /family=(\S+)/.exec(call.prompt)?.[1];
      if (!call.prompt.includes("result seq=")) {
        return { tool_calls: [{ name: "read_guardian_thread", arguments: { thread_id: thread, count: 5 } }] };
      }
      const [, legToken, child, version] = leg ?? [];
      return {
        tool_calls: [
          {
            name: "propose_dropoff_change",
            arguments: {
              leg_id: legToken,
              requested_dropoff_time: "17:00",
              requested_stop_token: null,
              rationale_code: "PARENT_REQUEST",
              alert_text: `${family} asked to move ${child}'s drop-off to 5 PM because someone is home then.`,
              reply: `Hi ${family}, yes, we can drop ${child} off at 5 today. Thank you for letting us know.`,
              source_message_id: "MSG-1",
              expected_version: Number(version),
            },
          },
        ],
      };
    },
  };
}

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
}, 180_000);

afterAll(async () => {
  process.env = { ...saved };
  await close();
});

describe("Restart → Dara's text → the model's card → Approve", () => {
  const wake = new WakeSpy();
  const outbox = new FakeOutboxTransport();
  let runId = "";
  let model: ReturnType<typeof promptReadingModel>;

  it("Restart seeds the day and Dara's text arrives through the real inbound path, and nothing else", async () => {
    const seeded = await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
    const sent = await sendDemoInbound(db, {
      env: ENV, now: NOW, serviceDate: seeded.serviceDate, agentTransport: wake, outboxTransport: outbox,
    });
    expect(sent, JSON.stringify(sent)).toMatchObject({ sent: true, body: { known: true } });

    const messages = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.message WHERE direction = 'IN'", []);
    const runs = await db.query<{ id: string; trigger_type: string; state: string }>(
      "SELECT id, trigger_type, state FROM ops.agent_run", [],
    );
    expect(messages.rows[0].n).toBe(1);
    expect(runs.rows.map((r) => r.trigger_type)).toEqual(["msg.inbound"]);
    expect(wake.sent).toEqual([{ runId: runs.rows[0].id, siteId: SITE }]);
    runId = runs.rows[0].id;
    // No pre-built card and no canned alert.
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.approval_request", [])).rows[0].n).toBe(0);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.task", [])).rows[0].n).toBe(0);
  }, 120_000);

  it("a second Restart is one message and one run again, not two", async () => {
    const seeded = await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
    for (let i = 0; i < 2; i += 1) {
      await sendDemoInbound(db, {
        env: ENV, now: NOW, serviceDate: seeded.serviceDate, agentTransport: wake, outboxTransport: outbox,
      });
    }
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.message", [])).rows[0].n).toBe(1);
    const runs = await db.query<{ id: string }>("SELECT id FROM ops.agent_run", []);
    expect(runs.rows).toHaveLength(1);
    runId = runs.rows[0].id;
  }, 120_000);

  it("the model reads the thread, then proposes; the call is held and nothing changes", async () => {
    const config = loadAgentConfig({});
    model = promptReadingModel(config.provider);
    const execDeps = {
      db,
      scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW),
      transport: outbox,
    };
    const deps: RunDeps = {
      db,
      gateway: createGateway(model, config, { now: () => NOW.getTime() }),
      assemble: dbContextAssembler(db, { env: ENV }),
      executors: liveExecutors(execDeps),
      proposals: liveProposalWriter(execDeps),
      scheduler: execDeps.scheduler,
      now: () => NOW,
    };
    const before = await db.query<{ window_start: Date }>("SELECT window_start FROM ops.trip_leg WHERE id = $1", [demoLegId("C2", "PM")]);

    const result = await driveRun(deps, runId);
    expect(result, JSON.stringify(result)).toMatchObject({ state: "SUCCEEDED", steps: 2 });

    // What the model was shown: Dara's own words, tokenized, and the leg it can change.
    expect(model.prompts[0]).toMatch(/Can you drop C2 at 5 instead\? Someone is home then\./);
    expect(model.prompts[0]).toMatch(/part=PM state=\S+ version=\d+ window=16:20/);
    expect(model.prompts.join("\n")).not.toMatch(/Noah|Dara/);

    const calls = await db.query<{ tool: string; status: string }>(
      "SELECT tool, status FROM ops.agent_tool_call WHERE run_id = $1 ORDER BY seq", [runId],
    );
    expect(calls.rows.map((c) => [c.tool, c.status])).toEqual([
      ["read_guardian_thread", "EXECUTED"],
      ["propose_dropoff_change", "PROPOSED"],
    ]);
    // Held: the leg is exactly as it was, and no text has been queued.
    const after = await db.query<{ window_start: Date }>("SELECT window_start FROM ops.trip_leg WHERE id = $1", [demoLegId("C2", "PM")]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", [])).rows[0].n).toBe(0);
  }, 120_000);

  it("the card carries the model's words in names, and no template's", async () => {
    const [row] = await pendingApprovals(db, [SITE]);
    expect(row.alertText).toBe("Dara asked to move Noah's drop-off to 5 PM because someone is home then.");
    expect(row.text).toBe(`PPEC: ${REPLY}`);
    // Veri's line: no card or alert text equals a template while the model is up.
    const templated = [
      renderTemplate("dropoff.changed", { legDate: SERVICE_DATE, eta: "17:00", stopLabel: row.stopToken }, { child: "Noah" }),
      fill(agentBubble.dropoffWaiting, { parent: "Dara", child: "Noah", time: "5" }),
      agentBubble.dropoffWaitingUnnamed,
    ];
    for (const t of templated) {
      expect(row.text).not.toBe(t);
      expect(row.alertText).not.toBe(t);
    }
    const proposal = await db.query<{ requested_by_contact: string }>(
      "SELECT proposal->>'requested_by_contact' AS requested_by_contact FROM ops.approval_request", [],
    );
    expect(proposal.rows[0].requested_by_contact).toBe(DARA_CONTACT);
  });

  it("Family texts and the bubble read the same one row", async () => {
    const queue = await approvalQueue({ db, siteIds: [SITE], day: demoDay(), editedTime: null });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      threadKey: "C2",
      draftText: `PPEC: ${REPLY}`,
      alertText: "Dara asked to move Noah's drop-off to 5 PM because someone is home then.",
    });
    const thread = await readAgentThread(db, SITE);
    expect(thread.waiting).toBe(1);
    expect(thread.items.filter((i) => i.kind === "proposal").map((i) => i.id)).toEqual([queue[0].approvalId]);
  });

  it("Approve moves the plan to 5 PM, records Dara as receiver, and queues exactly that text", async () => {
    const [row] = await pendingApprovals(db, [SITE]);
    const placement = boardPlacementPort({ store: (tx) => sqlPlanStoreIn(tx), source: (tx, siteId) => sqlDaySource(tx, siteId) });
    const answer = await decideApproval(
      db, outbox, { userId: coordinator, approvalId: row.id, decision: "APPROVED", now: NOW }, { placement },
    );
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200 });

    const leg = await db.query<{ window_start: Date; receiver_confirmed_at: Date | null }>(
      "SELECT window_start, receiver_confirmed_at FROM ops.trip_leg WHERE id = $1", [demoLegId("C2", "PM")],
    );
    expect(new Date(leg.rows[0].window_start).toISOString()).toBe(siteInstantOn(SERVICE_DATE, "17:00")!.toISOString());
    expect(leg.rows[0].receiver_confirmed_at).not.toBeNull();
    const receivers = await db.query<{ contact_token: string }>(
      `SELECT contact_token::text AS contact_token FROM ops.contact_authorization
        WHERE site_id = $1 AND child_token = $2 AND scope = 'RECEIVE_CHILD'`,
      [SITE, childTokenOf("C2")],
    );
    expect(receivers.rows.map((r) => r.contact_token)).toEqual([DARA_CONTACT]);

    const sent = await db.query<{ template_id: string; vars: Record<string, unknown>; recipient_token: string }>(
      "SELECT template_id, vars, recipient_token::text AS recipient_token FROM ops.outbound_message", [],
    );
    expect(sent.rows).toHaveLength(1);
    expect(sent.rows[0]).toMatchObject({
      template_id: "dropoff.reply",
      recipient_token: DARA_CONTACT,
      vars: { replyText: REPLY },
    });
  });
});
