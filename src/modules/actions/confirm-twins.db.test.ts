import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { decideApproval } from "@/modules/approvals/decide";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { loadBoard } from "@/modules/plan/store";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { saveAutoPlan } from "@/test/save-plan";
import { confirmCards } from "./confirm-cards";
import { confirmStaffAction } from "./confirm";
import { actionDepsFor } from "./deps";
import { writeStaffActionCard } from "./draft";
import type { ActionCtx } from "./registry";

/**
 * ONE CHANGE, ONE PRESS (Athena, on #129). The list offers one card for two pending proposals of the
 * same change; the hidden twin must not be a second way in. Approving or declining the visible card
 * decides its twin with it, and a press on the twin by id — through `confirmStaffAction` or the
 * bubble's server action — is refused and writes nothing.
 */
let db: Db;
let close: () => Promise<void>;
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
let director = "";

const caller = vi.hoisted(() => ({ current: null as null | { kind: "STAFF"; userId: string; role: "DIRECTOR" } }));
const dbRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/auth/caller", () => ({ getCaller: async () => caller.current }));
vi.mock("@/db/exec", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/db/exec")>()), getNeonDb: () => dbRef.current }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ctx = (): ActionCtx => ({ siteId: SITE, caller: { userId: director, role: "DIRECTOR" }, now: NOW, deps: actionDepsFor(db, SITE) });
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source);

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  dbRef.current = db;
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  director = await seedStaff(db, "DIRECTOR", SITE);
  caller.current = { kind: "STAFF", userId: director, role: "DIRECTOR" };
  expect((await saveAutoPlan(ctx(), DATE, "PM")).status).toBe(200);
}, 180_000);
afterAll(async () => close());

async function aMove(nth: number) {
  const view = await board();
  const onVans = Object.entries(view.plan).filter(([, q]) => q.bucket === "VAN");
  const [token, p] = onVans[nth];
  const vans = [...new Set(Object.values(view.plan).filter((q) => q.bucket === "VAN").map((q) => q.vanId!))].filter((v) => v !== p.vanId);
  return { token, vans, version: view.version };
}
const card = (key: string, args: Record<string, unknown>) =>
  writeStaffActionCard(db, { siteId: SITE, key, by: `agent:${key}`, tool: "move_child", action: "move_child", args, summary: "Move a child" });
const moveArgs = (m: { token: string; version: number }, van: string, extra: Record<string, unknown> = {}) =>
  ({ date: DATE, leg: "PM", child_token: m.token, bucket: "VAN", van_id: van, basis_version: m.version, ...extra });

/** Everything a press could write: every card row, and the board's version. */
async function snapshot() {
  const rows = await db.query("SELECT id, decision, decided_at, version, proposal FROM ops.approval_request ORDER BY id", []);
  const tasks = await db.query("SELECT * FROM ops.task ORDER BY id", []);
  return JSON.stringify({ rows: rows.rows, tasks: tasks.rows, version: (await board()).version });
}

async function pressBubble(id: string, decision: "APPROVED" | "DECLINED") {
  const { confirmStaffActionAction } = await import("@/app/(app)/confirm/actions");
  const form = new FormData();
  form.set("card", id);
  form.set("decision", decision);
  return confirmStaffActionAction({ status: "idle" } as never, form);
}

describe.each(["APPROVED", "DECLINED"] as const)("deciding the visible card (%s)", (decision) => {
  it("decides its hidden twin with it, and a press on the twin by id is refused and writes nothing", async () => {
    const m = await aMove(decision === "APPROVED" ? 0 : 1);
    const visible = await card(`v-${decision}`, moveArgs(m, m.vans[0]));
    const twin = await card(`t-${decision}`, moveArgs(m, m.vans[0]));
    const ids = (await confirmCards(db, SITE)).map((c) => c.approvalId);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(twin);

    // The hidden twin cannot be pressed first, either.
    const before0 = await snapshot();
    expect((await confirmStaffAction(db, { userId: director, approvalId: twin, decision: "APPROVED", now: NOW })).status).toBe(404);
    expect(await snapshot()).toBe(before0);

    const r = await confirmStaffAction(db, { userId: director, approvalId: visible, decision, now: NOW });
    expect(r.status).toBe(200);
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).not.toContain(twin);

    const before = await snapshot();
    const direct = await confirmStaffAction(db, { userId: director, approvalId: twin, decision: "APPROVED", now: NOW });
    expect(direct.body.ok).toBe(false);
    expect(await snapshot()).toBe(before);

    const bubble = await pressBubble(twin, "APPROVED");
    expect(bubble.status).toBe("refused");
    expect(await snapshot()).toBe(before);

    // The family-texts decide path does not decide a confirm card at all.
    const panel = await decideApproval(db, new FakeOutboxTransport(), { userId: director, approvalId: twin, decision: "APPROVED", now: NOW } as never).catch((e: unknown) => ({ threw: String(e) }));
    expect((panel as { body?: { ok?: boolean } }).body?.ok ?? false).toBe(false);
    expect(await snapshot()).toBe(before);
  });
});

describe("the dedupe key", () => {
  it("merges only identical tool and arguments for the same day and plan", async () => {
    const m = await aMove(2);
    const base = await card("k-base", moveArgs(m, m.vans[0]));
    const otherVan = m.vans[1] ? await card("k-van", moveArgs(m, m.vans[1])) : null;
    const otherLeg = await card("k-leg", moveArgs(m, m.vans[0], { leg: "AM" }));
    const otherDay = await card("k-day", moveArgs(m, m.vans[0], { date: "2026-10-17" }));
    const otherBucket = await card("k-bucket", { ...moveArgs(m, m.vans[0]), bucket: "ABSENT", van_id: null });
    const otherChild = await card("k-child", { ...moveArgs(m, m.vans[0]), child_token: (await aMove(3)).token });
    const ids = (await confirmCards(db, SITE)).map((c) => c.approvalId);
    for (const id of [base, otherVan, otherLeg, otherDay, otherBucket, otherChild]) if (id) expect(ids).toContain(id);
  });
});
