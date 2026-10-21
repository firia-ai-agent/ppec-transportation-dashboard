import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { loadBoard } from "@/modules/plan/store";
import { seedSecondSite, seedStaff, SITE_B } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { saveAutoPlan } from "@/test/save-plan";
import { childFirstName } from "@/modules/identity/display-name";
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
 * A STALE AGENT PLAN CARD DOES NOT VANISH (Vera): it leaves a note on For you until the
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
  // The board's label is "Noah O."; every stale-card sentence says the first name alone (Vera).
  return { card, name, first: childFirstName(name) };
}

describe("a stale agent plan card on For you (Vera)", () => {
  it("becomes a note — not an approvable card — and Approve on it is still 422", async () => {
    const { card, name, first } = await staleCard("note-a");
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).not.toContain(card);
    const notes = await staleNotes(db, SITE);
    expect(first).not.toBe(name);
    expect(notes.find((n) => n.approvalId === card)).toMatchObject({ says: `${first}'s plan changed after this card was written.`, fix: { label: "Open Plan routes", href: PLAN_ROUTES_PATH } });
    // The card keeps its own bold line, the move in names, and the note goes inside it.
    expect(notes.find((n) => n.approvalId === card)!.title).toMatch(new RegExp(`^Move ${first} to .+, afternoon\\.$`));
    // …and never the stored label with its initial glued to a possessive ("Noah O.'s plan changed").
    expect(notes.map((n) => n.says)).not.toContain(`${name}'s plan changed after this card was written.`);
    const saved = (await board()).version;
    const pressed = await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW });
    expect(pressed.status).toBe(422);
    expect((await board()).version).toBe(saved);
    // A refused press does not clear the note.
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).toContain(card);
  });

  it("Dismiss removes the note; the card stays unapprovable", async () => {
    const { card } = await staleCard("note-b");
    expect(await clearStaleNote(db, { approvalId: card, userId: director, how: "DISMISSED", now: NOW })).toBe(true);
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).not.toContain(card);
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW })).status).toBe(422);
  });

  it("opening Plan routes from the note clears it", async () => {
    const { card } = await staleCard("note-c");
    expect(await clearStaleNote(db, { approvalId: card, userId: director, how: "OPENED_PLAN_ROUTES", now: NOW })).toBe(true);
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
    expect(await clearStaleNote(db, { approvalId: live, userId: director, how: "DISMISSED", now: NOW })).toBe(false);
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(live);
    for (const n of await staleNotes(db, SITE)) await clearStaleNote(db, { approvalId: n.approvalId, userId: director, how: "DISMISSED", now: NOW });
    expect(await staleNotes(db, SITE)).toEqual([]);
  });
});

describe("the bubble's thread for a stale plan card (Vera)", () => {
  const lineOf = async (id: string) => (await readAgentThread(db, SITE)).items.find((i) => "id" in i && i.id === `${id}:done`);

  it("a stale card nobody decided leaves no separate line: its note is inside its own card (Vera)", async () => {
    const { card } = await staleCard("thread-a");
    expect(await lineOf(card)).toBeUndefined();
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).toContain(card);
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

/**
 * WHO MAY CLEAR A NOTE: Dismiss and Open Plan routes are refused, and write nothing, for
 * another centre's coordinator, a card already decided, the front desk, and a family.
 */
describe("clearing a stale card's note is refused for the wrong caller or card", () => {
  const HOWS = ["DISMISSED", "OPENED_PLAN_ROUTES"] as const;
  const proposalOf = async (id: string) =>
    (await db.query<{ p: unknown }>("SELECT proposal AS p FROM ops.approval_request WHERE id = $1", [id])).rows[0].p;
  const refusedFor = async (card: string, userId: string | undefined) => {
    const before = await proposalOf(card);
    for (const how of HOWS) expect(await clearStaleNote(db, { approvalId: card, userId, how, now: NOW })).toBe(false);
    expect(await proposalOf(card)).toEqual(before);
  };

  it("another centre's coordinator", async () => {
    await seedSecondSite(db);
    const elsewhere = await seedStaff(db, "COORDINATOR", SITE_B);
    const { card } = await staleCard("ppe114-site");
    await refusedFor(card, elsewhere);
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).toContain(card);
  });

  it("a card that was already decided", async () => {
    const { card } = await staleCard("ppe114-decided");
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "DECLINED", now: NOW })).status).toBe(200);
    await refusedFor(card, director);
  });

  it("a front-desk caller", async () => {
    const frontDesk = await seedStaff(db, "FRONT_DESK", SITE);
    const { card } = await staleCard("ppe114-frontdesk");
    await refusedFor(card, frontDesk);
  });

  it("a family caller (signed in, no staff role)", async () => {
    const family = await seedStaff(db, "COORDINATOR", null);
    const { card } = await staleCard("ppe114-family");
    await refusedFor(card, family);
    await refusedFor(card, undefined);
  });
});

/**
 * A STALE CARD WITH A LIVE CARD FOR THE SAME CHANGE (Vera). The live card is the answer, so the
 * stale one is not shown at all — a read, nothing written by looking. Pressing the stale one by id
 * is still refused (422 on Approve) and never decides the live one; deciding the live one clears
 * the stale one's note in the same press, so it does not resurface.
 */
describe("a stale card whose change has a live card waiting", () => {
  async function staleWithLiveTwin(key: string) {
    const stale = await staleCard(`${key}-old`);
    const old = (await db.query<{ args: Record<string, unknown> }>("SELECT proposal->'args' AS args FROM ops.approval_request WHERE id = $1", [stale.card])).rows[0].args;
    const live = await writeStaffActionCard(db, {
      siteId: SITE, key: `${key}-new`, by: "agent:run", tool: "move_child", action: "move_child",
      args: { ...old, basis_version: (await board()).version }, summary: "Move a child",
    });
    return { ...stale, live };
  }
  const rowOf = async (id: string) =>
    (await db.query<{ decided_at: Date | null; proposal: Record<string, unknown> }>("SELECT decided_at, proposal FROM ops.approval_request WHERE id = $1", [id])).rows[0];

  it("is not shown on For you or in the bubble, and reading it writes nothing", async () => {
    const { card, live } = await staleWithLiveTwin("twin-a");
    const before = await rowOf(card);
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).not.toContain(card);
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(live);
    expect(await rowOf(card)).toEqual(before);
  });

  it("a press on the stale one by id writes nothing and never decides the live one", async () => {
    const { card, live } = await staleWithLiveTwin("twin-b");
    const saved = (await board()).version;
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW })).status).toBe(422);
    expect((await board()).version).toBe(saved);
    expect((await rowOf(card)).decided_at).toBeNull();
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "DECLINED", now: NOW })).status).toBe(200);
    expect((await rowOf(live)).decided_at).toBeNull();
    expect((await confirmCards(db, SITE)).map((c) => c.approvalId)).toContain(live);
  });

  it("deciding the live card clears the stale one's note, so it never resurfaces", async () => {
    const { card, live } = await staleWithLiveTwin("twin-c");
    expect((await confirmStaffAction(db, { userId: director, approvalId: live, decision: "DECLINED", now: NOW })).status).toBe(200);
    expect((await staleNotes(db, SITE)).map((n) => n.approvalId)).not.toContain(card);
    expect((await rowOf(card)).proposal.stale_note_cleared).toMatchObject({ how: "SUPERSEDED" });
    expect((await confirmStaffAction(db, { userId: director, approvalId: card, decision: "APPROVED", now: NOW })).status).toBe(422);
  });
});
