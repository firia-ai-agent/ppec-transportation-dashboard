import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { windowFor } from "@/domain/eta/eta";
import type { NotificationDecision } from "@/domain/eta/notify-gate";
import { childByKey, stopByKey } from "@/modules/demo/fixtures/standard";
import { demoChildToken, demoLegId, seedStandardScenario } from "@/modules/demo/seed";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { freshDb, SITE } from "@/test/pglite";
import { sweepEtaNotices, type DueEtaNotice } from "./eta-notice";

/**
 * The drive (PRD §18.2 step 7): the one-minute sweep queues the demo day's own crossings against
 * the rows `demo reset` seeded, and does it once however often it runs.
 *
 * Seeded with the real standard scenario rather than a hand-made family, because the thing under
 * test is the join between a *fixture* child and an *operational* leg: the sweep is handed "C2's
 * afternoon" and has to find that child's seeded leg, its site, its plan version and the contacts
 * §6.4 authorizes — all of which only exist once the scenario has actually been seeded.
 */

const env = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "test-pepper", DATA_KEY: "test-data-key" };
/** A Tuesday 13:45 local, like the seed's own suite: "today" is a weekday the scenario runs on. */
const NOW = new Date("2026-10-13T17:45:00.000Z");

/** The child the afternoon stall reaches last, and so the family furthest downstream of it. */
const CHILD_KEY = "C2";

let pg: PGlite;
let db: Db;
let transport: FakeOutboxTransport;

beforeAll(async () => {
  ({ pg, db } = await freshDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env });
}, 180_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  transport = new FakeOutboxTransport();
  await db.query("DELETE FROM ops.outbound_message", []);
  await db.query("UPDATE ops.trip_leg SET state = 'SCHEDULED' WHERE id = $1", [demoLegId(CHILD_KEY, "PM")]);
});

/** The gate's decision for this child's afternoon drop-off, `lateSeconds` behind the plan. */
function due(lateSeconds = 900): DueEtaNotice {
  const child = childByKey(CHILD_KEY);
  const [hours, minutes] = child.pmWindow.split(":").map(Number);
  // The planned drop-off, as an instant on the seeded day (ET is UTC−4 in October).
  const plannedMs = Date.UTC(2026, 9, 13, hours + 4, minutes, 0);
  const window = windowFor(plannedMs + lateSeconds * 1000);
  const decision: NotificationDecision = {
    atMs: plannedMs - 30 * 60_000,
    stopId: child.stopKey!,
    familyLabel: child.familyKey,
    outcome: "NOTIFY",
    reason: "shift-persisted",
    shiftSeconds: lateSeconds,
    shiftText: "+15 min",
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    windowText: "4:30–4:40 PM",
  };
  return { decision, childKey: CHILD_KEY, direction: "PM", stopToken: stopByKey(child.stopKey!).smsToken };
}

const sweep = (overrides: Partial<Parameters<typeof sweepEtaNotices>[2]> = {}) =>
  sweepEtaNotices(db, transport, { due: [due()], now: NOW, env, ...overrides });

async function queued() {
  const r = await db.query<{
    template_id: string; recipient_token: string; child_token: string; trip_leg_id: string; site_id: string;
    vars: Record<string, unknown>; state: string;
  }>(
    "SELECT template_id, recipient_token, child_token, trip_leg_id, site_id, vars, state FROM ops.outbound_message ORDER BY created_at, id",
    [],
  );
  return r.rows;
}

describe("sweeping the demo day's crossings", () => {
  it("queues the afternoon text against the child's own seeded leg", async () => {
    expect(await sweep()).toEqual({ queued: 1, duplicates: 0, skipped: {} });

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0].template_id).toBe("dropoff.late");
    expect(rows[0].trip_leg_id).toBe(demoLegId(CHILD_KEY, "PM"));
    expect(rows[0].child_token).toBe(demoChildToken(CHILD_KEY));
    expect(rows[0].site_id).toBe(SITE);
    expect(rows[0].state).toBe("QUEUED");
    expect(rows[0].vars.stopLabel).toBe("OKEE-PARK");
    expect(rows[0].vars.delayMinutes).toBe(15);
  });

  it("writes nothing on every later sweep of the same crossing", async () => {
    await sweep();
    expect(await sweep()).toEqual({ queued: 0, duplicates: 1, skipped: {} });
    expect(await sweep()).toEqual({ queued: 0, duplicates: 1, skipped: {} });
    expect(await queued()).toHaveLength(1);
  });

  it("says nothing to a family whose ride was canceled", async () => {
    await db.query("UPDATE ops.trip_leg SET state = 'CANCELED_TRANSPORT' WHERE id = $1", [
      demoLegId(CHILD_KEY, "PM"),
    ]);
    expect(await sweep()).toEqual({ queued: 0, duplicates: 0, skipped: { "leg-not-ridable": 1 } });
    expect(await queued()).toHaveLength(0);
  });

  it("skips a ride the day does not have", async () => {
    const notSeeded: DueEtaNotice = { ...due(), childKey: "C28", direction: "AM" };
    await db.query("DELETE FROM ops.trip_leg WHERE id = $1", [demoLegId("C28", "AM")]);
    expect(await sweepEtaNotices(db, transport, { due: [notSeeded], now: NOW, env })).toEqual({
      queued: 0,
      duplicates: 0,
      skipped: { "no-leg": 1 },
    });
  });

  /**
   * ADR-015 and ADR-014, both: the crossings come from a committed replay of fixture vans, so on a
   * deployment that is not the synthetic demo there is no scenario to replay and a text derived
   * from one would be a message to a real family.
   */
  it("refuses outright unless this is the synthetic demo deployment", async () => {
    for (const off of [
      { APP_DATA_CLASS: "REAL", DEMO_MODE: "1" },
      { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "0" },
      { APP_DATA_CLASS: "SYNTHETIC" },
      {},
    ]) {
      expect(await sweep({ env: off }), JSON.stringify(off)).toEqual({ skipped: "not a demo deployment" });
    }
    expect(await queued()).toHaveLength(0);
  });
});
