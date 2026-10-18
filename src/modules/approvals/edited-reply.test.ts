/**
 * **PPE-97: THE COORDINATOR REWRITES THE DRAFT, AND APPROVE SENDS EXACTLY WHAT THEY WROTE** —
 * founder's ruling of 2026-10-18.
 *
 * The card on Family texts (mockups/family-texts.html, and the same card drawn inside
 * mockups/agent-bubble.html) carried a drafted reply a person could read and send, or send with a
 * different time, and nothing else. It is now prose they can rewrite: the whole sentence is a
 * field, and "Approve & send" sends the words in that field — not the agent's, not a merge of the
 * two.
 *
 * The ruling's conditions, and this file is each of them in turn:
 *
 *  1. **the same safety refusals and the 320-character cap run on the edited text, SERVER-SIDE,
 *     inside the Approvals decision function.** `replyTextIssue` — the one shape a model's reply
 *     has always been held to (`messaging/reply-text.ts`: no phone number, no link, no address,
 *     no internal code, no `PPEC:` prefix, no line break, `REPLY_TEXT_MAX`) — runs in
 *     `decideApproval`, before anything is claimed. A `<textarea>` is a field on a page: a check
 *     in the component is a courtesy and a check in the action is a check a different caller
 *     skips, so the rule lives beside the decision it guards.
 *  2. **the edit + Approve press IS the approval.** There is no store-the-draft step: the words
 *     arrive with the decision, in one POST, through the one write path. So a refusal here leaves
 *     the proposal **PENDING** and the family untexted, which is what the refusal suites below
 *     assert on the rows.
 *  3. **the plan line stays built from the proposal, not from the draft.** Rewriting the sentence
 *     moves the ride the proposal asked for — the time, the placement — and a rewritten sentence
 *     that moved a different ride would be the worst outcome available here.
 *  4. **no new column.** The edited sentence rides to the family as `vars.replyText` on
 *     `dropoff.reply`, the existing prose var on the existing template, through the existing
 *     `ops.outbound_message.vars` — so the outbox's own var rule re-checks it at enqueue and the
 *     renderer re-checks it at drain. Nothing is stored on `ops.approval_request`.
 *
 * Over PGlite with the real migrations and the real board (`plan-placement.test.ts`'s own wiring),
 * because every claim here is about **rows**: what is in the outbox, what the plan holds, and
 * whether a decision was claimed at all. The board-delegating fakes are from that file too — a
 * port that delegates every call to the real board and counts the one being asked about, which is
 * how "the refusal never reached the plan" is a fact rather than an inference.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { VANS } from "@/config/vans";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND, DROPOFF_CHANGE_TEMPLATE, DROPOFF_REPLY_TEMPLATE } from "@/modules/approvals/dropoff-change";
import { decideApproval, editableReply } from "@/modules/approvals/decide";
import {
  boardPlacementPort,
  type PlanPlacementPortFor,
} from "@/modules/approvals/plan-placement-port";
import { REPLY_TEXT_MAX } from "@/modules/messaging/reply-text";
import { renderTemplate } from "@/modules/messaging/templates";
import { childTokenOf, demoLegId, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { setChildPlacement } from "@/modules/plan/place";
import { sqlPlanStore, sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";

/** The seeded scenario's own day: the clock starts it, which is what the board requires. */
const NOW = new Date("2026-10-16T17:45:00.000Z");
const SERVICE_DATE = "2026-10-16";
/** Theo V. (C8) rides the afternoon and needs nothing, so he fits in any van. */
const CHILD_KEY = "C8";
const childToken = () => childTokenOf(CHILD_KEY);
const legId = () => demoLegId(CHILD_KEY, "PM");
const vanOne = () => vehicleIdOf(VANS[0].vehicleKey);

/** The sentence the model drafted, as `propose_dropoff_change` stores it. */
const DRAFTED = "Hi Dara, yes, we'll drop Theo off at 5 today. Thanks for letting us know!";
/** And the sentence a coordinator writes over it: their own words, names and all. */
const REWRITTEN = "Hi Dara — 5 works, and Theo will be with Maria at the park door. See you then.";

let db: Db;
let close: () => Promise<void>;
let coordinator: string;
let transport: FakeOutboxTransport;

/** The real board, over the decision's own transaction (`plan-placement.test.ts`). */
const board = (): PlanPlacementPortFor =>
  boardPlacementPort({
    store: (tx) => sqlPlanStoreIn(tx),
    source: (tx, siteId) => sqlDaySource(tx, siteId),
  });

/**
 * The same board, with a count of the one call the refusal suites are about.
 *
 * Every method delegates — this is the real writer, reading and writing where the decision does —
 * so a test that asserts `placements === 0` is asserting that the decision never got as far as the
 * plan, not that a stub was never called.
 */
function countingBoard(): { port: PlanPlacementPortFor; calls: () => number } {
  let placements = 0;
  const port: PlanPlacementPortFor = (tx) => ({
    currentPlacement: board()(tx).currentPlacement,
    setDropoffWindow: board()(tx).setDropoffWindow,
    recordReceiver: board()(tx).recordReceiver,
    setChildPlacement: (input) => {
      placements += 1;
      return board()(tx).setChildPlacement(input);
    },
  });
  return { port, calls: () => placements };
}

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW,
    siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
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
  await db.query("UPDATE ops.trip_leg SET plan_version = 1 WHERE id = $1", [legId()]);
}, 60_000);

/** A saved plan with this child in Van 1, as a coordinator's Save leaves it. */
async function savedPlanWithChildInVanOne(): Promise<number> {
  const before = await loadBoard(sqlPlanStore(db), SITE, SERVICE_DATE, "PM", sqlDaySource(db, SITE));
  const saved = await setChildPlacement(
    {
      siteId: SITE,
      serviceDate: SERVICE_DATE,
      direction: "PM",
      childToken: childToken(),
      bucket: "VAN",
      vehicleId: vanOne(),
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

/**
 * One undecided proposal with a MODEL-WRITTEN reply on it: `template_id` is `dropoff.reply` and
 * the sentence is `vars.replyText`, exactly as `agent/run/exec/proposals.ts` and
 * `demo/approval-seed.ts` write one. `fixedCopy` is the other flavour — the fallback template,
 * whose body is the centre's own words and is not a draft anybody may rewrite.
 */
async function seedProposal(over: { fixedCopy?: boolean } = {}): Promise<string> {
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
        requested_dropoff_time: "17:00",
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        ...(over.fixedCopy
          ? {
              template_id: DROPOFF_CHANGE_TEMPLATE,
              vars: { legDate: SERVICE_DATE, eta: "17:00", stopLabel: "OKEE-PARK" },
            }
          : {
              template_id: DROPOFF_REPLY_TEMPLATE,
              reply_text: DRAFTED,
              vars: { replyText: DRAFTED, legDate: SERVICE_DATE, eta: "17:00", stopLabel: "OKEE-PARK" },
            }),
      }),
    ],
  );
  return id;
}

/** One press of Approve (or Don't send), with whatever the card carried on it. */
const decide = (
  approvalId: string,
  over: {
    placement?: PlanPlacementPortFor;
    decision?: "APPROVED" | "DECLINED";
    editedText?: string | null;
    editedTime?: string | null;
    approvedText?: string;
  } = {},
) =>
  decideApproval(
    db,
    transport,
    {
      userId: coordinator,
      approvalId,
      decision: over.decision ?? "APPROVED",
      editedText: over.editedText,
      editedTime: over.editedTime ?? null,
      approvedText: over.approvedText,
      now: NOW,
    },
    { placement: over.placement ?? board() },
  );

const decisionOf = async (id: string) =>
  (
    await db.query<{ decision: string | null; decided_at: Date | null }>(
      "SELECT decision, decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )
  ).rows[0];

/** The queued texts, with the two columns that say what a family will read. */
const outbox = async () =>
  (
    await db.query<{ template_id: string; vars: Record<string, unknown> }>(
      "SELECT template_id, vars FROM ops.outbound_message ORDER BY created_at, id",
      [],
    )
  ).rows;

/** The whole proposal row's JSON, for the "no new column" claim. */
const proposalJson = async (id: string) =>
  (
    await db.query<Record<string, unknown>>("SELECT * FROM ops.approval_request WHERE id = $1", [id])
  ).rows[0];

const windowStart = async () =>
  (
    await db.query<{ window_start: string | null }>(
      "SELECT window_start FROM ops.trip_leg WHERE id = $1",
      [legId()],
    )
  ).rows[0].window_start;

describe("Approve sends exactly the edited text", () => {
  it("queues the coordinator's sentence, and the agent's nowhere", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();

    const answer = await decide(id, { editedText: REWRITTEN });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 200 });

    const queued = await outbox();
    expect(queued.length).toBeGreaterThan(0);
    for (const row of queued) {
      // The existing prose var on the existing template — no new column anywhere (ruling 4).
      expect(row.template_id).toBe(DROPOFF_REPLY_TEMPLATE);
      expect(row.vars.replyText).toBe(REWRITTEN);
      // And the words the family will actually read, through the one renderer.
      expect(renderTemplate(row.template_id, row.vars, { child: "Theo V." })).toContain(REWRITTEN);
    }
    // The draft the agent wrote is not in the outbox at all. "Exactly the edited text" is a
    // replacement, not an addition.
    expect(JSON.stringify(queued)).not.toContain(DRAFTED);
    // What the card says back is the same sentence it sent.
    expect(answer.body.ok && answer.body.text).toContain(REWRITTEN);
  });

  it("stores nothing on the approval row: the edit rides with the decision", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    await decide(id, { editedText: REWRITTEN });

    /*
     * Ruling: if storing the edited text needs a schema column, don't. So the row is the row the
     * agent wrote — its `proposal` still carries the model's own sentence as provenance — and the
     * coordinator's words exist in the outbox and in the audit of that send, nowhere else.
     */
    const row = await proposalJson(id);
    expect(JSON.stringify(row.proposal)).toContain(DRAFTED);
    expect(JSON.stringify(row)).not.toContain(REWRITTEN);
  });

  it("keeps the names a family's own reply may carry", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    // The point of `reply-text.ts`: the guardian's and the child's first names are NOT banned —
    // the recipient is this child's own guardian. A rewrite that greets them is sendable.
    const warm = "Hi Dara, 5 o'clock is fine and Theo will be ready. Thanks!";
    expect((await decide(id, { editedText: warm })).status).toBe(200);
    expect((await outbox())[0].vars.replyText).toBe(warm);
  });

  it("moves the ride the PROPOSAL asked for, not the one the sentence talks about", async () => {
    const started = await savedPlanWithChildInVanOne();
    const id = await seedProposal();

    /*
     * Ruling 3, on the rows: the plan line and the plan write come from the proposal. The edited
     * sentence here says nothing about a time at all, and the leg still moves to the proposal's
     * own 17:00 (21:00Z, EDT in October) with the child still in the van the board had them in.
     */
    expect(
      (await decide(id, { editedText: "All set for this afternoon — thanks for the heads up." }))
        .status,
    ).toBe(200);
    expect(new Date((await windowStart()) as string).toISOString()).toBe("2026-10-16T21:00:00.000Z");
    const plan = await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, SERVICE_DATE],
    );
    expect(plan.rows[0].version).toBe(started + 1);
  });

  it("carries an edited time and an edited sentence together", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();

    expect((await decide(id, { editedText: REWRITTEN, editedTime: "17:45" })).status).toBe(200);

    const [row] = await outbox();
    // The coordinator's words survive the time edit — they are the one thing that cannot be
    // re-derived, so an edited time does not retire a sentence a person wrote (`sendShape`).
    expect(row.template_id).toBe(DROPOFF_REPLY_TEMPLATE);
    expect(row.vars.replyText).toBe(REWRITTEN);
    expect(row.vars.eta).toBe("17:45");
    // And the ride moved to the time they typed, not the time the proposal asked for.
    expect(new Date((await windowStart()) as string).toISOString()).toBe("2026-10-16T21:45:00.000Z");
  });

  it("an edited time with no rewrite still queues the sentence the card showed", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();

    /*
     * The half of this that was broken before PPE-97. `bodyOf` retires the model's sentence when
     * the time moves under it — the card shows the fixed template for the new time — but the
     * enqueue passed the row's own template and vars untouched, so the family was queued the
     * model's original sentence about the original time. One `sendShape` for both now.
     */
    expect((await decide(id, { editedTime: "17:45" })).status).toBe(200);
    const [row] = await outbox();
    expect(row.template_id).toBe(DROPOFF_CHANGE_TEMPLATE);
    expect(row.vars.replyText).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(DRAFTED);
  });
});

describe("the safety refusals run server-side on the edited text, and nothing is claimed", () => {
  /**
   * Each case: the words a coordinator typed, and the class `reply-text.ts` refuses them under.
   * The table is the point — every one of these is a rule the MODEL's own reply has always been
   * held to, and the ruling is that a person's rewrite is held to the same ones.
   */
  const refused: readonly { readonly what: string; readonly text: string }[] = [
    { what: "a phone number", text: "Yes — call me back on 561-555-0177 and we'll sort it out." },
    { what: "a run of digits that is one", text: "Call 5615550177 when you get this." },
    { what: "a link", text: "Yes — details at tokos.app/pickup, see you at 5." },
    { what: "an email address", text: "Yes. Email dara@example.com if that changes." },
    { what: "a street address", text: "We'll drop at 123 Okeechobee Blvd instead today." },
    { what: "an internal code", text: "Approved, reason PARENT_REQUEST, stop OKEE-PARK." },
    { what: "the machine's own prefix", text: "PPEC: Yes, 5 works today." },
    { what: "a line break", text: "Yes, 5 works.\nSee you then." },
    { what: "a cleared field", text: "   " },
    { what: `more than ${REPLY_TEXT_MAX} characters`, text: `Yes — ${"5 o'clock works. ".repeat(20)}` },
  ];

  for (const { what, text } of refused) {
    it(`refuses ${what}, and the proposal is still pending`, async () => {
      await savedPlanWithChildInVanOne();
      const id = await seedProposal();
      const counting = countingBoard();

      expect(await decide(id, { editedText: text, placement: counting.port })).toEqual({
        status: 422,
        body: { ok: false, error: "TEXT_NOT_SENDABLE" },
      });

      // Not claimed, not planned, not queued, not sent — and the real board was never asked, so
      // the refusal is before the decision rather than a rollback of one.
      expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
      expect(counting.calls()).toBe(0);
      expect(await outbox()).toEqual([]);
      expect(transport.sent).toEqual([]);
    });
  }

  it("refuses a rewrite of the centre's own fixed copy", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal({ fixedCopy: true });
    const counting = countingBoard();

    // `dropoff.changed` has no prose var: its body is the centre's words. The screen renders no
    // field there (`editableReply` answers null), and a hand-posted one is refused anyway.
    expect(editableReply(DROPOFF_CHANGE_TEMPLATE, { eta: "17:00" })).toBeNull();
    expect(await decide(id, { editedText: REWRITTEN, placement: counting.port })).toEqual({
      status: 422,
      body: { ok: false, error: "TEXT_NOT_EDITABLE" },
    });
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(counting.calls()).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  it("refuses a rewrite when the card it was typed on has moved on", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const counting = countingBoard();

    /*
     * S1-7 still holds over an edited reply: `text` answers "was the card you read current", and
     * the rewrite replaces the draft only once that answer is yes. A stale press is 409 and
     * nothing is sent, however good the words on it are.
     */
    expect(
      await decide(id, {
        editedText: REWRITTEN,
        approvedText: "PPEC: some sentence this row does not render",
        placement: counting.port,
      }),
    ).toEqual({ status: 409, body: { ok: false, error: "MESSAGE_CHANGED" } });
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(counting.calls()).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  it("accepts the press when the card was current, rewrite and all", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    // The words the card showed are the DRAFT's body — the rewrite is what replaces them, so the
    // check is on what was read and the send is what was typed.
    const shown = renderTemplate(DROPOFF_REPLY_TEMPLATE, { replyText: DRAFTED }, { child: "Theo V." });
    expect((await decide(id, { editedText: REWRITTEN, approvedText: shown })).status).toBe(200);
    expect((await outbox())[0].vars.replyText).toBe(REWRITTEN);
  });

  it("sends nothing at all when the press was Don't send", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const counting = countingBoard();

    const answer = await decide(id, {
      decision: "DECLINED",
      editedText: REWRITTEN,
      placement: counting.port,
    });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, decision: "DECLINED", queued: 0 } });
    // Decided, and that is all: no ride moved and the words — theirs or the agent's — went nowhere.
    expect(await decisionOf(id)).toMatchObject({ decision: "DECLINED" });
    expect(counting.calls()).toBe(0);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("is still one press and one decision: a second one is refused", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    expect((await decide(id, { editedText: REWRITTEN })).status).toBe(200);
    const queued = (await outbox()).length;

    // The edit does not reopen anything. "The edit + Approve press is the approval", so the row is
    // decided and a second press — with different words on it — is the claim's own 409.
    expect(await decide(id, { editedText: "Actually, make it 6." })).toEqual({
      status: 409,
      body: { ok: false, error: "ALREADY_DECIDED" },
    });
    expect((await outbox()).length).toBe(queued);
  });
});

describe("which cards offer the field at all (`editableReply`, one definition for both halves)", () => {
  it("answers the sentence inside the body, without the template's own prefix", () => {
    // The field is prefilled with this, not with "PPEC: …" — `reply-text.ts` refuses the prefix,
    // so a box holding the whole bubble would hand back a refusal nobody earned.
    expect(editableReply(DROPOFF_REPLY_TEMPLATE, { replyText: DRAFTED })).toBe(DRAFTED);
    expect(renderTemplate(DROPOFF_REPLY_TEMPLATE, { replyText: DRAFTED })).toContain("PPEC:");
  });

  it("answers null for fixed copy, for a row with no drafted sentence, and for a blank one", () => {
    expect(editableReply(DROPOFF_CHANGE_TEMPLATE, { replyText: DRAFTED })).toBeNull();
    expect(editableReply(DROPOFF_REPLY_TEMPLATE, {})).toBeNull();
    expect(editableReply(DROPOFF_REPLY_TEMPLATE, { replyText: "   " })).toBeNull();
    expect(editableReply("", {})).toBeNull();
  });
});
