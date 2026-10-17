import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { formatWindow, windowFor } from "@/domain/eta/eta";
import {
  ASM14_THRESHOLDS,
  emptyGateState,
  evaluateStop,
  NOTIFY_SHIFT_SECONDS,
  type GateState,
  type NotificationDecision,
} from "@/domain/eta/notify-gate";
import type { StopEta } from "@/domain/eta/eta";
import { drain } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { SimMessagingProvider } from "@/modules/outbox/provider";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { seedAgentScenario, type AgentScenario } from "@/test/agent-state";
import { TEST_NOW } from "@/test/clock";
import { PEPPER } from "@/test/messaging";
import { freshDb } from "@/test/pglite";
import { personaMessages, resolvePersona } from "./mailbox";
import {
  ETA_NOTICE_NOT_AFTER_MS,
  LATE_SHIFT_ENV_VAR,
  enqueueEtaNotice,
  etaNoticeKey,
  etaNoticeTemplate,
  lateMinutesFor,
  loadEtaNoticeConfig,
  notifyThresholds,
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

describe("the configured threshold, not a hardcoded one", () => {
  it("falls back to ASM-14's ten minutes when nothing is configured", () => {
    expect(loadEtaNoticeConfig({}).lateShiftSeconds).toBe(NOTIFY_SHIFT_SECONDS);
    expect(notifyThresholds(loadEtaNoticeConfig({}))).toEqual(ASM14_THRESHOLDS);
  });

  it("reads the operator's threshold from the environment", () => {
    expect(loadEtaNoticeConfig({ [LATE_SHIFT_ENV_VAR]: "300" }).lateShiftSeconds).toBe(300);
  });

  it("keeps the documented default for a value nobody can have meant", () => {
    for (const value of ["0", "-600", "99999", "abc", ""]) {
      expect(loadEtaNoticeConfig({ [LATE_SHIFT_ENV_VAR]: value }).lateShiftSeconds, value).toBe(
        NOTIFY_SHIFT_SECONDS,
      );
    }
  });

  it("never lets an improvement be worth a text at a smaller shift than a delay", () => {
    const limits = notifyThresholds({ lateShiftSeconds: 1800 });
    expect(limits.improvementSeconds).toBeGreaterThanOrEqual(limits.shiftSeconds);
  });

  /**
   * The point of the knob: the *same* run of recalculations notifies at one threshold and stays
   * silent at the other. Driven through the real gate, so this is the rule it enforces and not a
   * restatement of the config object.
   */
  it("decides a 7-minute slip by the configured threshold and nothing else", () => {
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
    const run = (thresholds: ReturnType<typeof notifyThresholds>) => {
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
    expect(run(notifyThresholds({ lateShiftSeconds: NOTIFY_SHIFT_SECONDS }))).not.toContain("NOTIFY");
    expect(run(notifyThresholds({ lateShiftSeconds: 300 }))).toContain("NOTIFY");
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
    expect(rows[0].vars).toEqual({
      eta: "16:30",
      etaEnd: "16:40",
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

    const persona = await resolvePersona(db, { number: scenario.number, pepper: PEPPER });
    const thread = await personaMessages(db, persona!);
    const text = thread.find((m) => m.direction === "OUT")!;
    expect(text.reachedPhone).toBe(true);
    expect(text.body).toContain("running about 15 minutes late");
    expect(text.body).toContain("4:30–4:40 PM");
    expect(text.body).toContain("Okeeheelee Park");
    expect(text.body).toContain("[DEMO]");
    // Veri #12 / COPY-GUIDE §2: no child's name, no ride id, no threshold, no internal code.
    expect(text.body).not.toMatch(/Noah|Syn C\.|OKEE-PARK|16:30/);
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

    const persona = await resolvePersona(db, { number: scenario.number, pepper: PEPPER });
    const thread = await personaMessages(db, persona!);
    expect(thread.find((m) => m.direction === "OUT")!.reachedPhone).toBe(false);
  });
});
