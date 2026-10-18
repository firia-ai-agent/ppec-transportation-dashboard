/**
 * THE "NEEDS A PERSON" CARD NAMES THE TIME WHEN A PROPOSAL ROW SAYS IT — founder, 2026-10-18, on
 * the card commit ea840a5 left behind.
 *
 * That commit cut the card to one line from the rows: "Dara O. texted about Noah's drop-off.",
 * their own words under it, one control. The line deliberately said nothing about *what was
 * asked*, because nothing read the message and this screen does not guess — the founder's rule of
 * 2026-10-17, which `no-keyword-fallback.test.ts` keeps structurally.
 *
 * The ruling adds the one exception that is not a guess: **a proposal row**. An undecided
 * `ops.approval_request` for the same child and the same ride carries
 * `requested_dropoff_time` — a stored field, written by a turn that did reach a model
 * (`agent/run/exec/proposals.ts`) or by the demo seed — so where one exists the line reads "Dara
 * O. asked to move Noah's drop-off to 5." and a coordinator reads the ask without opening the
 * thread. Where none exists, the line is exactly what ea840a5 shipped.
 *
 * What this file holds, then:
 *
 *  1. the two lines, word for word, from `ui/copy.assistantUnavailable.card` / `cardAsked`;
 *  2. the time's **format** is `sayClock`'s — the helper the proposal's own wording already uses
 *     (`alert-words.ts` → `agentBubble.dropoffWaiting`), so "17:00" reads "5" on both. No second
 *     format anywhere;
 *  3. which proposals count: undecided, this child's, this ride's, and carrying a time. A decided
 *     one, another child's, and a place-only change all leave the plain line alone — the card must
 *     never name a time that is not this family's ask.
 *
 * Over PGlite with the real migrations, because what is being claimed is a **read**: the sentence
 * is built from a row joined in `openAssistantAlerts`, and a fake of that query could only show
 * that `toAlert` can fill a template.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { sayClock } from "@/domain/eta/eta";
import { DROPOFF_CHANGE_KIND } from "@/modules/approvals/dropoff-change";
import { assistantUnavailable, fill } from "@/ui/copy";
import { testIdentityGateway } from "@/test/identity-gateway";
import { PEPPER } from "@/test/messaging";
import { seedAgentScenario, type AgentScenario } from "@/test/agent-state";
import { freshDb } from "@/test/pglite";
import { openAssistantAlerts, raiseModelUnavailableAlert } from "./staff-alert";

/** The names `seedPersona` writes, as the display helpers shorten them for a staff screen. */
const ADULT = "SYN G.";
const CHILD = "Syn";

let pg: PGlite;
let db: Db;
let sc: AgentScenario;

const gateway = testIdentityGateway({ pepper: PEPPER });
const alerts = () => openAssistantAlerts(db, [sc.siteId], gateway);

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  sc = await seedAgentScenario(db, { body: "can someone meet him at five instead?" });
  /*
   * The morning ride is already behind the message, so the alert is about the afternoon
   * ("drop-off") — `alertSubject`'s own rule, read off two stored timestamps. Set before the
   * alert is raised, because that is when the leg is resolved onto the task row.
   */
  await db.query("UPDATE ops.trip_leg SET window_start = $2 WHERE id = $1", [
    sc.legs[sc.children[0]].AM,
    new Date(sc.receivedAt.getTime() - 3 * 3600_000),
  ]);
});

afterEach(async () => {
  await pg.close();
});

/** The alert the degraded path writes: one card, pointing at the family's own message. */
async function raiseAlert(): Promise<void> {
  await raiseModelUnavailableAlert(db, {
    siteId: sc.siteId,
    messageId: sc.messageId,
    reason: "provider_error",
    by: "test",
  });
}

/**
 * One drop-off proposal, as `propose_dropoff_change` and the demo seed both write one: a
 * `PLAN_CHANGE` task and the `ops.approval_request` row that hangs off it.
 *
 * Only the fields this card reads are varied — whose child, which leg, what time, and whether it
 * has been decided — because those four are the whole of what the line may be built from.
 */
async function seedProposal(
  over: {
    childToken?: string;
    legId?: string;
    requestedTime?: string | null;
    decided?: boolean;
  } = {},
): Promise<string> {
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step,
       completion_predicate, created_by, updated_by, source_mode)
     VALUES ($1, $2, 'PLAN_CHANGE', 'AMBER', 'OPEN', 'A family asked for a different drop-off',
       'Read the text, then decide', 'the drop-off approved or declined', 'test', 'test', 'SIMULATED')`,
    [taskId, sc.siteId],
  );
  const id = uuidv7();
  await db.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, decision, decided_at,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'test', 'test', 'SIMULATED')`,
    [
      id,
      sc.siteId,
      taskId,
      JSON.stringify({
        kind: DROPOFF_CHANGE_KIND,
        leg_id: over.legId ?? sc.legs[sc.children[0]].PM,
        child_token: over.childToken ?? sc.children[0],
        service_date: sc.serviceDate,
        direction: "PM",
        requested_dropoff_time: over.requestedTime === undefined ? "17:00" : over.requestedTime,
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
      }),
      over.decided ? "APPROVED" : null,
      // `decided_by` is an `app_user` id and this row needs none: what the card reads is
      // `decided_at`, which is what "already decided" means everywhere in this tree.
      over.decided ? sc.receivedAt : null,
    ],
  );
  return id;
}

/** The line ea840a5 shipped: who texted, and about which ride. */
const plainLine = fill(assistantUnavailable.card, {
  adult: ADULT,
  child: CHILD,
  leg: assistantUnavailable.legWord.PM,
});

describe("a proposal row for that ride puts the time in the line", () => {
  it("says what the family asked for, in the proposal's own clock words", async () => {
    await raiseAlert();
    await seedProposal();

    const [card] = await alerts();
    expect(card.sentence).toBe(
      fill(assistantUnavailable.cardAsked, {
        adult: ADULT,
        child: CHILD,
        leg: assistantUnavailable.legWord.PM,
        time: "5",
      }),
    );
    // Which is the founder's own example of the line, verbatim in shape: who asked, whose ride,
    // the time. Not a second format for a time anywhere in it.
    expect(card.sentence).toBe(`${ADULT} asked to move ${CHILD}'s drop-off to 5.`);
    expect(card.sentence).not.toContain("17:00");
    expect(card.sentence).not.toContain("5:00 PM");
  });

  it("formats the time with the same helper the proposal's own wording uses", async () => {
    await raiseAlert();
    await seedProposal({ requestedTime: "17:45" });

    const [card] = await alerts();
    // `sayClock` is what `agent/alert-words.ts` words a proposal with, so the card and the agent
    // bubble cannot print one minute two ways.
    expect(card.sentence).toContain(`to ${sayClock("17:45")}.`);
    expect(card.sentence).toContain("to 5:45.");
  });

  it("still carries the family's own words, which are what say the rest", async () => {
    await raiseAlert();
    await seedProposal();

    const [card] = await alerts();
    // The one line is shorter than the ask; their sentence under it is verbatim, as it has been
    // since ea840a5 — the card gained a time, it did not gain a paraphrase.
    expect(card.theirWords).toBe("can someone meet him at five instead?");
    expect(card.adultName).toBe(ADULT);
  });
});

describe("and leaves the plain line alone for everything that is not this family's ask", () => {
  it("with no proposal at all, which is the ordinary alert", async () => {
    await raiseAlert();
    const [card] = await alerts();
    expect(card.sentence).toBe(plainLine);
  });

  it("with a proposal somebody has already decided", async () => {
    await raiseAlert();
    await seedProposal({ decided: true });
    const [card] = await alerts();
    expect(card.sentence).toBe(plainLine);
  });

  it("with a proposal about another child", async () => {
    sc = await seedAgentScenario(db, { children: 2, body: "five would be better" });
    await db.query("UPDATE ops.trip_leg SET window_start = $2 WHERE id = $1", [
      sc.legs[sc.children[0]].AM,
      new Date(sc.receivedAt.getTime() - 3 * 3600_000),
    ]);
    await raiseAlert();
    // A contact authorized for two children: the card names no child at all (`cardNoChild`), and
    // a proposal about one of them must not put a time on a line about "a ride".
    await seedProposal({ childToken: sc.children[1], legId: sc.legs[sc.children[1]].PM });

    const [card] = await alerts();
    expect(card.sentence).toBe(fill(assistantUnavailable.cardNoChild, { adult: ADULT }));
    expect(card.sentence).not.toContain("5");
  });

  it("with a proposal about the family's other ride", async () => {
    await raiseAlert();
    await seedProposal({ legId: sc.legs[sc.children[0]].AM });
    const [card] = await alerts();
    expect(card.sentence).toBe(plainLine);
  });

  it("with a proposal that moves only the place, so there is no time to name", async () => {
    await raiseAlert();
    await seedProposal({ requestedTime: null });
    const [card] = await alerts();
    expect(card.sentence).toBe(plainLine);
  });

  it("with a stored value that is not a wall clock: the raw field never reaches the card", async () => {
    await raiseAlert();
    await seedProposal({ requestedTime: "later today" });
    const [card] = await alerts();
    expect(card.sentence).toBe(plainLine);
    expect(card.sentence).not.toContain("later today");
  });
});
