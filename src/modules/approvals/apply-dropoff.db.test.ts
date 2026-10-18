/**
 * **APPROVE REALLY CHANGES THE PLAN** — Firia's 11:11 AM ET ruling of 2026-10-18, against the real
 * migrations on PGlite.
 *
 * `plan-placement.test.ts` next door holds the half that existed already: an approved change saves
 * a new `plan_run` version through the board's own writer. What it also held, until this ruling,
 * was that the decision wrote *nothing else* — and that was the gap. The time the family had just
 * been promised lived only in the words of the text; a coordinator who pressed Approve and walked
 * to Today read the old window back.
 *
 * So this suite is about the other two rows the decision now writes, and about the fact that it
 * writes them **in the same transaction as the placement and the text**:
 *
 *  1. **the agreed time**, onto `ops.trip_leg.window_start` for that leg and no other — 17:00 at
 *     the centre, which is an instant, so it is asserted as the instant that wall clock falls on;
 *  2. **the adult who will receive the child**, as the §6.4 `RECEIVE_CHILD` row the rest of the app
 *     reads that permission from — which is what clears Noah O.'s "no adult to receive" hold;
 *  3. **nothing at all** when the decision is "Don't send", and **nothing at all** when any step
 *     refuses: not the placement, not the time, not the receiver, not the text.
 *
 * And one more, because a demo that cannot be restarted is not a demo: a reset puts both rows back
 * to their seeded values and the proposal back to pending. `ops.trip_leg` and
 * `ops.contact_authorization` are both already in `RESET_TABLES` *and* in `SEEDED_TABLES`
 * (`demo/seed.ts`), so the contract is that truncate-and-reseed is enough — this is the test that
 * says so rather than assuming it.
 *
 * Noah O. (C2) throughout, not the any-van child the placement suite uses, because he is the one
 * the ruling is about: F2 holds every scope except `RECEIVE_CHILD` (`NO_RECEIVER_SCOPES`), he rides
 * Van 2 in the afternoon, and his 16:20 window is the one a parent asked to move to 17:00.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { decideApproval } from "@/modules/approvals/decide";
import {
  boardPlacementPort,
  type PlanPlacementPortFor,
} from "@/modules/approvals/plan-placement-port";
import { KIND, childTokenOf, demoId, demoLegId, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { setChildPlacement } from "@/modules/plan/place";
import { siteInstantOn } from "@/modules/plan/leg-write";
import { legFactsForBoard } from "@/modules/plan/leg-facts";
import { sqlPlanStore, sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";

/** The seeded scenario's own day: the clock starts it, which is what the board requires. */
const NOW = new Date("2026-10-16T17:45:00.000Z");
const SERVICE_DATE = "2026-10-16";
/** Noah O.: the wheelchair rider on Van 2 whose afternoon ends on the AT-13 hold. */
const CHILD_KEY = "C2";
const childToken = () => childTokenOf(CHILD_KEY);
const legId = () => demoLegId(CHILD_KEY, "PM");
const vanTwo = () => vehicleIdOf("V2");
/** The time the family asked for, as the proposal carries it and as the centre's clock reads it. */
const AGREED = "17:00";
/** F2's guardian contact, as the seed writes it (`seed.ts contactId`): the second family. */
const DARA_CONTACT = () => demoId(KIND.contact, 2);

const SEED_ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };

let db: Db;
let close: () => Promise<void>;
let coordinator: string;
let transport: FakeOutboxTransport;

/** The real board, over the decision's own transaction — the writer the plan-routes board uses. */
const board = (): PlanPlacementPortFor =>
  boardPlacementPort({
    store: (tx) => sqlPlanStoreIn(tx),
    source: (tx, siteId) => sqlDaySource(tx, siteId),
  });

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: SEED_ENV });
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
}, 180_000);

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  transport = new FakeOutboxTransport();
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
  await db.query("DELETE FROM ops.outbound_message", []);
  await db.query("DELETE FROM ops.approval_request", []);
  await db.query("DELETE FROM ops.task", []);
  // An approval records Noah's receiver on his file and his leg; put both back to the seeded hold,
  // or the next case starts with the hold already cleared by the one before it.
  await db.query(
    "DELETE FROM ops.contact_authorization WHERE site_id = $1 AND child_token = $2 AND scope = 'RECEIVE_CHILD'",
    [SITE, childToken()],
  );
  await db.query("UPDATE ops.trip_leg SET receiver_confirmed_at = NULL WHERE id = $1", [legId()]);
}, 60_000);

/** A saved plan with Noah in the van he already rides, as a coordinator's Save leaves it. */
async function savedPlanWithNoahOnVanTwo(): Promise<number> {
  const before = await loadBoard(sqlPlanStore(db), SITE, SERVICE_DATE, "PM", sqlDaySource(db, SITE));
  expect(before.started, "the seeded scenario clock starts this day").toBe(true);
  const saved = await setChildPlacement(
    {
      siteId: SITE,
      serviceDate: SERVICE_DATE,
      direction: "PM",
      childToken: childToken(),
      bucket: "VAN",
      vehicleId: vanTwo(),
      expectedVersion: before.version,
      actor: null,
      now: NOW,
    },
    sqlPlanStore(db),
    sqlDaySource(db, SITE),
  );
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  return saved.ok ? saved.version : 0;
}

/** One undecided drop-off proposal for Noah's afternoon. */
async function seedProposal(over: { time?: string | null } = {}): Promise<string> {
  const basis = (await planRunVersion()) ?? 0;
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, 'PLAN_CHANGE', 'AMBER', 'OPEN', 'A family asked for a different drop-off',
       'Read the text, then decide', 'the drop-off approved or declined', 'test', 'test', 'SIMULATED')`,
    [taskId, SITE],
  );
  const id = uuidv7();
  await db.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'SIMULATED')`,
    [
      id,
      SITE,
      taskId,
      JSON.stringify({
        kind: DROPOFF_CHANGE_KIND,
        leg_id: legId(),
        child_token: childToken(),
        service_date: SERVICE_DATE,
        direction: "PM",
        plan_run_version_basis: basis,
        requested_dropoff_time: over.time === undefined ? AGREED : over.time,
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        // Dara, F2's guardian: the adult whose text this answers, and the receiver Approve records.
        requested_by_contact: DARA_CONTACT(),
        template_id: "dropoff.changed",
        vars: { legDate: SERVICE_DATE, eta: AGREED, stopLabel: "OKEE-PARK" },
        approval_key: "a-key",
      }),
    ],
  );
  return id;
}

const decide = (approvalId: string, decision: "APPROVED" | "DECLINED", placement: PlanPlacementPortFor) =>
  decideApproval(
    db,
    transport,
    { userId: coordinator, approvalId, decision, now: NOW },
    { placement },
  );

const planRunVersion = async (direction = "PM") =>
  (
    await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = $3",
      [SITE, SERVICE_DATE, direction],
    )
  ).rows[0]?.version ?? null;

const outbox = async () =>
  (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;

/** The two columns a decision now writes on the leg, and the counter it must not. */
const legRow = async (id = legId()) =>
  (
    await db.query<{
      window_start: Date | string | null;
      receiver_confirmed_at: Date | string | null;
      plan_version: number;
    }>(
      "SELECT window_start, receiver_confirmed_at, plan_version FROM ops.trip_leg WHERE id = $1",
      [id],
    )
  ).rows[0];

/** Whether this child's file holds an adult who may receive them (§6.4) — the hold, read back. */
const receiversOnFile = async () =>
  (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.contact_authorization
        WHERE site_id = $1 AND child_token = $2 AND scope = 'RECEIVE_CHILD'`,
      [SITE, childToken()],
    )
  ).rows[0].n;

describe("Approve writes the agreed drop-off onto the leg", () => {
  it("moves window_start to 17:00 at the centre, bumps plan_run.version once, and texts the family", async () => {
    const started = await savedPlanWithNoahOnVanTwo();
    const before = await legRow();
    const id = await seedProposal();

    const answer = await decide(id, "APPROVED", board());
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200 });

    // The time, as the instant 17:00 at the centre falls on — 21:00Z in October (EDT).
    const expected = siteInstantOn(SERVICE_DATE, AGREED);
    expect(expected?.toISOString()).toBe("2026-10-16T21:00:00.000Z");
    const after = await legRow();
    expect(new Date(after.window_start!).toISOString()).toBe(expected!.toISOString());
    // And it really moved: the seed wrote his scheduled 16:20 there.
    expect(new Date(before.window_start!).toISOString()).not.toBe(expected!.toISOString());

    // The plan version moves exactly once, on `plan_run` — never on the leg's own counter, which
    // is what the outbox compares a queued text's basis to at drain (Veri S1-3.2).
    expect(await planRunVersion()).toBe(started + 1);
    expect(after.plan_version).toBe(before.plan_version);

    // The decision is one transaction: the text went with the write.
    expect(answer.body.ok && answer.body.queued).toBeGreaterThan(0);
    expect((await outbox()).length).toBeGreaterThan(0);
  });

  it("clears the 'no adult to receive' hold by recording the family's guardian as receiver", async () => {
    await savedPlanWithNoahOnVanTwo();
    expect(await receiversOnFile(), "F2 holds every scope but this one").toBe(0);
    const id = await seedProposal();

    expect((await decide(id, "APPROVED", board())).status).toBe(200);

    // The hold is derived from the file, so clearing it is a row in the file (§6.4) — plus the
    // handoff column on the leg the decision is about (§6.3).
    expect(await receiversOnFile()).toBe(1);
    expect((await legRow()).receiver_confirmed_at).not.toBeNull();
    // And the board reads both back for the screen a coordinator opens next.
    const facts = await legFactsForBoard(SITE, SERVICE_DATE, db);
    expect(facts.PM?.[CHILD_KEY]).toMatchObject({ dropoffTime: AGREED, receiverOnFile: true });
  });

  it("moves that leg and no other: the morning is untouched", async () => {
    await savedPlanWithNoahOnVanTwo();
    const amBefore = await legRow(demoLegId(CHILD_KEY, "AM"));
    expect((await decide(await seedProposal(), "APPROVED", board())).status).toBe(200);
    expect(await legRow(demoLegId(CHILD_KEY, "AM"))).toEqual(amBefore);
  });
});

describe("Don't send changes nothing", () => {
  it("leaves the leg, the receiver file and the plan exactly as they were, and queues no text", async () => {
    const started = await savedPlanWithNoahOnVanTwo();
    const before = await legRow();
    const id = await seedProposal();

    const answer = await decide(id, "DECLINED", board());
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200 });

    expect(await legRow()).toEqual(before);
    expect(await receiversOnFile()).toBe(0);
    expect(await planRunVersion()).toBe(started);
    expect(await outbox()).toEqual([]);
  });
});

describe("a refusal rolls the whole decision back", () => {
  /** A port whose placement write says no, as the board does when the plan moved under it. */
  const refusing = (): PlanPlacementPortFor => {
    const real = board();
    return (tx) => {
      const port = real(tx);
      return { ...port, setChildPlacement: async () => ({ ok: false, reason: "REFUSED" }) };
    };
  };

  it("a placement the plan will not take leaves no time, no receiver and no text", async () => {
    await savedPlanWithNoahOnVanTwo();
    const before = await legRow();
    const id = await seedProposal();

    const answer = await decide(id, "APPROVED", refusing());
    expect(answer.status).toBe(503);
    expect(answer.body.ok === false && answer.body.error).toBe("PLAN_NOT_SAVED");

    expect(await legRow()).toEqual(before);
    expect(await receiversOnFile()).toBe(0);
    expect(await outbox()).toEqual([]);
    // Still pending: the card the coordinator is looking at has not been decided.
    const row = await db.query<{ decision: string | null }>(
      "SELECT decision FROM ops.approval_request WHERE id = $1",
      [id],
    );
    expect(row.rows[0].decision).toBeNull();
  });

  it("a proposal whose time is not a time is TIME_NOT_SAVED, and nothing is sent", async () => {
    await savedPlanWithNoahOnVanTwo();
    const before = await legRow();
    const id = await seedProposal({ time: "25:99" });

    const answer = await decide(id, "APPROVED", board());
    expect(answer.status).toBe(503);
    expect(answer.body.ok === false && answer.body.error).toBe("TIME_NOT_SAVED");

    expect(await legRow()).toEqual(before);
    expect(await outbox()).toEqual([]);
  });
});

describe("Restart demo day puts the plan back", () => {
  it("re-seeds the leg's window and the receiver file, and leaves no card for the model to have written", async () => {
    // The seeded day, read off a fresh seed: earlier cases in this file moved the leg already.
    await seedStandardScenario(db, { now: NOW, siteId: SITE, env: SEED_ENV });
    const seeded = await legRow();
    const seededReceivers = await receiversOnFile();
    await savedPlanWithNoahOnVanTwo();
    const id = await seedProposal();
    expect((await decide(id, "APPROVED", board())).status).toBe(200);
    expect(await receiversOnFile()).toBe(seededReceivers + 1);

    /*
     * The reset's own contract: `ops.trip_leg` and `ops.contact_authorization` are both in
     * `RESET_TABLES` and in `SEEDED_TABLES`, so one truncate-and-reseed is the whole of it — no
     * column is restored by hand and nothing is dropped or migrated.
     */
    await seedStandardScenario(db, { now: NOW, siteId: SITE, env: SEED_ENV });

    expect(await legRow()).toEqual(seeded);
    expect(await receiversOnFile()).toBe(seededReceivers);
    // And the decided card is gone with the day. Restart writes no card of its own (founder,
    // 2026-10-18): the next one is the model's, proposed from Dara's text when it arrives
    // (`demo/inbound-script.ts`), so a fresh day starts with nothing waiting.
    const rows = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.approval_request WHERE site_id = $1",
      [SITE],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
