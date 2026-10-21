import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { proposalWriter } from "@/modules/agent/run/exec/proposals";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { refusalWords } from "@/modules/changes/refusal";
import { childFirstName } from "@/modules/identity/display-name";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";
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

/**
 * A DIRECT CARD (PPE-110): the agent's own `save_plan` / `move_child` card, not a drafted re-plan.
 * Before, it carried no `basis_version`, so the clock rule judged it — and a person's save stamped
 * before the card's `created_at` let it come back. Now the card records the board it was written on.
 */
describe("a direct save_plan / move_child card written before somebody saved the leg (PPE-110)", () => {
  const directCard = async (tool: "save_plan" | "move_child", args: Record<string, unknown>) => {
    const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW), transport: new FakeOutboxTransport() };
    const out = await db.tx((tx) =>
      proposalWriter(execDeps)(tx, {
        runId: uuidv7(), callId: uuidv7(), siteId: SITE, seq: 1, tool, args,
        idempotencyKey: uuidv7(), approvalKey: `k-${tool}`, committed: [], trigger: { type: "msg.inbound", id: uuidv7() }, now: NOW,
      }),
    );
    return String(out.approval_request_id);
  };
  const proposalOf = async (id: string) =>
    (await db.query<{ args: Record<string, unknown> }>("SELECT proposal->'args' AS args FROM ops.approval_request WHERE id = $1", [id])).rows[0].args;
  /** A person moves one child on the board and saves: the leg moves on a version. */
  const personSaves = async () => {
    const view = await board();
    const [token, p] = Object.entries(view.plan).find(([, p]) => p.bucket === "VAN")!;
    const other = Object.values(view.plan).find((q) => q.bucket === "VAN" && q.vanId !== p.vanId)!.vanId;
    const moved = await ACTIONS.move_child.run(ctx(director, "DIRECTOR"), { date: DATE, direction: "PM", childToken: token, bucket: "VAN", vanId: other });
    expect(moved.status).toBe(200);
    // The save's stamp is its transaction's start: earlier than the card the agent wrote a moment before it committed.
    await db.query(
      "UPDATE ops.plan_run SET updated_at = now() - interval '1 hour' WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, DATE],
    );
  };

  for (const tool of ["save_plan", "move_child"] as const) {
    it(`${tool}: carries the board's version, is not offered once the board moves past it, and Approve is refused`, async () => {
      const view = await board();
      const [token, p] = Object.entries(view.plan).find(([, p]) => p.bucket === "VAN")!;
      const move = { child_token: token, bucket: "VAN", van_id: p.vanId };
      const args = tool === "save_plan" ? { date: DATE, leg: "PM", moves: [move] } : { date: DATE, leg: "PM", ...move };
      const card = await directCard(tool, args);
      expect((await proposalOf(card)).basis_version).toBe(view.version);
      expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(card);

      await personSaves();
      const saved = (await board()).version;
      expect(saved).toBe(view.version + 1);
      // By the clock the card is newer than the save; by version it is not, and version decides.
      expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).not.toContain(card);
      const pressed = await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW });
      expect(pressed.status).not.toBe(200);
      expect((await board()).version).toBe(saved);
    });
  }

  it("the model cannot name its own basis_version", async () => {
    const view = await board();
    const card = await directCard("save_plan", { date: DATE, leg: "PM", moves: [], basis_version: view.version + 50 });
    expect((await proposalOf(card)).basis_version).toBe(view.version);
  });
});

describe("a card whose basis_version is not a number (PPE-111)", () => {
  it("does not break the card list, and is not offered", async () => {
    const current = (await board()).version;
    /*
     * The two cards move different children, so each is a change of its own: the list now offers one
     * card per *change* (Vera), and two `save_plan` cards with the same arguments are the
     * same change however many runs wrote them.
     */
    const good = await writeStaffActionCard(db, {
      siteId: SITE, key: "good-card-111", by: "agent:good", tool: "save_plan", action: "save_plan",
      args: { date: DATE, leg: "PM", moves: [{ child_token: "c-good-111", bucket: "VAN", van_id: vanIdOfSlot(1) }], basis_version: current },
      summary: "Change the afternoon plan",
    });
    const bad = await writeStaffActionCard(db, {
      siteId: SITE, key: "bad-card-111", by: "agent:bad", tool: "save_plan", action: "save_plan",
      args: { date: DATE, leg: "PM", moves: [{ child_token: "c-bad-111", bucket: "VAN", van_id: vanIdOfSlot(1) }], basis_version: "not-a-version" },
      summary: "Change the afternoon plan",
    });
    const ids = (await confirmCards(db, SITE)).map((c) => c.approvalId);
    expect(ids).toContain(good);
    expect(ids).not.toContain(bad);
  });
});

/**
 * APPROVE RUNS THE LIST'S CHECK. An agent plan card the board has moved past — or one that
 * never named its board — is refused at Approve by id, and nothing is written. A person's own move
 * on the board needs no version.
 */
describe("Approve on an agent plan card the board moved past", () => {
  const vanChild = async () => {
    const view = await board();
    const [token, p] = Object.entries(view.plan).find(([, p]) => p.bucket === "VAN")!;
    const other = Object.values(view.plan).find((q) => q.bucket === "VAN" && q.vanId !== p.vanId)!.vanId!;
    return { view, token, other };
  };
  const personMoves = async () => {
    const { token, other } = await vanChild();
    // Straight on the board, no version: still saves.
    const moved = await ACTIONS.move_child.run(ctx(director, "DIRECTOR"), { date: DATE, direction: "PM", childToken: token, bucket: "VAN", vanId: other });
    expect(moved.status).toBe(200);
    await db.query(
      "UPDATE ops.plan_run SET updated_at = now() - interval '1 hour' WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, DATE],
    );
  };
  const nameOf = async (token: string) => [...(await board()).day.riders, ...(await board()).day.others].find((c) => c.token === token)!.name;

  it("refuses an old agent card with no basis_version after a newer save, with Vera's line and Plan routes", async () => {
    const { token, other } = await vanChild();
    const old = await writeStaffActionCard(db, {
      siteId: SITE, key: "old-no-version-112", by: "agent:old", tool: "move_child", action: "move_child",
      args: { date: DATE, leg: "PM", child_token: token, bucket: "VAN", van_id: other }, summary: "Move a child",
    });
    await personMoves();
    const saved = (await board()).version;
    const pressed = await confirmStaffAction(db, { userId: director, approvalId: old, decision: "APPROVED", now: NOW });
    expect(pressed.status).toBe(422);
    expect((await board()).version).toBe(saved);
    // What the coordinator sees: the child's name, a link to Plan routes, no version or code.
    const refusal = !pressed.body.ok ? pressed.body.refusal! : null;
    const words = refusalWords(refusal!);
    // The first name alone, from the one helper — never the board's "Noah O." with "'s" on it (Vera).
    const label = await nameOf(token);
    expect(words.says).toBe(`${childFirstName(label)}'s plan changed after this card was written.`);
    expect(words.says).not.toContain(label);
    expect(words.fix).toEqual({ label: "Open Plan routes", href: PLAN_ROUTES_PATH });
    expect(words.says).not.toMatch(/\d|STALE|version|422/i);
    // Still pending, never claimed.
    const left = await db.query<{ decided_at: Date | null }>("SELECT decided_at FROM ops.approval_request WHERE id = $1", [old]);
    expect(left.rows[0].decided_at).toBeNull();
  });

  it("refuses by id a card the list hides", async () => {
    const { view, token, other } = await vanChild();
    const card = await writeStaffActionCard(db, {
      siteId: SITE, key: "hidden-112", by: "agent:hidden", tool: "save_plan", action: "save_plan",
      args: { date: DATE, leg: "PM", moves: [{ child_token: token, bucket: "VAN", van_id: other }], basis_version: view.version }, summary: "Change the afternoon plan",
    });
    await personMoves();
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).not.toContain(card);
    const saved = (await board()).version;
    const pressed = await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW });
    expect(pressed.status).toBe(422);
    expect((await board()).version).toBe(saved);
  });

  it("still approves a fresh agent card that names the board as it stands", async () => {
    const { view, token, other } = await vanChild();
    const card = await writeStaffActionCard(db, {
      siteId: SITE, key: "fresh-112", by: "agent:fresh", tool: "move_child", action: "move_child",
      args: { date: DATE, leg: "PM", child_token: token, bucket: "VAN", van_id: other, basis_version: view.version }, summary: "Move a child",
    });
    const pressed = await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW });
    expect(pressed.status).toBe(200);
    expect((await board()).version).toBe(view.version + 1);
  });

  it("a person's own move on the board, with no version, still saves", async () => {
    const before = (await board()).version;
    await personMoves();
    expect((await board()).version).toBe(before + 1);
  });
});
