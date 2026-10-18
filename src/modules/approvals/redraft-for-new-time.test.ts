/**
 * **PPE-106 / PPE-107: A TIME CHANGE REDRAFTS THE REPLY, AND APPROVE REFUSES A DRAFT WRITTEN FOR
 * ANOTHER TIME** — Veri's S1 of 2026-10-18.
 *
 * The bug, as the coordinator met it on the Family texts card (mockups/family-texts.html, and the
 * same card drawn inside mockups/agent-bubble.html): open Edit, move the drop-off to 5:45, press
 * Approve without retyping. The box still held the model's sentence about five o'clock — the time
 * field was a `GET` form of its own, so it re-rendered the page and refilled the box from the
 * original draft — and the press moved the leg to 17:45 while queueing Dara words naming "5".
 * The right ride and the wrong promise, in the model's voice.
 *
 * Three rules, and this file is each of them over rows:
 *
 *  1. **changing the time is a POST that redrafts** (`approvals/redraft.ts`). The coordinator's own
 *     words are kept to the character; otherwise the reply is redrafted for the new time — the
 *     model through the injectable port, and the agent's own fallback line when no model answers
 *     (`agent/alert-words.dropoffReplyWords`, `familyTexts.dropoffReplyFallback` through
 *     `sayClock`). Whatever is written is held to `replyTextIssue` before it is stored.
 *  2. **the draft is stored with the time it was written for**, in the proposal jsonb the row
 *     already has (`drafts.ts`) — no column, no migration, no second table.
 *  3. **Approve sends exactly the box**, and refuses a press whose words are one of this
 *     proposal's drafts for a time nobody is approving (`DRAFT_FOR_OTHER_TIME`). No time is read
 *     out of any sentence: each draft is *tied* to its time, so the check is a lookup.
 *
 * The shape refusals on an edited reply — `replyTextIssue` and `REPLY_TEXT_MAX`, server-side,
 * before anything is claimed, with nothing claimed afterwards — are Athena's ask and are held
 * next door in `edited-reply.test.ts` ("the safety refusals run server-side on the edited text"),
 * over the same `decideApproval` call a route makes. They are cited rather than repeated; what is
 * new here is that a *draft* is held to the same shape one step earlier.
 *
 * Over PGlite with the real migrations and the real board (`plan-placement.test.ts`'s wiring, as
 * `edited-reply.test.ts` uses it), because every claim is about rows: the drafts on the proposal,
 * the text in the outbox, the window on the leg, and whether a decision was claimed at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { VANS } from "@/config/vans";
import type { Db, Exec } from "@/db/exec";
import { demoDay } from "@/domain/board/day";
import { sayClock } from "@/domain/eta/eta";
import { dropoffReplyWords } from "@/modules/agent/alert-words";
import { approvalQueue } from "@/app/(app)/family-texts/queue";
import { DROPOFF_CHANGE_KIND, DROPOFF_CHANGE_TEMPLATE, DROPOFF_REPLY_TEMPLATE } from "@/modules/approvals/dropoff-change";
import { decideApproval } from "@/modules/approvals/decide";
import { draftsOf, latestDraft } from "@/modules/approvals/drafts";
import { redraftReply, redraftDeps, type RedraftPort } from "@/modules/approvals/redraft";
import { boardPlacementPort, type PlanPlacementPortFor } from "@/modules/approvals/plan-placement-port";
import { childTokenOf, demoLegId, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { setChildPlacement } from "@/modules/plan/place";
import { sqlPlanStore, sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";

const NOW = new Date("2026-10-16T17:45:00.000Z");
const SERVICE_DATE = "2026-10-16";
/** Theo V. (C8) rides the afternoon and needs nothing, so he fits in any van. */
const CHILD_KEY = "C8";
const childToken = () => childTokenOf(CHILD_KEY);
const legId = () => demoLegId(CHILD_KEY, "PM");
const vanOne = () => vehicleIdOf(VANS[0].vehicleKey);

/** The time the family asked for, and the time the coordinator moves it to. */
const ASKED = "17:00";
const MOVED = "17:45";
/** The sentence the model drafted, as `propose_dropoff_change` stores it. It names "5". */
const DRAFTED = "Hi Dara, yes, we'll drop Theo off at 5 today. Thanks for letting us know!";

let db: Db;
let close: () => Promise<void>;
let coordinator: string;
let transport: FakeOutboxTransport;

const board = (): PlanPlacementPortFor =>
  boardPlacementPort({
    store: (tx) => sqlPlanStoreIn(tx),
    source: (tx, siteId) => sqlDaySource(tx, siteId),
  });

/** The real board with a count of the one call a refusal must never reach. */
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
  await db.query("UPDATE ops.trip_leg SET plan_version = 1, window_start = NULL WHERE id = $1", [legId()]);
}, 60_000);

/** A saved plan with this child in Van 1, as a coordinator's Save leaves it. */
async function savedPlanWithChildInVanOne(): Promise<void> {
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
}

/**
 * One undecided proposal with a model-written reply on it, exactly as
 * `agent/run/exec/proposals.ts` and `demo/approval-seed.ts` write one: `dropoff.reply`, the
 * sentence in `vars.replyText`, and **no drafts list** — which is the row every deployment already
 * has and the row `drafts.ts` seeds its `original` entry from.
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
        requested_dropoff_time: ASKED,
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        ...(over.fixedCopy
          ? {
              template_id: DROPOFF_CHANGE_TEMPLATE,
              vars: { legDate: SERVICE_DATE, eta: ASKED, stopLabel: "OKEE-PARK" },
            }
          : {
              template_id: DROPOFF_REPLY_TEMPLATE,
              reply_text: DRAFTED,
              vars: { replyText: DRAFTED, legDate: SERVICE_DATE, eta: ASKED, stopLabel: "OKEE-PARK" },
            }),
      }),
    ],
  );
  return id;
}

/** The "Update the time" press: the time field and the box, as the one form carries them. */
const redraft = (
  approvalId: string,
  over: { time?: string; boxText?: string; model?: RedraftPort; timeoutMs?: number } = {},
) =>
  redraftReply(
    db,
    {
      userId: coordinator,
      approvalId,
      time: over.time ?? MOVED,
      // The box, as the card prefilled it: the draft it was showing, until somebody types.
      boxText: over.boxText ?? DRAFTED,
      now: NOW,
    },
    redraftDeps({ model: over.model, timeoutMs: over.timeoutMs }),
  );

/** One Approve, with exactly the four things the card's one form posts. */
const approve = (
  approvalId: string,
  form: { time: string; replyText: string; text?: string; placement?: PlanPlacementPortFor },
) =>
  decideApproval(
    db,
    transport,
    {
      userId: coordinator,
      approvalId,
      decision: "APPROVED",
      editedTime: form.time,
      editedText: form.replyText,
      approvedText: form.text,
      now: NOW,
    },
    { placement: form.placement ?? board() },
  );

const proposalOf = async (id: string) =>
  (
    await db.query<{ proposal: Record<string, unknown> }>(
      "SELECT proposal FROM ops.approval_request WHERE id = $1",
      [id],
    )
  ).rows[0].proposal;

const decisionOf = async (id: string) =>
  (
    await db.query<{ decision: string | null; decided_at: Date | null }>(
      "SELECT decision, decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )
  ).rows[0];

const outbox = async () =>
  (
    await db.query<{ template_id: string; vars: Record<string, unknown> }>(
      "SELECT template_id, vars FROM ops.outbound_message ORDER BY created_at, id",
      [],
    )
  ).rows;

const windowStart = async () =>
  (
    await db.query<{ window_start: string | null }>(
      "SELECT window_start FROM ops.trip_leg WHERE id = $1",
      [legId()],
    )
  ).rows[0].window_start;

/** 17:45 at the centre, as an instant — 21:45Z in October (EDT). */
const AT_MOVED = "2026-10-16T21:45:00.000Z";

/** The fallback line for a time, through the one function the agent's own writer falls back to. */
const fallbackFor = (time: string) =>
  dropoffReplyWords({ reply: null, childToken: childToken(), requestedTime: time }).text;

describe("the press the bug was: a new time, the old sentence, no redraft", () => {
  it("is refused by name, and the model's sentence reaches no family", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const counting = countingBoard();

    /*
     * EXACTLY WHAT THE REAL FORM SENDS. The time field has been moved to 17:45 and the box was
     * never touched, so `replyText` is the draft the card prefilled it with and `text` is the body
     * it rendered. Before PPE-106 this press moved the leg to 17:45 and queued "we'll drop Theo
     * off at 5".
     */
    expect(
      await approve(id, { time: MOVED, replyText: DRAFTED, placement: counting.port }),
    ).toEqual({ status: 422, body: { ok: false, error: "DRAFT_FOR_OTHER_TIME" } });

    // Nothing claimed, nothing planned, nothing queued, nothing sent, and the leg where it was.
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(counting.calls()).toBe(0);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(await windowStart()).toBeNull();
    // And the sentence naming the old time is nowhere a family could read it.
    expect(JSON.stringify(await outbox())).not.toContain(DRAFTED);
  });

  it("does not stand between a coordinator and Don't send", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const counting = countingBoard();

    /*
     * The same stale press, declined. Nothing is sent and nothing moves, so words written for
     * another time cannot make a decline wrong — and a refusal here would mean a coordinator had
     * to redraft a reply before they were allowed to not send it.
     */
    const answer = await decideApproval(
      db,
      transport,
      {
        userId: coordinator,
        approvalId: id,
        decision: "DECLINED",
        editedTime: MOVED,
        editedText: DRAFTED,
        now: NOW,
      },
      { placement: counting.port },
    );
    expect(answer).toMatchObject({ status: 200, body: { ok: true, decision: "DECLINED", queued: 0 } });
    expect(await decisionOf(id)).toMatchObject({ decision: "DECLINED" });
    expect(counting.calls()).toBe(0);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
    // Declined, and the record says nothing was sent.
    expect((await proposalOf(id)).decision_detail).toMatchObject({ sent_text: null, time: MOVED });
  });

  it("is refused the same way when the press carries no text at all", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const counting = countingBoard();

    /*
     * A hand-made post — the card's one form always carries the box. The server will not pick
     * different words for a time nobody read them against, which is what it used to do (the
     * retired `dropoff.changed` fallback in `sendShape`).
     */
    const answer = await decideApproval(
      db,
      transport,
      { userId: coordinator, approvalId: id, decision: "APPROVED", editedTime: MOVED, now: NOW },
      { placement: counting.port },
    );
    expect(answer).toEqual({ status: 422, body: { ok: false, error: "DRAFT_FOR_OTHER_TIME" } });
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(counting.calls()).toBe(0);
    expect(await outbox()).toEqual([]);
  });
});

describe("the redraft, with no model to ask", () => {
  it("stores the fallback line for the NEW time, and hands it back for the box", async () => {
    const id = await seedProposal();

    // The production default port: no model is asked from this surface at all (`redraft.ts`).
    const answer = await redraft(id);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.ok && answer.body.source).toBe("fallback");

    const text = answer.body.ok ? answer.body.text : "";
    // The agent's own fallback sentence, naming 5:45 through `sayClock` — one clock helper, one
    // copy line, and the same words a card born without a model would have carried.
    expect(text).toBe(fallbackFor(MOVED));
    expect(text).toContain(sayClock(MOVED) as string);
    expect(text).not.toBe(DRAFTED);

    // Stored as the proposal's newest draft, with the time it was written for, in the jsonb.
    const stored = latestDraft(await proposalOf(id));
    expect(stored).toMatchObject({ time: MOVED, text, source: "fallback" });
    // The model's own sentence is still the first entry: provenance, not a second copy.
    expect(draftsOf(await proposalOf(id))[0]).toMatchObject({ text: DRAFTED, source: "original" });
  });

  it("and then Approve sends exactly that, to the family and to the leg", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const drafted = await redraft(id);
    const box = drafted.body.ok ? drafted.body.text : "";

    // The press the card makes next: the box, the time it was drafted for, and the body it showed.
    const answer = await approve(id, {
      time: MOVED,
      replyText: box,
      text: drafted.body.ok ? drafted.body.body : undefined,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    const queued = await outbox();
    expect(queued.length).toBeGreaterThan(0);
    for (const row of queued) {
      expect(row.template_id).toBe(DROPOFF_REPLY_TEMPLATE);
      // The box, to the character.
      expect(row.vars.replyText).toBe(box);
      expect(row.vars.eta).toBe(MOVED);
    }
    // The model's original sentence about "5" is in no queued message at all.
    expect(JSON.stringify(queued)).not.toContain(DRAFTED);
    // And the ride moved to the time those words name.
    expect(new Date((await windowStart()) as string).toISOString()).toBe(AT_MOVED);
  });

  it("records what the decision was about, inside the proposal json", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const drafted = await redraft(id);
    const box = drafted.body.ok ? drafted.body.text : "";
    expect((await approve(id, { time: MOVED, replyText: box })).status).toBe(200);

    /*
     * Four facts a reader asks after the fact and could not answer before: what the model wrote,
     * what the card was showing, what went to the family, and whether those were the
     * coordinator's own words. `rewritten` is false here — they approved a redraft, they did not
     * write one — and it is measured against the LATEST draft rather than the model's first.
     *
     * No message text goes in `ops.audit_event`: its own schema comment says "Hash-only for
     * message content", so the sentences live on the row they are about.
     */
    expect((await proposalOf(id)).decision_detail).toMatchObject({
      model_draft: DRAFTED,
      shown_draft: box,
      sent_text: box,
      rewritten: false,
      time: MOVED,
    });
  });
});

describe("the redraft, with a model port in hand", () => {
  const SENTENCE = "Hi Dara, 5:45 works — Theo will be dropped off then. Thanks for letting us know!";

  it("stores and returns the model's sentence when it answers one", async () => {
    const id = await seedProposal();
    const asked: unknown[] = [];
    const model: RedraftPort = async (ask) => {
      asked.push(ask);
      return SENTENCE;
    };

    const answer = await redraft(id, { model });
    expect(answer.body.ok && answer.body.text).toBe(SENTENCE);
    expect(answer.body.ok && answer.body.source).toBe("model");
    expect(latestDraft(await proposalOf(id))).toMatchObject({
      time: MOVED,
      text: SENTENCE,
      source: "model",
    });
    /*
     * And what the port was asked is three code-shaped values: the child as the operational tables
     * name them, a wall clock, and the draft being replaced. No word of what the family typed can
     * reach a prompt built from this.
     */
    expect(asked).toEqual([{ childToken: childToken(), time: MOVED, previous: DRAFTED }]);
  });

  it("holds the model's sentence to the same shape a reply is always held to", async () => {
    const id = await seedProposal();
    // A phone number in a text to a family is what `replyTextIssue` exists to refuse — the model's
    // own `reply` argument is refused at the gateway for it, and a redraft is refused here.
    const model: RedraftPort = async () => "Yes — call me on 561-555-0177 and we'll sort it out.";
    const answer = await redraft(id, { model });
    expect(answer.body.ok && answer.body.source).toBe("fallback");
    expect(answer.body.ok && answer.body.text).toBe(fallbackFor(MOVED));
  });

  it("falls back when the port throws", async () => {
    const id = await seedProposal();
    const model: RedraftPort = async () => {
      throw new Error("vendor said no");
    };
    const answer = await redraft(id, { model });
    expect(answer.status).toBe(200);
    expect(answer.body.ok && answer.body.text).toBe(fallbackFor(MOVED));
    expect(latestDraft(await proposalOf(id))).toMatchObject({ source: "fallback", time: MOVED });
  });

  it("falls back when the port takes too long, rather than making a person wait", async () => {
    const id = await seedProposal();
    const model: RedraftPort = () => new Promise<string>(() => {});
    const answer = await redraft(id, { model, timeoutMs: 10 });
    expect(answer.status).toBe(200);
    expect(answer.body.ok && answer.body.text).toBe(fallbackFor(MOVED));
  });
});

describe("the words a coordinator typed survive a time change", () => {
  const TYPED = "Hi Dara — Maria will be at the park door, and Theo will be with her. See you then.";

  it("keeps them to the character, and stores them for the new time", async () => {
    const id = await seedProposal();
    // The box differs from the draft it was showing, so the redraft changes the time and nothing
    // else. A model that would have written something is not even asked.
    let askedAnything = false;
    const model: RedraftPort = async () => {
      askedAnything = true;
      return "something else entirely";
    };

    const answer = await redraft(id, { boxText: TYPED, model });
    expect(answer.body.ok && answer.body.text).toBe(TYPED);
    expect(answer.body.ok && answer.body.source).toBe("coordinator");
    expect(askedAnything).toBe(false);
    expect(latestDraft(await proposalOf(id))).toMatchObject({ time: MOVED, text: TYPED });
  });

  it("and Approve sends exactly those words at the new time", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    await redraft(id, { boxText: TYPED });

    expect((await approve(id, { time: MOVED, replyText: TYPED })).status).toBe(200);
    const [row] = await outbox();
    expect(row.vars.replyText).toBe(TYPED);
    expect(row.vars.eta).toBe(MOVED);
    expect(new Date((await windowStart()) as string).toISOString()).toBe(AT_MOVED);
    // Their words are the record's `sent_text`, and the record says they wrote them.
    expect((await proposalOf(id)).decision_detail).toMatchObject({
      model_draft: DRAFTED,
      shown_draft: TYPED,
      sent_text: TYPED,
      rewritten: false,
    });
  });

  it("refuses words it could not send, before they become a draft", async () => {
    const id = await seedProposal();
    // The same shape check `decideApproval` runs on an edited reply, one step earlier: the box
    // never fills with words the press would refuse.
    const answer = await redraft(id, { boxText: "Call us on 561-555-0177 before 5." });
    expect(answer).toEqual({ status: 422, body: { ok: false, error: "TEXT_NOT_SENDABLE" } });
    // Nothing stored: the row still carries the model's own sentence and nothing else.
    expect(draftsOf(await proposalOf(id))).toHaveLength(1);
  });
});

describe("what a redraft will not do", () => {
  it("refuses a proposal whose words are the centre's fixed copy", async () => {
    const id = await seedProposal({ fixedCopy: true });
    // `dropoff.changed` has no prose var: its body is rendered from the time, so moving the time
    // moves the words with it and there is nothing to draft (`decide.editableReply`).
    expect(await redraft(id)).toEqual({
      status: 422,
      body: { ok: false, error: "TEXT_NOT_EDITABLE" },
    });
  });

  it("refuses a time that is not a time, and writes nothing", async () => {
    const id = await seedProposal();
    for (const bad of ["5pm-ish", "25:00", "17:0", ""]) {
      expect(await redraft(id, { time: bad }), bad).toEqual({
        status: 422,
        body: { ok: false, error: "NOT_A_TIME" },
      });
    }
    expect(draftsOf(await proposalOf(id))).toHaveLength(1);
  });

  it("refuses a decision somebody has already made", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    expect((await approve(id, { time: ASKED, replyText: DRAFTED })).status).toBe(200);
    // A decided proposal has no draft to change. Same code the second presser gets.
    expect(await redraft(id)).toEqual({
      status: 409,
      body: { ok: false, error: "ALREADY_DECIDED" },
    });
  });

  it("refuses a caller with no session, and an id this caller may not see", async () => {
    const id = await seedProposal();
    expect(await redraftReply(db, { approvalId: id, time: MOVED, boxText: DRAFTED, now: NOW })).toEqual({
      status: 401,
      body: { ok: false, error: "SIGN_IN" },
    });
    // An id that exists nowhere and an id at another site answer identically (`decideApproval`).
    expect(
      await redraft("00000000-0000-7000-8000-00000000dead"),
    ).toEqual({ status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } });
    expect(draftsOf(await proposalOf(id))).toHaveLength(1);
  });

  it("stores no second draft for a press that changed nothing", async () => {
    const id = await seedProposal();
    // The same sentence for the same time: said back rather than appended, so a coordinator who
    // presses twice does not grow the list by a draft that says what the last one said.
    expect((await redraft(id, { time: ASKED })).status).toBe(200);
    expect(draftsOf(await proposalOf(id))).toHaveLength(1);
  });
});

describe("the card the queue builds, and what reading it does", () => {
  it("shows the latest draft and the time it was written for", async () => {
    const id = await seedProposal();
    const drafted = await redraft(id);
    const box = drafted.body.ok ? drafted.body.text : "";

    const [card] = await approvalQueue({
      db,
      siteIds: [SITE],
      day: demoDay(),
      editedTime: null,
    });
    expect(card.approvalId).toBe(id);
    // The box holds the redraft, the bubble is that same sentence rendered, and the time field is
    // the minute it was written for — so the press cannot be about two different times.
    expect(card.draftReplyText).toBe(box);
    expect(card.draftText).toContain(box);
    expect(card.draftText).not.toContain(DRAFTED);
    expect(card.requestedHhmm).toBe(MOVED);
  });

  it("reads and nothing else: the render path writes nothing and calls no model", async () => {
    const id = await seedProposal();
    await redraft(id);
    /*
     * PPE-96, held again where PPE-107 could have broken it: the time field is a POST now, so the
     * page's own GET must stay a read. Every statement the queue issues, recorded — and a model
     * port is never in its hands to ask (`approvalQueue` takes a database and a day).
     */
    const statements: string[] = [];
    const recording: Exec = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        return db.query(sql, params ?? []);
      },
    } as Exec;
    await approvalQueue({ db: recording, siteIds: [SITE], day: demoDay(), editedTime: null });
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect({ sql, reads: /^\s*SELECT\b/i.test(sql.trim()) }).toEqual({ sql, reads: true });
      expect(sql).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|jsonb_set/i);
    }
    // And the row is untouched by having been read: one redraft, one draft on top of the original.
    expect(draftsOf(await proposalOf(id))).toHaveLength(2);
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
  });
});
