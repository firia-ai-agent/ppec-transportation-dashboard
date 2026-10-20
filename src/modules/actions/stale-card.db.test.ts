import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { vansOver } from "@/modules/plan/place";
import { loadBoard } from "@/modules/plan/store";
import { defaultsOfSlot, vanIdOfSlot } from "@/test/board-day";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { saveAutoPlan } from "@/test/save-plan";
import { confirmStaffAction } from "./confirm";
import { confirmCards } from "./confirm-cards";
import { actionDepsFor } from "./deps";
import { writeStaffActionCard } from "./draft";
import { ACTIONS, type ActionCtx } from "./registry";

/**
 * THE CARD THAT CAME BACK (ledger #86). Van 1 short; a person approves a re-plan; an agent run that
 * read the board while that save was still committing writes its own card a moment later. A save's
 * `updated_at` is its transaction's *start*, so by the clock the late card looked newer than the save
 * and was offered again. By version it is plainly older — and pressing it must not re-plan over the save.
 */
let db: Db;
let close: () => Promise<void>;
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
let director = "";
let frontDesk = "";

const ctx = (userId: string, role: ActionCtx["caller"]["role"]): ActionCtx => ({
  siteId: SITE, caller: { userId, role }, now: NOW, deps: actionDepsFor(db, SITE),
});
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source);

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  director = await seedStaff(db, "DIRECTOR", SITE);
  frontDesk = await seedStaff(db, "FRONT_DESK", SITE);
  expect((await saveAutoPlan(ctx(director, "DIRECTOR"), DATE, "PM")).status).toBe(200);
  const short = { ...defaultsOfSlot(1), seats: 2, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const };
  expect((await ACTIONS.confirm_van_setup.run(ctx(frontDesk, "FRONT_DESK"), short)).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await close();
});

describe("a plan card drafted on a board somebody has since saved past (ledger #86)", () => {
  it("is not offered again, even when its clock says it came after the save", async () => {
    // The person's re-plan, approved: Van 1 fits and the leg moves on a version.
    const drafted = await ACTIONS.auto_plan.run(ctx(director, "DIRECTOR"), { date: DATE, direction: "PM" });
    expect(drafted.status).toBe(200);
    const [mine] = await confirmCards(db, SITE);
    const basis = (await board()).version;
    expect((await confirmStaffAction(db, { userId: director, approvalId: mine.approvalId, decision: "APPROVED", now: NOW })).status).toBe(200);
    const after = await board();
    expect(after.version).toBe(basis + 1);
    expect(vansOver(after, after.plan)).toEqual([]);

    // The save's stamp is its transaction's start; the late card is written after it, on the old board.
    await db.query(
      "UPDATE ops.plan_run SET updated_at = now() - interval '5 seconds' WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, DATE],
    );
    const lateMoves = Object.entries(after.plan)
      .filter(([, p]) => p.bucket === "VAN" && p.vanId !== vanIdOfSlot(1))
      .slice(0, 1)
      .map(([token]) => ({ childToken: token, bucket: "VAN", vanId: vanIdOfSlot(1), planned: true }));
    const late = await writeStaffActionCard(db, {
      siteId: SITE, key: "late-agent-card", by: "agent:race", tool: "save_plan", action: "save_plan",
      args: { date: DATE, leg: "PM", moves: lateMoves, basis_version: basis }, summary: "Re-plan the afternoon",
    });

    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).not.toContain(late);

    // And if somebody pressed it anyway, the board refuses it rather than re-planning over the save.
    const pressed = await confirmStaffAction(db, { userId: director, approvalId: late, decision: "APPROVED", now: NOW });
    expect(pressed.status).not.toBe(200);
    expect((await board()).version).toBe(basis + 1);
  });

  it("still offers a card drafted on the board as it stands", async () => {
    const current = (await board()).version;
    const fresh = await writeStaffActionCard(db, {
      siteId: SITE, key: "fresh-card", by: "agent:fresh", tool: "save_plan", action: "save_plan",
      args: { date: DATE, leg: "PM", moves: [], basis_version: current }, summary: "Change the afternoon plan",
    });
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(fresh);
  });
});
