/**
 * THE DEMO DAY'S CARD IS A REAL APPROVAL ROW, DRAFTED BY THE MODEL — Firia's S1-2 (2026-10-17
 * 11:00 PM ET: "Demo data seeds real approval rows via the demo adapter … not UI fixtures") as
 * amended by the 11:04 AM ET ruling of 2026-10-18: the reply on it is **the model's own words**,
 * not the fixed `dropoff.changed` sentence the founder's complaint was about.
 *
 * So the writer under test moved. `seedStandardScenario` writes the day and **no card**, and
 * `draftDemoProposal` writes the card afterwards — outside the seed's transaction, from the real
 * agent turn over the parent's real text, with a timeout and a copy fallback. The suite drives it
 * with an **injected fake provider**: no network in a test, and the script is the same shape the
 * live model's answer has (`providers/fake.toolCall`).
 *
 * Everything the row had to be is unchanged, and is still asserted below: one undecided
 * `DROPOFF_CHANGE` row that `pendingApprovals` reads, a leg that exists, the child's own stop, the
 * board's counter as the basis, one row and not two after a Restart, and a decision that saves the
 * plan through the board and queues the family's text.
 *
 * On PGlite over the real migrations, because the claim is about *rows*: that
 * `seedStandardScenario` leaves an `ops.approval_request` the screen's own query reads back, with
 * the shape `decideApproval` can act on, under the real constraints (`task_id` is NOT NULL with an
 * FK to `ops.task`; `proposal` is the one jsonb column every `propose_*` tool shares).
 *
 * Four things it holds:
 *
 *  1. the seed writes exactly one undecided `DROPOFF_CHANGE` row, and `pendingApprovals` — the
 *     query behind the For you badge and the card — returns it;
 *  2. the row names a leg that exists, a child the day has, and the stop the roster gives that
 *     child, so nothing on the card is reconstructed from an id scheme;
 *  3. `plan_run_version_basis` is the board's counter read at seed time (`0` on a day with no
 *     saved plan), read the way `propose_dropoff_change` reads it rather than chosen — see below;
 *  4. re-seeding is "Restart demo day": one row again, not two.
 *
 * ## The basis is recorded, and the row stays decidable either way
 *
 * The seed writes no `plan_run` (§9.1: the map stays locked until the ramp is confirmed), so the
 * board's counter is `0` and that is what the row records. On a freshly restarted day approving
 * writes `plan_run` version 1 through `setChildPlacement` and queues the family's text, which is
 * the demo's own path and the last suite below. And after somebody has saved a plan it does the
 * same thing against the version the plan then holds: Firia's PR #75 ruling removed the
 * plan-version check from `decideApproval`, so the demo's own next step — staff pressing Auto-plan
 * and Save — no longer turns the one seeded card into a `409` nobody can clear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { decideApproval, pendingApprovals } from "@/modules/approvals/decide";
import {
  boardPlacementPort,
  type PlanPlacementPortFor,
} from "@/modules/approvals/plan-placement-port";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { setChildPlacement } from "@/modules/plan/place";
import { sqlPlanStore, sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { VANS } from "@/config/vans";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { fakeProvider, toolCall } from "@/modules/agent/providers/fake";
import { seedDemoChangeRequest } from "./approval-seed";
import { draftDemoProposal, fallbackReply } from "./draft-proposal";
import { demoChangeRequests } from "./change-request";
import { DROPOFF_REPLY_TEMPLATE } from "@/modules/approvals/dropoff-change";
import { demoDay } from "@/domain/board/day";
import { childByKey, childTokenOf, stopByKey, vehicleIdOf } from "./fixtures/standard";
import { seedStandardScenario } from "./seed";

const NOW = new Date("2026-10-16T17:45:00.000Z");
const SERVICE_DATE = "2026-10-16";
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };

let db: Db;
let close: () => Promise<void>;
let coordinator: string;

const board = (): PlanPlacementPortFor =>
  boardPlacementPort({
    store: (tx) => sqlPlanStoreIn(tx),
    source: (tx, siteId) => sqlDaySource(tx, siteId),
  });

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
}, 180_000);

afterAll(async () => {
  await close();
});

/**
 * The reply the scripted model writes: warm, short, the five o'clock Dara asked for, both first
 * names, no codes and no `PPEC:` prefix — the shape `messaging/reply-text.ts` enforces.
 */
const MODEL_REPLY = "Hi Dara, yes, we'll drop Noah off at 5 today. Thanks for letting us know!";

/**
 * A scripted `propose_dropoff_change`, as the live model answers it. The arguments are the demo
 * day's own: the fixture leg token the turn's scope carries, the time the script asks for, and the
 * reply. No network — `demoAgentTurn` is handed this provider instead of the configured one.
 */
const scriptedModel = () =>
  fakeProvider([
    toolCall("propose_dropoff_change", {
      /*
       * The fixture token the turn's own scope carries (`demoAgentTurn` builds its scope from the
       * roster, not from the database), which is what the policy engine checks. The row's leg is
       * read back from the seeded rows by the writer, never off the model's argument.
       */
      leg_id: `L-${request().childKey}-PM`,
      requested_dropoff_time: request().requestedHhmm,
      requested_stop_token: null,
      rationale_code: "PARENT_REQUEST",
      reply: MODEL_REPLY,
      source_message_id: `M-${childByKey(request().childKey)!.familyKey}-1`,
      expected_version: 1,
    }),
  ]);

/** Seed the day, then draft its one card the way the reset route and the screen both do. */
const seedAndDraft = async (provider = scriptedModel()) => {
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  return draftDemoProposal(db, {
    siteId: SITE,
    serviceDate: SERVICE_DATE,
    day: demoDay(),
    env: ENV,
    now: NOW,
    provider,
  });
};

beforeEach(async () => {
  await seedAndDraft();
}, 120_000);

/** The one change request the day has — the request the seeded row is about. */
const request = () => demoChangeRequests()[0];

describe("the seed writes the day and the model writes the card (Firia 11:04 AM ET)", () => {
  it("leaves no proposal of its own: a model call is never in the reset's transaction", async () => {
    /*
     * The whole reason the drafting is a step of its own. Restart must finish whatever the vendor
     * is doing, so the seed commits the day with no card on it — and this is the assertion that
     * keeps a model call from drifting back into that transaction.
     */
    await db.query("DELETE FROM ops.approval_request WHERE site_id = $1", [SITE]);
    await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
  });

  it("drafts the card from the model's own reply, which is what Approve would send", async () => {
    const pending = await pendingApprovals(db, [SITE]);
    expect(pending).toHaveLength(1);
    // The model's sentence, word for word, through the renderer the card and the outbox share.
    expect(pending[0].text).toBe(MODEL_REPLY);
    expect(pending[0].templateId).toBe(DROPOFF_REPLY_TEMPLATE);
    // It answers what she asked — the five o'clock — and carries neither a code nor the prefix.
    expect(pending[0].text).toContain("5");
    expect(pending[0].text).not.toContain("PPEC:");
    const proposal = await proposalJson();
    expect(proposal.reply_text).toBe(MODEL_REPLY);
  });

  it("falls back to the improved copy reply when no model answers, and still writes one card", async () => {
    await db.query("DELETE FROM ops.approval_request WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.task WHERE site_id = $1 AND category = 'PLAN_CHANGE'", [SITE]);
    /*
     * A provider whose script is empty throws on the first call — which stands for every way the
     * model can fail: no key, a refused chain, a rate limit, a timeout. The card is drafted from
     * copy, it names the parent, the child and the time she asked for, and there is exactly one.
     */
    const drafted = await draftDemoProposal(db, {
      siteId: SITE,
      serviceDate: SERVICE_DATE,
      day: demoDay(),
      env: ENV,
      now: NOW,
      provider: fakeProvider([]),
    });
    expect(drafted.modelWritten).toBe(false);
    const pending = await pendingApprovals(db, [SITE]);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe(fallbackReply(request()));
    expect(pending[0].text).toContain(request().childFirstName);
    expect(pending[0].text).toContain(request().guardianName.split(" ")[0]);
    expect(pending[0].text).toContain(request().timeTo);
  });

  it("drafts once: a second load finds the card and calls no model at all", async () => {
    const provider = scriptedModel();
    const again = await draftDemoProposal(db, {
      siteId: SITE,
      serviceDate: SERVICE_DATE,
      day: demoDay(),
      env: ENV,
      now: NOW,
      provider,
    });
    expect(again.alreadyDrafted).toBe(true);
    expect(provider.calls).toEqual([]);
    expect(await pendingApprovals(db, [SITE])).toHaveLength(1);
  });
});

describe("the drafted row is the shape the screen and the decision both read (S1-2)", () => {
  it("writes exactly one undecided DROPOFF_CHANGE row, and the screen's query reads it", async () => {
    const rows = await db.query<{ id: string; kind: string; n: string }>(
      `SELECT id, proposal ->> 'kind' AS kind, count(*) OVER ()::text AS n
       FROM ops.approval_request WHERE site_id = $1 AND decided_at IS NULL`,
      [SITE],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].kind).toBe(DROPOFF_CHANGE_KIND);
    expect(rows.rows[0].id).toBe(request().approvalId);

    // `pendingApprovals` is the one query the badge and the card both come from (queue.ts).
    const pending = await pendingApprovals(db, [SITE]);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(request().approvalId);
    // The child, named off `ops.child_profile` by the query's own join.
    expect(pending[0].childLabel).toBe(childByKey(request().childKey)!.label);
    expect(pending[0].childToken).toBe(childTokenOf(request().childKey));
    expect(pending[0].requestedTime).toBe(request().requestedHhmm);
    // The words come from the row's template and vars through the outbox's own renderer.
    expect(pending[0].templateId).toBe(DROPOFF_REPLY_TEMPLATE);
    // The child is in the sentence by their first name — written there by the model, which is
    // what the ruling asks for ("uses the parent's and child's first names").
    expect(pending[0].text).toContain(childByKey(request().childKey)!.firstName);
    // `created_at` is readable, which is the card's "Agent · …" line.
    expect(pending[0].draftedAtMs).toBeGreaterThan(0);
  });

  it("names a leg that exists, and the stop the roster gives that child", async () => {
    const proposal = await proposalJson();
    const leg = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.trip_leg WHERE id = $1 AND site_id = $2 AND direction = 'PM'",
      [proposal.leg_id, SITE],
    );
    expect(leg.rows[0].n).toBe(1);
    expect(proposal.child_token).toBe(childTokenOf(request().childKey));
    expect(proposal.service_date).toBe(SERVICE_DATE);
    expect(proposal.stop_token).toBe(stopByKey(childByKey(request().childKey)!.stopKey!).smsToken);
    // A code, never prose (tools.ts `DROPOFF_CHANGE_REASON_CODES`).
    expect(proposal.rationale_code).toBe("PARENT_REQUEST");
    // And the task it hangs off is a real OPEN row, which the NOT NULL FK requires.
    const task = await db.query<{ state: string }>(
      "SELECT state FROM ops.task WHERE id = (SELECT task_id FROM ops.approval_request WHERE id = $1)",
      [request().approvalId],
    );
    expect(task.rows[0].state).toBe("OPEN");
  });

  it("records plan_run.version as the basis — 0 on a day with no saved plan", async () => {
    const proposal = await proposalJson();
    expect(proposal.plan_run_version_basis).toBe(0);
    const plan = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.plan_run WHERE site_id = $1 AND service_date = $2",
      [SITE, SERVICE_DATE],
    );
    expect(plan.rows[0].n).toBe(0);
  });

  it("re-seeds rather than stacking: Restart demo day leaves one row, not two", async () => {
    await seedAndDraft();
    const again = await pendingApprovals(db, [SITE]);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(request().approvalId);
  });

  it("writes nothing when the leg it would name is not in this database", async () => {
    await db.query("DELETE FROM ops.approval_request WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.task WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.manifest_reservation WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.trip_leg WHERE site_id = $1", [SITE]);
    const wrote = await db.tx((tx) =>
      seedDemoChangeRequest(tx, { siteId: SITE, serviceDate: SERVICE_DATE, replyText: MODEL_REPLY }),
    );
    expect(wrote).toBeNull();
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
  });
});

describe("the seeded proposal is a real decision, before and after a plan is saved", () => {
  it("APPROVES on a fresh day: the plan is saved through the board and the family is queued", async () => {
    /*
     * This is the demo's own path. A restarted day has no `plan_run`, so the board's counter is
     * `0` — which is the basis the seed recorded, because it read the same counter the same way.
     * `setChildPlacement` writes version 1 with the child in the van the day already has them in,
     * and the text is queued through the outbox.
     */
    const transport = new FakeOutboxTransport();
    const r = await decideApproval(
      db,
      transport,
      { userId: coordinator, approvalId: request().approvalId, decision: "APPROVED", now: NOW },
      { placement: board() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // One plan write, through the board's own writer, inside the approval's transaction (S1-3).
    const plan = await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, SERVICE_DATE],
    );
    expect(plan.rows[0].version).toBe(1);
    // Decided, and the family's text is in the outbox rather than sent from here.
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
    expect(await queuedCount()).toBeGreaterThan(0);
  });

  it("still APPROVES once a plan has been saved, against the version the plan then holds (PR #75)", async () => {
    const before = await loadBoard(sqlPlanStore(db), SITE, SERVICE_DATE, "PM", sqlDaySource(db, SITE));
    expect(before.started, "the seeded clock starts this day").toBe(true);
    const saved = await setChildPlacement(
      {
        siteId: SITE,
        serviceDate: SERVICE_DATE,
        direction: "PM",
        childToken: childTokenOf(request().childKey),
        bucket: "VAN",
        vehicleId: vehicleIdOf(VANS[0].vehicleKey),
        expectedVersion: before.version,
        actor: null,
        now: NOW,
      },
      sqlPlanStore(db),
      sqlDaySource(db, SITE),
    );
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const transport = new FakeOutboxTransport();
    const r = await decideApproval(
      db,
      transport,
      { userId: coordinator, approvalId: request().approvalId, decision: "APPROVED", now: NOW },
      { placement: board() },
    );
    /*
     * This is the demo's actual order of operations — seed, then Auto-plan + Save, then decide the
     * card — and it used to be a `409 PLAN_MOVED` here. Firia's PR #75: the basis is not checked.
     * The decision reads the plan it is about to write and is guarded on that read, so the save
     * above becomes the version this write builds on.
     */
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
    expect(await queuedCount()).toBeGreaterThan(0);
    const after = await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, SERVICE_DATE],
    );
    expect(after.rows[0].version).toBe(saved.ok ? saved.version + 1 : -1);
  });
});

async function proposalJson(): Promise<Record<string, string | number | null>> {
  const r = await db.query<{ proposal: Record<string, string | number | null> }>(
    "SELECT proposal FROM ops.approval_request WHERE id = $1",
    [request().approvalId],
  );
  return r.rows[0].proposal;
}

async function queuedCount(): Promise<number> {
  const r = await db.query<{ n: number }>(
    "SELECT count(*)::int n FROM ops.outbound_message WHERE site_id = $1",
    [SITE],
  );
  return r.rows[0].n;
}
