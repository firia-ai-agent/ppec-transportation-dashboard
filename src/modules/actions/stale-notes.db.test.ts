import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { loadBoard } from "@/modules/plan/store";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { saveAutoPlan } from "@/test/save-plan";
import { PLAN_ROUTES_PATH } from "@/modules/plan/when";
import { confirmStaffAction } from "./confirm";
import { confirmCards } from "./confirm-cards";
import { actionDepsFor } from "./deps";
import { writeStaffActionCard } from "./draft";
import { ACTIONS, type ActionCtx } from "./registry";
import { clearStaleNote, staleNotes } from "./stale-notes";
import { readAgentThread } from "@/modules/agent/ask/thread";
import { confirmCopy } from "@/ui/copy";

/**
 * A STALE AGENT PLAN CARD DOES NOT VANISH (Vera, #124): it leaves a note on For you until the
 * coordinator dismisses it or opens Plan routes from it — and Approve on it is still a 422.
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

/** An agent move_child card on the board as it stands; then a person saves the leg past it. */
async function staleCard(key: string) {
  const view = await board();
  const [token, p] = Object.entries(view.plan).find(([, p]) => p.bucket === "VAN")!;
  const other = Object.values(view.plan).find((q) => q.bucket === "VAN" && q.vanId !== p.vanId)!.vanId;
  const card = await writeStaffActionCard(db, {
    siteId: SITE, key, by: "agent:run", tool: "move_child", action: "move_child",
    args: { date: DATE, leg: "PM", child_token: token, bucket: "VAN", van_id: other, basis_version: view.version }, summary: "Move a child",
  });
  expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(card);
  expect((await ACTIONS.move_child.run(ctx(), { date: DATE, direction: "PM", childToken: token, bucket: "VAN", vanId: other })).status).toBe(200);
  const name = [...view.day.riders, ...view.day.others].find((c) => c.token === token)!.name;
  return { card, name };
}

describe("a stale agent plan card on For you (Vera, #124)", () => {
  it("becomes a note — not an approvable card — and Approve on it is still 422", async () => {
    const { card, name } = await staleCard("note-a");
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).not.toContain(card);
    const notes = await staleNotes(db, SITE);
    expect(notes).toContainEqual({ approvalId: card, says: `${name}'s plan changed after this card was written.`, fix: { label: "Open Plan routes", href: PLAN_ROUTES_PATH } });
    const saved = (await board()).version;
    const pressed = await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW });
    expect(pressed.status).toBe(422);
    expect((await board()).version).toBe(saved);
    // A refused press does not clear the note.
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).toContain(card);
  });

  it("Dismiss removes the note; the card stays unapprovable", async () => {
    const { card } = await staleCard("note-b");
    expect(await clearStaleNote(db, { siteId: SITE, approvalId: card, userId: director, how: "DISMISSED", now: NOW })).toBe(true);
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).not.toContain(card);
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW })).status).toBe(422);
  });

  it("opening Plan routes from the note clears it", async () => {
    const { card } = await staleCard("note-c");
    expect(await clearStaleNote(db, { siteId: SITE, approvalId: card, userId: director, how: "OPENED_PLAN_ROUTES", now: NOW })).toBe(true);
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).not.toContain(card);
    const kept = await db.query<{ how: string }>("SELECT proposal->'stale_note_cleared'->>'how' AS how FROM ops.approval_request WHERE id = $1", [card]);
    expect(kept.rows[0].how).toBe("OPENED_PLAN_ROUTES");
  });

  it("never clears a live card, and nothing is left once every note is cleared", async () => {
    const view = await board();
    const live = await writeStaffActionCard(db, {
      siteId: SITE, key: "live-d", by: "agent:run", tool: "save_plan", action: "save_plan",
      args: { date: DATE, leg: "PM", moves: [], basis_version: view.version }, summary: "Change the afternoon plan",
    });
    expect(await clearStaleNote(db, { siteId: SITE, approvalId: live, userId: director, how: "DISMISSED", now: NOW })).toBe(false);
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(live);
    for (const n of await staleNotes(db, SITE)) await clearStaleNote(db, { siteId: SITE, approvalId: n.approvalId, userId: director, how: "DISMISSED", now: NOW });
    expect(await staleNotes(db, SITE)).toEqual([]);
  });
});

describe("the bubble's thread for a stale plan card (Vera, #124)", () => {
  const lineOf = async (id: string) => (await readAgentThread(db, SITE)).items.find((i) => "id" in i && i.id === `${id}:done`);

  it("a stale card nobody decided says the plan changed, with Open Plan routes — not 'Already handled'", async () => {
    const { card, name } = await staleCard("thread-a");
    expect(await lineOf(card)).toEqual({
      kind: "agent", id: `${card}:done`, text: `${name}'s plan changed after this card was written.`,
      link: { label: "Open Plan routes", href: PLAN_ROUTES_PATH },
    });
  });

  it("a card somebody decided keeps its decided line, and 'Already handled' when none was recorded", async () => {
    const { card } = await staleCard("thread-b");
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "DECLINED", now: NOW })).status).toBe(200);
    expect(await lineOf(card)).toMatchObject({ text: confirmCopy.declined });
    expect(await lineOf(card)).not.toHaveProperty("link");
    await db.query("UPDATE ops.approval_request SET proposal = proposal - 'outcome' WHERE id = $1", [card]);
    expect(await lineOf(card)).toMatchObject({ text: confirmCopy.alreadyHandled });
  });
});
