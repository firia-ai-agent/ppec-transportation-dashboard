import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyGateConfig } from "@/config/live";
import type { Db } from "@/db/exec";
import { autoPlan, type BoardPlan } from "@/domain/plan/board";
import { minuteOfDay, plannedDropoffs } from "@/domain/plan/arrivals";
import { seedStandardScenario } from "@/modules/demo/seed";
import { renderTemplate } from "@/modules/messaging/templates";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { sqlDaySource } from "@/modules/roster/sql";
import { defaultsOfSlot, vanIdOfSlot } from "@/test/board-day";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { putVanSetupRequest, savePlanRequest } from "./api";
import { sendReplanLateNotices } from "./replan-notices";
import { sqlPlanStore } from "./sql";
import { loadBoard, type BoardView } from "./store";
import type { PlanStore } from "./types";

/**
 * THE FOUNDER'S AFTERNOON, IN ROWS (ledger #73): plan the day, a van arrives short at the ramp,
 * re-plan, Save — and the families that Save made late are texted how late, and when.
 *
 * Nothing here names a child or a minute. Who is told and what they read are asserted against the
 * estimator (`domain/plan/arrivals.ts`) over the two saved plans, so the test holds the rule and
 * the fixtures decide the numbers.
 */

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;
const outbox = new FakeOutboxTransport();

// 1:45 PM in the centre, so "today" is the seeded service date.
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const DIRECTOR = { userId: "", role: "DIRECTOR" as const };
const THRESHOLD = notifyGateConfig.shiftSeconds / 60;

const source = () => sqlDaySource(db, SITE);
const board = () => loadBoard(store, SITE, DATE, "PM", source());
const notify = (input: Parameters<typeof sendReplanLateNotices>[2]) => sendReplanLateNotices(db, outbox, input);

/** Auto-plan, pressed and saved, the way the board does it: the proposal goes out as planned moves. */
async function autoPlanAndSave(view: BoardView) {
  const planned: BoardPlan = autoPlan(view.day, view.plan);
  const moves = Object.entries(planned)
    .filter(([token, p]) => view.plan[token]?.bucket !== p.bucket || view.plan[token]?.vanId !== p.vanId)
    .map(([childToken, p]) => ({ childToken, bucket: p.bucket, vanId: p.vanId, planned: true }));
  const answer = await savePlanRequest(
    SITE, DIRECTOR, { date: DATE, direction: "PM", version: view.version, moves }, NOW, store, source(), notify,
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

const lateRows = async () =>
  (
    await db.query<{ child_token: string; vars: Record<string, unknown>; template_id: string }>(
      "SELECT child_token::text AS child_token, vars, template_id FROM ops.outbound_message WHERE template_id = 'dropoff.late_eta' ORDER BY created_at, id",
      [],
    )
  ).rows;

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW,
    siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
  store = sqlPlanStore(db);
  DIRECTOR.userId = await seedStaff(db, "DIRECTOR", SITE);
}, 180_000);

afterAll(async () => {
  await close();
});

describe("a saved re-plan texts the families it made late", () => {
  let before: BoardView;

  it("tells nobody on the day's first Save: there was no plan to be late against", async () => {
    await autoPlanAndSave(await board());
    expect(await lateRows()).toEqual([]);
    before = await board();
    // Auto-plan's placements are saved unpinned, so a re-plan is free to move them (§1.4).
    expect(Object.values(before.plan).filter((p) => p.bucket === "VAN").every((p) => !p.pinned)).toBe(true);
  });

  it("re-plans around Van 1 arriving without its wheelchair spot or lift, and texts who it made late", async () => {
    const vanOne = vanIdOfSlot(1);
    const confirmed = await putVanSetupRequest(
      SITE, DIRECTOR, vanOne,
      { date: DATE, ...defaultsOfSlot(1), wheelchairSpots: 0, hasLift: false, state: "CHECKED" },
      NOW, store,
    );
    expect(confirmed.status).toBe(200);

    await autoPlanAndSave(await board());
    const after = await board();

    // Who the rule says should be told, from the two saved plans and nothing else.
    const was = plannedDropoffs(before.day, before.plan);
    const now = plannedDropoffs(after.day, after.plan);
    const expected = after.day.riders.filter((rider) => {
      const a = now.get(rider.token);
      if (!a) return false;
      const late = a.arrivesAtMinute - minuteOfDay(rider.window)!;
      const later = a.arrivesAtMinute - (was.get(rider.token)?.arrivesAtMinute ?? Infinity);
      return late >= THRESHOLD && later >= THRESHOLD;
    });
    expect(expected.length, "the shortage makes somebody late").toBeGreaterThan(0);

    const rows = await lateRows();
    expect(new Set(rows.map((r) => r.child_token))).toEqual(new Set(expected.map((r) => r.token)));
    for (const row of rows) {
      const rider = after.day.riders.find((r) => r.token === row.child_token)!;
      const arrival = now.get(rider.token)!;
      const late = arrival.arrivesAtMinute - minuteOfDay(rider.window)!;
      // The minutes said are the minutes computed, in the 5-minute steps a family is told them in.
      expect(Math.abs(Number(row.vars.delayMinutes) - late)).toBeLessThanOrEqual(5);
      expect(Math.abs(minuteOfDay(String(row.vars.eta))! - arrival.arrivesAtMinute)).toBeLessThanOrEqual(2.5);
      // And it reads as a sentence about this child, with the new time in it.
      const body = renderTemplate(row.template_id, row.vars, { child: rider.name });
      expect(body).toContain(`${rider.name.split(" ")[0]}'s van home is running about ${row.vars.delayMinutes} minutes late`);
      expect(body).toMatch(/New drop-off about \d{1,2}:\d{2} (AM|PM) at /);
    }
  });

  it("does not text anybody twice for a Save that moves nobody", async () => {
    const count = (await lateRows()).length;
    const view = await board();
    const answer = await savePlanRequest(
      SITE, DIRECTOR, { date: DATE, direction: "PM", version: view.version, moves: [] }, NOW, store, source(), notify,
    );
    expect(answer.status).toBe(200);
    expect(await lateRows()).toHaveLength(count);
  });

  it("tells nobody about another day's plan", async () => {
    const view = await board();
    const report = await sendReplanLateNotices(db, outbox, {
      siteId: SITE, before: view, after: view, now: new Date("2026-10-20T17:45:00.000Z"), by: "test",
    });
    expect(report).toEqual({ queued: 0, skipped: { "not-today": 1 } });
  });
});
