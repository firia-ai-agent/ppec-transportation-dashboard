import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { loadBoard } from "@/modules/plan/store";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { saveAutoPlan } from "@/test/save-plan";
import { childFirstName } from "@/modules/identity/display-name";
import { actionSummaries } from "@/ui/copy";
import { confirmCards } from "./confirm-cards";
import { actionDepsFor } from "./deps";
import { writeStaffActionCard } from "./draft";
import type { ActionCtx } from "./registry";

/**
 * WHAT A "CONFIRM A CHANGE" CARD SAYS, AND HOW MANY OF IT THERE ARE (Vera).
 *
 * Two findings on For you, from the same staged move (`../local-demo/stage-b.ts`):
 *
 *  1. the card read "Move a child on the afternoon plan and save it." — a change the coordinator is
 *     asked to approve without being told who or where. The card's own stored arguments hold the
 *     child token and the vehicle id, so the line is built from them against the board the card is
 *     about: "Move Noah to Van 3 on the afternoon plan and save it.";
 *  2. there were **two identical cards**. `stage-b.ts stage` writes a proposal per run, each under
 *     its own `approval_key`, and its cleanup only deletes rows `created_by = 'agent:local-shot'`
 *     while the proposal writer stamps `agent:<runId>` — so a second staging run leaves the first
 *     card in place and adds an identical one. Same tool, same arguments: one change, so the list
 *     offers one card.
 *
 * Both are read-side: no row is written, merged or decided here.
 */
let db: Db;
let close: () => Promise<void>;
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
let director = "";
const ctx = (): ActionCtx => ({ siteId: SITE, caller: { userId: director, role: "DIRECTOR" }, now: NOW, deps: actionDepsFor(db, SITE) });
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source);

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  director = await seedStaff(db, "DIRECTOR", SITE);
  expect((await saveAutoPlan(ctx(), DATE, "PM")).status).toBe(200);
}, 180_000);
afterAll(async () => close());

/**
 * One child on a van this afternoon, and another van to move them to — the staged move's shape.
 *
 * `nth` picks a different child per test on purpose: the cards written here all live in one
 * database for the file, and the whole point of the second half of it is that two cards naming the
 * same change are one card. A test that wants its own card has to name its own change.
 */
async function aMove(nth = 0) {
  const view = await board();
  const onVans = Object.entries(view.plan).filter(([, q]) => q.bucket === "VAN");
  expect(onVans.length).toBeGreaterThan(nth);
  const [token, p] = onVans[nth];
  const other = Object.values(view.plan).find((q) => q.bucket === "VAN" && q.vanId !== p.vanId)!.vanId!;
  const label = [...view.day.riders, ...view.day.others].find((c) => c.token === token)!.name;
  const vanName = view.day.vans.find((v) => v.id === other)!.name;
  return { view, token, other, first: childFirstName(label), label, vanName };
}

/** An agent's move card, as the proposal writer leaves it: the stored summary names nobody. */
const moveCard = async (key: string, move: { token: string; van: string; version: number }) =>
  writeStaffActionCard(db, {
    siteId: SITE, key, by: `agent:${key}`, tool: "move_child", action: "move_child",
    args: { date: DATE, leg: "PM", child_token: move.token, bucket: "VAN", van_id: move.van, basis_version: move.version },
    summary: "Move a child on the afternoon plan and save it.",
  });

describe("the card says what it would change", () => {
  it("names the child's first name and the van, off the board the card is about", async () => {
    const { token, other, first, label, vanName, view } = await aMove(0);
    const card = await moveCard("line-a", { token, van: other, version: view.version });
    const shown = (await confirmCards(db, SITE)).find((c) => c.approvalId === card)!;
    expect(shown.summary).toBe(`Move ${first} to ${vanName} on the afternoon plan and save it.`);
    // Not the stored line the writer left, and not the staff label with its initial.
    expect(shown.summary).not.toBe(actionSummaries.moveChild.replace("{leg}", "afternoon"));
    expect(shown.summary).not.toContain(label);
    // And never a token or an id on screen.
    expect(shown.summary).not.toContain(token);
    expect(shown.summary).not.toContain(other);
  });

  it("falls back to the plain line for a child the board cannot name", async () => {
    const { other, view } = await aMove(1);
    const card = await moveCard("line-b", { token: "c-nobody", van: other, version: view.version });
    const shown = (await confirmCards(db, SITE)).find((c) => c.approvalId === card)!;
    expect(shown.summary).toBe(actionSummaries.moveChild.replace("{leg}", "afternoon"));
  });

  it("puts the card's own verb on Don't", async () => {
    const { token, other, view } = await aMove(2);
    const card = await moveCard("line-c", { token, van: other, version: view.version });
    expect((await confirmCards(db, SITE)).find((c) => c.approvalId === card)!.decline).toBe("Don't move");
  });
});

describe("two cards for one change are one card", () => {
  it("offers the first of two identical move cards and not the second", async () => {
    const { token, other, view } = await aMove(3);
    const first = await moveCard("dup-1", { token, van: other, version: view.version });
    const second = await moveCard("dup-2", { token, van: other, version: view.version });
    const ids = (await confirmCards(db, SITE)).map((c) => c.approvalId);
    expect(ids).toContain(first);
    expect(ids).not.toContain(second);
    // Neither row is touched: the duplicate is still pending, it is simply not offered twice.
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM ops.approval_request WHERE id = ANY($1::uuid[]) AND decided_at IS NULL",
      [[first, second]],
    );
    expect(rows.rows).toHaveLength(2);
  });

  it("collapses them however they were stamped, and whatever board each named", async () => {
    const { token, other, view } = await aMove(4);
    // Different boards named, same change: `basis_version` says which board a card was written
    // against, never what it does, so it is left out of the key.
    const a = await moveCard("basis-1", { token, van: other, version: view.version });
    const b = await moveCard("basis-2", { token, van: other, version: view.version + 5 });
    const offered = (await confirmCards(db, SITE)).filter((c) => [a, b].includes(c.approvalId));
    expect(offered).toHaveLength(1);
    expect(offered[0].approvalId).toBe(a);
  });

  it("keeps two cards that would do different things", async () => {
    const { view, token } = await aMove(5);
    const vans = [...new Set(Object.values(view.plan).filter((p) => p.bucket === "VAN").map((p) => p.vanId!))];
    expect(vans.length).toBeGreaterThan(1);
    const a = await moveCard("diff-1", { token, van: vans[0], version: view.version });
    const b = await moveCard("diff-2", { token, van: vans[1], version: view.version });
    const ids = (await confirmCards(db, SITE)).map((c) => c.approvalId);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});
