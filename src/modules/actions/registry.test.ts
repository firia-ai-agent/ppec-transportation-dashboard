import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Forbidden, SiteNotFound } from "@/auth/core";
import type { Db } from "@/db/exec";
import { autoPlan, emptyPlan } from "@/domain/plan/board";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { dayDataSource, loadBoard, planStore } from "@/modules/plan/store";
import { ACTIONS, authorize, runAction, type ActionCtx } from "./registry";

/**
 * WHO MAY (S4) and THE SAME ACTION EITHER WAY (S6), for the action layer the agent acts through.
 *
 * Authorization is the action's own access row plus the person's membership read from the database
 * (`requireSiteAccess`), so a front desk may confirm a van at the ramp but may not re-plan, exactly
 * as the screens allow. And an action run through the registry is the screen's own function: Auto-
 * plan here ends where the board's Auto-plan + Save ends.
 */
let db: Db;
let close: () => Promise<void>;
const people: Record<"DIRECTOR" | "COORDINATOR" | "FRONT_DESK", string> = { DIRECTOR: "", COORDINATOR: "", FRONT_DESK: "" };
let stranger = "";

const ctx = (role: keyof typeof people, siteId = SITE): ActionCtx => ({
  siteId,
  caller: { userId: people[role], role },
  now: new Date("2026-10-16T17:45:00.000Z"),
});

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  for (const role of Object.keys(people) as (keyof typeof people)[]) people[role] = await seedStaff(db, role, SITE);
  stranger = await seedStaff(db, "DIRECTOR", null);
}, 120_000);

afterAll(async () => {
  await close();
});

describe("the agent can only do what the asker's role can (S4)", () => {
  it("lets a director and a coordinator re-plan, and refuses the front desk", async () => {
    await expect(authorize(db, ctx("DIRECTOR"), ACTIONS.auto_plan)).resolves.toBeUndefined();
    await expect(authorize(db, ctx("COORDINATOR"), ACTIONS.auto_plan)).resolves.toBeUndefined();
    await expect(authorize(db, ctx("FRONT_DESK"), ACTIONS.auto_plan)).rejects.toBeInstanceOf(Forbidden);
  });

  it("lets the front desk confirm a van at the ramp, as the ramp screen does", async () => {
    await expect(authorize(db, ctx("FRONT_DESK"), ACTIONS.confirm_van_setup)).resolves.toBeUndefined();
  });

  it("keeps Restart the director's", async () => {
    await expect(authorize(db, ctx("DIRECTOR"), ACTIONS.restart_demo_day)).resolves.toBeUndefined();
    await expect(authorize(db, ctx("COORDINATOR"), ACTIONS.restart_demo_day)).rejects.toBeInstanceOf(Forbidden);
  });

  it("answers another centre with not-found, never forbidden", async () => {
    const elsewhere = { ...ctx("DIRECTOR"), caller: { userId: stranger, role: "DIRECTOR" as const } };
    await expect(authorize(db, elsewhere, ACTIONS.auto_plan)).rejects.toBeInstanceOf(SiteNotFound);
  });

  it("marks exactly the three PRD-prohibited actions as needing a person's press", () => {
    const confirm = Object.values(ACTIONS).filter((a) => a.confirm).map((a) => a.name).sort();
    expect(confirm).toEqual(["decide_approval", "restart_demo_day", "set_child_needs"]);
  });
});

describe("an action run through the registry is the screen's own (S6)", () => {
  it("Auto-plan saves the plan the board's Auto-plan would have saved", async () => {
    const date = "2026-10-16";
    const before = await loadBoard(planStore(), SITE, date, "PM", dayDataSource(SITE));
    const expected = autoPlan(before.day, before.version === 0 ? emptyPlan(before.day) : before.plan);
    const answer = await ACTIONS.auto_plan.run(ctx("DIRECTOR"), { date, direction: "PM" });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const after = await loadBoard(planStore(), SITE, date, "PM", dayDataSource(SITE));
    for (const [token, p] of Object.entries(expected)) {
      expect([after.plan[token]?.bucket, after.plan[token]?.vanId], token).toEqual([p.bucket, p.vanId]);
    }
    expect(after.version).toBe(before.version + 1);
  });

  it("refuses input the screen's schema refuses, before anything runs", async () => {
    expect(await runAction("auto_plan", ctx("DIRECTOR"), { date: "tomorrow", direction: "PM" })).toEqual({
      status: 400,
      body: { ok: false, reason: "BAD_INPUT" },
    });
  });
});
