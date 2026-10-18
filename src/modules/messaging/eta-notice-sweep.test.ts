import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { windowFor } from "@/domain/eta/eta";
import type { NotificationDecision } from "@/domain/eta/notify-gate";
import { demoDay, demoDayAtTick, demoDayTickAt } from "@/domain/board/day";
import { childByKey, demoChildToken, demoLegId, stopByKey } from "@/modules/demo/fixtures/standard";
import { dueEtaNotices } from "@/modules/demo/late-dropoff";
import { seedStandardScenario } from "@/modules/demo/seed";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { freshDb, SITE } from "@/test/pglite";
import { serviceDateIso } from "@/ui/service-date";
import { etaNoticeKey, sweepEtaNotices, type DueEtaNotice } from "./eta-notice";

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

/**
 * The scenario instant these tests sweep at, unless one of them says otherwise: late enough that
 * the hand-made crossing above has happened. The gate on `scenarioNow` is the subject of its own
 * block at the bottom of this file; everywhere else it is set out of the way so that the rest of
 * the suite keeps testing what it was written to test.
 */
const AFTER_THE_CROSSING = new Date(due().decision.atMs + 60_000);

const sweep = (overrides: Partial<Parameters<typeof sweepEtaNotices>[2]> = {}) =>
  sweepEtaNotices(db, transport, {
    due: [due()],
    now: NOW,
    scenarioNow: AFTER_THE_CROSSING,
    env,
    ...overrides,
  });

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
    expect(
      await sweepEtaNotices(db, transport, {
        due: [notSeeded],
        now: NOW,
        scenarioNow: AFTER_THE_CROSSING,
        env,
      }),
    ).toEqual({
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

/**
 * THE SCENARIO CLOCK DECIDES WHETHER A CROSSING HAS HAPPENED (Veri's review, demo item 4).
 *
 * The bug: the sweep queued every crossing the replay holds the first time it ran after a reset.
 * A reset rewinds the scenario clock to six in the morning, so one minute later a family's phone
 * held a text about an afternoon van that had not left the centre — the exact thing this feature
 * exists to get right, got wrong, in the first minute of the demo.
 *
 * These run against the **real projection** (`dueEtaNotices()`), not the hand-made decision above,
 * because the thing being asserted is about the demo day's own times: the afternoon stall's two
 * crossings both open at 4:08:54 PM scenario time, and the board's own instant is 7:42 AM.
 */
describe("a crossing is queued only once its time has passed on the scenario clock", () => {
  /** Noah, the family furthest downstream of the stall — the one text the demo is built around. */
  const NOAH = "C2";
  const noahsCrossing = () => dueEtaNotices().find((d) => d.childKey === NOAH)!;

  const sweepAt = (scenarioNow: Date) =>
    sweepEtaNotices(db, transport, { due: dueEtaNotices(), now: NOW, scenarioNow, env });

  const noahsRows = async () =>
    (await queued()).filter((r) => r.trip_leg_id === demoLegId(NOAH, "PM"));

  it("the projection really does put the crossing in the demo day's afternoon", () => {
    // If this ever stops being true the two tests below would pass vacuously, so it is checked.
    expect(noahsCrossing().decision.atMs).toBeGreaterThan(demoDay().instantMs);
    expect(noahsCrossing().decision.atMs).toBeLessThan(demoDayAtTick(demoDayTickAt("16:20")).instantMs);
  });

  it("says nothing before its time: not at the board's own instant, not at 4:00 PM", async () => {
    // The morning, which is where a reset leaves the clock. This is the first sweep after a reset.
    expect(await sweepAt(new Date(demoDay().instantMs))).toEqual({
      queued: 0,
      duplicates: 0,
      skipped: { "not-yet": dueEtaNotices().length },
    });
    expect(await noahsRows()).toHaveLength(0);

    // And still nothing eight minutes before the van's own crossing.
    expect(await sweepAt(new Date(demoDayAtTick(demoDayTickAt("16:00")).instantMs))).toMatchObject({
      queued: 0,
      skipped: { "not-yet": dueEtaNotices().length },
    });
    expect(await noahsRows()).toHaveLength(0);
  });

  it("queues it once its time has passed, and exactly once however often the sweep runs", async () => {
    const at420 = new Date(demoDayAtTick(demoDayTickAt("16:20")).instantMs);

    const first = await sweepAt(at420);
    expect(first).toMatchObject({ duplicates: 0 });
    expect("queued" in first && first.queued).toBeGreaterThan(0);
    const rows = await noahsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].template_id).toBe("dropoff.late");

    // The one-minute sweep runs again, and again. Still one text (the idempotency key).
    expect(await sweepAt(at420)).toMatchObject({ queued: 0 });
    expect(await sweepAt(new Date(demoDayAtTick(demoDayTickAt("17:00")).instantMs))).toMatchObject({ queued: 0 });
    expect(await noahsRows()).toHaveLength(1);
  });

  /**
   * The key carries the scenario date, so the same leg and the same window on the *next* demo day
   * is a different text rather than a duplicate silently dropped (Veri's S3 note). Asserted on the
   * key itself, because the row it would collide with is a day away.
   */
  it("keys the text by the scenario date as well as the window", () => {
    const window = noahsCrossing().decision.windowStartMs!;
    const leg = demoLegId(NOAH, "PM");
    const key = etaNoticeKey(leg, window);

    expect(key).toContain(serviceDateIso(new Date(window)));
    // The same window one day later is a different key, which is the whole point.
    expect(etaNoticeKey(leg, window + 24 * 3600_000)).not.toBe(key);
    // And it still collapses two sweeps of the same crossing onto one row.
    expect(etaNoticeKey(leg, window)).toBe(key);
  });
});
