import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { formatWindow, windowFor } from "@/domain/eta/eta";
import {
  ASM14_THRESHOLDS,
  emptyGateState,
  evaluateStop,
  type GateState,
  type NotificationDecision,
  type NotifyThresholds,
} from "@/domain/eta/notify-gate";
import { notifyGateConfig } from "@/config/live";
import type { StopEta } from "@/domain/eta/eta";
import { drain } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer, gatewayRecipientAuthorizer } from "@/modules/outbox/policy";
import { SimMessagingProvider } from "@/modules/outbox/provider";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { fire, type Handlers } from "@/modules/jobs/runner";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { InMemorySimFaultStore } from "./faults";
import { DbSimMessagingProvider, SIM_DELAY_MAX_MS, SIM_STATUS_JOB_KIND, simStatusHandler } from "./sim-provider";
import { isAutoSend } from "./auto-sends";
import { bubbleOf } from "@/app/(app)/family-texts/thread";
import { runsOf } from "@/app/(app)/family-texts/conversations";
import { demoDay } from "@/domain/board/day";
import { testIdentityGateway } from "@/test/identity-gateway";
import { familyTexts } from "@/ui/copy";
import { outboundStates } from "@/ui/states";
import { seedAgentScenario, type AgentScenario } from "@/test/agent-state";
import { TEST_NOW } from "@/test/clock";
import { PEPPER } from "@/test/messaging";
import { freshDb } from "@/test/pglite";
import { personaMessages, resolvePersona } from "./mailbox";
import { dbIdentityGateway } from "@/modules/identity/gateway";
import { SEND_FOOTER } from "./templates";
import {
  ETA_NOTICE_NOT_AFTER_MS,
  enqueueEtaNotice,
  etaNoticeKey,
  etaNoticeTemplate,
  etaNoticeThresholds,
  lateMinutesFor,
} from "./eta-notice";

/**
 * The late-ride text, end to end on a real schema (PRD §18.2 step 7, AT-03).
 *
 * What these cover that the gate's own suite cannot: the queueing half. The gate decides and
 * sends nothing (by design, `notify-gate.ts`), so "once per ride per threshold crossing" is only
 * true if the outbox row's idempotency key says so — and that is a claim about a database, which
 * is why this suite runs on PGlite with the migrations applied rather than on a fake.
 */

let pg: PGlite;
let db: Db;
let scenario: AgentScenario;
let transport: FakeOutboxTransport;

/** 4:20 PM on the scenario's own day: Noah's planned afternoon drop-off (fixtures `pmWindow`). */
const PLANNED_DROPOFF_MS = Date.UTC(2026, 9, 14, 20, 20, 0);

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  scenario = await seedAgentScenario(db);
  transport = new FakeOutboxTransport();
});

afterEach(async () => {
  await pg.close();
});

/** The ride a decision is about, as the drive reads it out of the operational tables. */
function ride() {
  return {
    siteId: scenario.siteId,
    legId: scenario.legs[scenario.children[0]].PM,
    childToken: scenario.children[0],
    direction: "PM" as const,
    planVersion: 1,
    stopToken: "OKEE-PARK",
  };
}

/** A gate decision that opened, for an arrival `lateSeconds` after the planned drop-off. */
function notified(lateSeconds: number): NotificationDecision {
  const etaMs = PLANNED_DROPOFF_MS + lateSeconds * 1000;
  const window = windowFor(etaMs);
  return {
    atMs: PLANNED_DROPOFF_MS - 45 * 60_000,
    stopId: "S2",
    familyLabel: "F2",
    outcome: "NOTIFY",
    reason: "shift-persisted",
    shiftSeconds: lateSeconds,
    shiftText: `+${Math.round(lateSeconds / 60)} min`,
    windowText: "4:30–4:40 PM",
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
  };
}

const enqueueOne = (decision: NotificationDecision) =>
  enqueueEtaNotice(db, transport, { decision, ride: ride(), now: TEST_NOW, by: "test:eta-notice" });

async function outboundRows() {
  const r = await db.query<{
    id: string; state: string; template_id: string; vars: Record<string, unknown>;
    idempotency_key: string; trip_leg_id: string | null; child_token: string | null;
    purpose: string; recipient_token: string; not_after: Date | string; plan_version_basis: number;
  }>("SELECT id, state, template_id, vars, idempotency_key, trip_leg_id, child_token, purpose, recipient_token, not_after, plan_version_basis FROM ops.outbound_message ORDER BY created_at, id", []);
  return r.rows;
}

describe("the threshold is config, not a literal", () => {
  it("is the §8 parameter table's own row, read through the one seam", () => {
    expect(etaNoticeThresholds()).toEqual(ASM14_THRESHOLDS);
    expect(etaNoticeThresholds()).toMatchObject({
      shiftSeconds: notifyGateConfig.shiftSeconds,
      consecutiveCalcs: notifyGateConfig.consecutiveCalcs,
      minLeadSeconds: notifyGateConfig.minLeadSeconds,
      cooldownSeconds: notifyGateConfig.cooldownSeconds,
      escalationSeconds: notifyGateConfig.escalationSeconds,
      improvementSeconds: notifyGateConfig.improvementSeconds,
    });
  });

  it("carries no threshold of its own: the module names no number", () => {
    const source = readFileSync(new URL("./eta-notice.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");
    // The two numbers it *is* allowed: how long a notice stays sendable, and the 5-minute step
    // lateness is said in. Neither is a gate threshold.
    expect(source.match(/\b\d{3,}\b/g) ?? []).toEqual([]);
  });

  /**
   * The point of the seam: the *same* run of recalculations notifies at one threshold and stays
   * silent at the other. Driven through the real gate, so this is the rule it enforces and not a
   * restatement of a config object.
   */
  it("decides a 7-minute slip by the thresholds it is handed and nothing else", () => {
    const stop = (etaMs: number): StopEta => {
      const window = windowFor(etaMs);
      return {
        stopIndex: 2,
        stopId: "S2",
        stopName: "Okeeheelee Park",
        familyLabel: "F2",
        status: "pending",
        etaMs,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        // The real window text, because the gate refuses to re-publish an unchanged one
        // (`same-window`) and a constant here would suppress every crossing.
        windowText: formatWindow(window.startMs, window.endMs),
      };
    };
    const nowMs = PLANNED_DROPOFF_MS - 45 * 60_000;
    // The baseline sits five minutes before the planned drop-off so that a seven-minute slip
    // crosses a 10-minute window boundary: a slip inside the published window is a `same-window`
    // suppression at *any* threshold (PRD §8 damping), which is a different rule from this one.
    const baselineMs = PLANNED_DROPOFF_MS - 300_000;
    const run = (thresholds: NotifyThresholds) => {
      // One baseline, then the same 7-minute slip held across two consecutive calculations.
      let state: GateState = emptyGateState();
      const outcomes: string[] = [];
      for (const etaMs of [baselineMs, baselineMs + 420_000, baselineMs + 420_000]) {
        const next = evaluateStop(state, { stop: stop(etaMs), nowMs, etaTextSuppressed: false, thresholds });
        state = next.state;
        outcomes.push(next.decision.outcome);
      }
      return outcomes;
    };
    expect(run(etaNoticeThresholds())).not.toContain("NOTIFY");
    expect(run({ ...etaNoticeThresholds(), shiftSeconds: 300 })).toContain("NOTIFY");
  });

  it("says lateness in five-minute steps, never zero", () => {
    expect(lateMinutesFor(912)).toBe(15);
    expect(lateMinutesFor(780)).toBe(15);
    expect(lateMinutesFor(610)).toBe(10);
    expect(lateMinutesFor(61)).toBe(5);
  });
});

describe("a crossing becomes one queued text", () => {
  it("queues the afternoon body for the child's authorized contact, with the 10-minute window", async () => {
    const result = await enqueueOne(notified(900));
    expect(result).toMatchObject({ duplicate: false });

    const rows = await outboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].template_id).toBe("dropoff.late");
    expect(rows[0].state).toBe("QUEUED");
    expect(rows[0].recipient_token).toBe(scenario.contactToken);
    expect(rows[0].child_token).toBe(scenario.children[0]);
    expect(rows[0].trip_leg_id).toBe(ride().legId);
    expect(rows[0].plan_version_basis).toBe(1);
    /*
     * No `eta` and no `etaEnd` on the afternoon's late text (Firia, 2026-10-17 10:51 PM ET: "the
     * auto late text has no time range and no ETA"). The morning's `pickup.eta` still carries
     * its §8 window — the test below is that one — so the two are asserted apart rather than one
     * shape being assumed for both.
     */
    expect(rows[0].vars).toEqual({
      stopLabel: "OKEE-PARK",
      delayMinutes: 15,
    });
    expect(new Date(rows[0].not_after).getTime()).toBe(TEST_NOW.getTime() + ETA_NOTICE_NOT_AFTER_MS);
    expect(transport.sent).toEqual([rows[0].id]);
  });

  it("is the morning's own body on a morning ride", () => {
    expect(etaNoticeTemplate("AM")).toBe("pickup.eta");
    expect(etaNoticeTemplate("PM")).toBe("dropoff.late");
  });

  it("sends the same crossing once, however many times the drive runs", async () => {
    const first = await enqueueOne(notified(900));
    const second = await enqueueOne(notified(900));
    const third = await enqueueOne(notified(905)); // same 10-minute window, a second later

    expect(first).toMatchObject({ duplicate: false });
    expect(second).toMatchObject({ duplicate: true });
    expect(third).toMatchObject({ duplicate: true });
    expect(await outboundRows()).toHaveLength(1);
  });

  it("sends a second text when a later crossing publishes a new window", async () => {
    await enqueueOne(notified(900));
    await enqueueOne(notified(2400));
    const rows = await outboundRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key)).toEqual([
      etaNoticeKey(ride().legId, windowFor(PLANNED_DROPOFF_MS + 900_000).startMs),
      etaNoticeKey(ride().legId, windowFor(PLANNED_DROPOFF_MS + 2_400_000).startMs),
    ]);
  });

  it("queues nothing for a decision the gate suppressed", async () => {
    const suppressed: NotificationDecision = { ...notified(900), outcome: "SUPPRESS", reason: "same-window" };
    expect(await enqueueOne(suppressed)).toEqual({ skipped: "not-notified" });
    expect(await outboundRows()).toHaveLength(0);
  });

  it("queues nothing when the gate published no window", async () => {
    const noWindow: NotificationDecision = { ...notified(900), windowStartMs: undefined };
    expect(await enqueueOne(noWindow)).toEqual({ skipped: "no-window" });
    expect(await outboundRows()).toHaveLength(0);
  });

  it("queues nothing for a child with nobody authorized to be told", async () => {
    await db.query("DELETE FROM ops.contact_authorization WHERE child_token = $1", [scenario.children[0]]);
    expect(await enqueueOne(notified(900))).toEqual({ skipped: "no-authorized-contact" });
    expect(await outboundRows()).toHaveLength(0);
  });
});

describe("what the family actually reads", () => {
  it("leaves through the outbox and lands in the phone thread, in plain words", async () => {
    await enqueueOne(notified(900));
    const rows = await outboundRows();
    const outcome = await drain(db, rows[0].id, {
      provider: new SimMessagingProvider(),
      authorizer: dbRecipientAuthorizer(db),
      clock: () => TEST_NOW,
    });
    expect(outcome).toBe("SENT");

    const persona = await resolvePersona(db, { number: scenario.number, pepper: PEPPER, gateway: dbIdentityGateway(db, { pepper: PEPPER }) });
    const thread = await personaMessages(db, persona!);
    const text = thread.find((m) => m.direction === "OUT")!;
    expect(text.reachedPhone).toBe(true);
    expect(text.body).toContain("running about 15 minutes late");
    expect(text.body).toContain("Okeeheelee Park");
    // A bubble is the message. No [DEMO] tag and no STOP/HELP footer in a thread (Firia,
    // 11:00 PM ET, S1-5) — what left the centre carried the footer; what a coordinator reads
    // back is the words. `sim-provider.test.ts` holds the other half.
    expect(text.body).not.toContain("DEMO");
    expect(text.body).not.toContain(SEND_FOOTER);
    // No time of any kind in it, and no range (Firia, 10:51 PM ET).
    expect(text.body).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text.body).not.toContain("\u2013");
    /*
     * COPY-GUIDE §2: no ride id, no threshold, no internal code, and no raw var.
     *
     * The child's *name* is now in the body by Firia's 10:51 PM ET ruling — read from the child's
     * own row at render time and never from a var (Veri #12's rule is about a name a caller
     * chose; `templates.test.ts` holds that door). This scenario's child is seeded as "Syn C.",
     * so the name that appears is the one the row holds.
     */
    expect(text.body).not.toMatch(/OKEE-PARK|16:30/);
    expect(text.body).not.toMatch(new RegExp(ride().legId));
    expect(text.body).not.toMatch(/ETA|threshold|SHIFT|NOTIFY/i);
  });

  it("is blocked at egress for a family that opted out, and the thread says so", async () => {
    await enqueueOne(notified(900));
    const rows = await outboundRows();
    await db.query(
      `INSERT INTO ops.suppression (id, site_id, contact_token, scope, consent_event_id, created_by, updated_by, source_mode)
       VALUES (gen_random_uuid(), $1, $2, 'ALL', gen_random_uuid(), 'test', 'test', 'SIMULATED')`,
      [scenario.siteId, scenario.contactToken],
    );
    const outcome = await drain(db, rows[0].id, {
      provider: new SimMessagingProvider(),
      authorizer: dbRecipientAuthorizer(db),
      clock: () => TEST_NOW,
    });
    expect(outcome).toBe("BLOCKED_EGRESS");

    const persona = await resolvePersona(db, { number: scenario.number, pepper: PEPPER, gateway: dbIdentityGateway(db, { pepper: PEPPER }) });
    const thread = await personaMessages(db, persona!);
    expect(thread.find((m) => m.direction === "OUT")!.reachedPhone).toBe(false);
  });
});

/**
 * "AUTO · DELIVERED" IS EARNED BY A ROW, NOT BY A FIXTURE (Veri's run-8 gate 4; Firia's gate 4).
 *
 * The §8 notice is the one text in this app that goes out with **nobody in the loop**: no
 * proposal, no card, no decision, no `ops.approval_request` row anywhere. That is what the label
 * claims, and `texts-screen.test.ts` already holds the claim at the screen's own level — over
 * hand-written bubbles, where `author: "AUTO"` is something the test said rather than something a
 * send proved.
 *
 * This is the other end of it: a crossing becomes a real queued row, the real sim provider sends
 * it, the real status callback lands, and the thread's own two functions read the label off that
 * row. Both halves of the label, each from its own column:
 *
 *  - **"Auto"** from `template_id` through the `auto-sends.ts` allow-list. Not from the absence of
 *    an approval row — an unknown template is not auto either — but the absence is asserted too,
 *    because it is the fact the label is a claim about.
 *  - **"Delivered"** from `state`, which is why the bubble is read twice: once after the send
 *    (Sent) and once after the provider's callback (Delivered). A label that was decoration would
 *    read the same both times.
 *
 * NOT held here, and worth a reader's attention: `runsOf` builds the meta line from the author
 * alone, so the *word* "Delivered" in it is not yet read off `state` — an auto text that ended
 * BLOCKED_EGRESS or FAILED would carry the same line. The bubble under it does carry the row's
 * real state and `reachedPhone` (the suite above drives the opted-out case), so the fact is on
 * the screen's view model; joining the two is a copy decision nobody has made yet.
 */
describe("the day's own notice, and the label the thread puts on it", () => {
  /** The suites' gateway: addressing and egress facts for the rows `seedAgentScenario` wrote. */
  const GATEWAY = testIdentityGateway({ pepper: PEPPER });
  const handlers: Handlers = { [SIM_STATUS_JOB_KIND]: simStatusHandler };

  /** The real provider, which renders the body, addresses the persona phone and arms the callback. */
  const sendStack = () => ({
    provider: new DbSimMessagingProvider(
      db,
      new VercelQueueScheduler(db, new FakeTransport(), () => TEST_NOW),
      {
        faults: new InMemorySimFaultStore(),
        clock: () => TEST_NOW,
        pepper: PEPPER,
        seed: "test-seed",
        gateway: GATEWAY,
      },
    ),
    authorizer: gatewayRecipientAuthorizer(GATEWAY),
    clock: () => TEST_NOW,
    timeoutMs: 500,
  });

  /** How many proposals a person was asked to decide for this to happen. */
  const approvalRows = async () =>
    Number(
      (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM ops.approval_request", []))
        .rows[0].n,
    );

  /** The family's thread, as the screen builds it: the read model, then `thread.ts`'s own mapping. */
  async function outboundBubble() {
    const persona = await resolvePersona(db, {
      number: scenario.number,
      pepper: PEPPER,
      gateway: dbIdentityGateway(db, { pepper: PEPPER }),
    });
    const bubbles = (await personaMessages(db, persona!)).map(bubbleOf);
    const out = bubbles.filter((b) => b.direction === "OUT");
    expect(out).toHaveLength(1);
    return { bubble: out[0], runs: runsOf(bubbles, demoDay().label) };
  }

  it("sends with no approval row anywhere, and the thread reads the label off that row", async () => {
    // The template is on the allow-list that decides the label, before any of this runs.
    expect(isAutoSend(etaNoticeTemplate("PM"))).toBe(true);

    expect(await enqueueOne(notified(900))).toMatchObject({ duplicate: false });
    const [row] = await outboundRows();
    expect(row.template_id).toBe("dropoff.late");
    expect(row.state).toBe("QUEUED");
    // Nobody approved it, because there was never anything to approve.
    expect(await approvalRows()).toBe(0);

    expect(await drain(db, row.id, sendStack())).toBe("SENT");

    // The author is the row's template, through the allow-list — and the delivery half is the
    // row's own state, which at this moment is Sent and not Delivered.
    const sent = await outboundBubble();
    expect(sent.bubble.author).toBe("AUTO");
    expect(sent.bubble.delivery).toEqual(outboundStates.SENT);
    expect(sent.bubble.reachedPhone).toBe(true);

    // The provider's status callback, as a durable job rather than a test writing DELIVERED.
    const job = (await db.query<{ id: string }>("SELECT id FROM ops.job WHERE key = $1", [
      `${SIM_STATUS_JOB_KIND}:${row.id}`,
    ])).rows[0];
    expect(await fire(db, job.id, "test", handlers, "LOCAL", () => new Date(TEST_NOW.getTime() + SIM_DELAY_MAX_MS))).toBe("fired");
    expect((await outboundRows())[0].state).toBe("DELIVERED");

    // Same bubble, read again: "Delivered" moved because the row moved.
    const delivered = await outboundBubble();
    expect(delivered.bubble.delivery).toEqual(outboundStates.DELIVERED);
    expect(delivered.bubble.author).toBe("AUTO");
    // And the meta line the thread draws under that run, still with no approval row behind it.
    expect(delivered.runs.filter((r) => r.side === "OUT").map((r) => r.meta)).toEqual([
      familyTexts.autoDelivered,
    ]);
    expect(await approvalRows()).toBe(0);
  });
});
