/**
 * THE PROPOSAL CARD COMES FROM A ROW, AND ITS TICKS ARE COMPUTED — Firia's S1-2, 2026-10-17
 * 11:00 PM ET:
 *
 *   "the proposal card comes from the REAL model call and REAL approval rows. Delete the fixture
 *    card (family-texts/conversations.ts) and the For you fixture when there are no rows
 *    (page.tsx); with no rows show the empty state. The Same van / Fits / on-file ticks are
 *    COMPUTED from real data (fit.ts and the roster), not hardcoded. … The badge and the card come
 *    from the SAME rows (one query/module; test they match)."
 *
 * Four claims, and each is a different kind of assertion:
 *
 *  1. **the badge and the card are the same rows.** `queue.ts` is read once by the page; the count
 *     over the tab is that list's length and the card in the thread is the member of it whose
 *     `threadKey` is the open thread. Proved by giving the queue two rows and watching both
 *     surfaces agree about which is which.
 *  2. **with no rows there is no card**, anywhere — not on the tab and not in the thread — and the
 *     tab says so in words rather than going blank.
 *  3. **the ticks are facts.** The same card renders three ticks for a child whose file allows an
 *     adult to collect them and *two* for a child whose file does not (C2/F2 holds every scope
 *     except `RECEIVE_CHILD`: AT-13, the HELD_NO_RECEIVER case). A hardcoded tick cannot tell those
 *     two apart, which is why the old one was wrong rather than merely unverified.
 *  4. **the fixture card is gone**, structurally: no module under this folder builds a
 *     `ProposalView` out of the demo change-request fixture, and the page has no "no rows → show
 *     the fixture" branch left in it. That is the half a behavioural test cannot hold, because the
 *     way it came back would be a new call site rather than a changed answer.
 *
 * The DB half — that the demo seed writes a row this query really reads and this decision really
 * decides — is `src/modules/demo/seeded-approval.db.test.ts`, on PGlite.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Exec } from "@/db/exec";
import { demoDay } from "@/domain/board/day";
import { DEFAULT_MODEL_ALLOW_LIST, MODEL_BACKUP, MODEL_PRIMARY } from "@/modules/agent/config";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import {
  CHILDREN,
  childByKey,
  childTokenOf,
  runOfChild,
  stopByKey,
} from "@/modules/demo/fixtures/standard";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
import { approval, familyTexts, fill } from "@/ui/copy";
import type { DecisionState } from "./actions";
import { conversationRows, threadView, type ProposalView } from "./conversations";
import { approvalQueue } from "./queue";
import { TextsScreen } from "./TextsScreen";
import type { Thread } from "./thread";

const day = demoDay();
const texts = demoLateDropoffs(day);
const SITE = "00000000-0000-7000-8000-0000000000a1";

/** `ops.approval_request`, in the shape the demo seed and the agent's writer both write. */
function row(childKey: string, over: { id?: string; hhmm?: string } = {}) {
  const child = childByKey(childKey)!;
  return {
    id: over.id ?? "00000000-0000-7000-8000-00000000a001",
    site_id: SITE,
    decided_at: null,
    created_at: new Date("2026-10-16T19:58:00.000Z"),
    display_name: child.label,
    proposal: {
      kind: DROPOFF_CHANGE_KIND,
      leg_id: "00000000-0000-7000-8000-0000000000f1",
      child_token: childTokenOf(childKey),
      service_date: day.iso,
      direction: "PM",
      plan_run_version_basis: 0,
      requested_dropoff_time: over.hhmm ?? "17:00",
      stop_token: child.stopKey ? stopByKey(child.stopKey).smsToken : "",
      rationale_code: "PARENT_REQUEST",
      template_id: "dropoff.changed",
      vars: { legDate: day.iso, eta: over.hhmm ?? "17:00", stopLabel: child.stopKey ? stopByKey(child.stopKey).smsToken : "" },
    },
  };
}

/** `pendingApprovals`'s query, answered with exactly these rows. */
const execOf = (rows: unknown[]): Exec => ({ query: async () => ({ rows: rows as never[] }) });

const queueOf = (rows: unknown[]) =>
  approvalQueue({ db: execOf(rows), siteIds: [SITE], day, editedTime: null });

/** One pane of bubbles, from the day's own replay. The card is what these tests are about. */
const threadFor = (childKey: string): Thread => ({
  source: "scenario",
  bubbles: texts
    .filter((t) => t.childKey === childKey)
    .map((t) => ({
      id: t.childKey,
      direction: "OUT" as const,
      author: "AUTO" as const,
      timeLabel: "3:52 PM",
      atMs: t.atMs,
      body: t.body,
      delivery: null,
      reachedPhone: true,
    })),
});

function render(a: {
  readonly openKey: string;
  readonly proposals: readonly ProposalView[];
}): string {
  const selected = texts.find((t) => t.childKey === a.openKey) ?? texts[texts.length - 1];
  return renderToStaticMarkup(
    createElement(TextsScreen, {
      tab: "for-you",
      rows: conversationRows(texts, []),
      thread: threadView({
        selected,
        thread: threadFor(selected.childKey),
        // The page's own line: the member of the ONE queue whose thread this is.
        proposal: a.proposals.find((p) => p.threadKey === selected.childKey) ?? null,
        day,
        assistantReachable: true,
        mayApprove: true,
      }),
      proposals: a.proposals,
      alerts: [],
      alertsUnreadable: false,
      assistantReachable: true,
      context: null,
      editing: false,
      editedTime: null,
      threadOpen: false,
      decide: async (): Promise<DecisionState> => ({ status: "idle" }),
      takeAlert: async () => {},
      showForYouTab: true,
    }),
  );
}

/** The words a person reads, with React's entities decoded again. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

describe("the badge and the card are the same rows (S1-2)", () => {
  it("counts exactly the rows it renders, and puts each card in its own thread", async () => {
    // Two families waiting. The queue is one read; the tab and the thread are two readers of it.
    const queue = await queueOf([
      row("C1", { id: "00000000-0000-7000-8000-00000000a001" }),
      row("C3", { id: "00000000-0000-7000-8000-00000000a002", hhmm: "17:30" }),
    ]);
    expect(queue).toHaveLength(2);
    expect(queue.map((p) => p.threadKey)).toEqual(["C1", "C3"]);

    // The badge: `countFor` adds the proposals to the alerts, and there are no alerts here.
    const html = render({ openKey: "C3", proposals: queue });
    expect(textOf(html)).toContain(`${familyTexts.tabForYou} ${queue.length}`);

    /*
     * The card: C3's row, and only C3's — read off the card's own accessible name, which is the
     * one place the family it answers is written *on the card* (`approval.cardLabel`).
     *
     * It used to be read off "5:30 PM", the proposed time in the card's Time row. There is no
     * Time row any more (Vera, 7:51 AM ET) and so no clock time on the card at all: the body of
     * `dropoff.changed` places the stop and not the hour, which is the ruling the template
     * already followed. See the open question in the PR body — with no time in the words, an
     * edited time changes nothing a coordinator can read.
     */
    const [waiting, open] = queue;
    expect(html).toContain(`aria-label="${fill(approval.cardLabel, { adult: open.adultName })}"`);
    expect(html).not.toContain(`aria-label="${fill(approval.cardLabel, { adult: waiting.adultName })}"`);
    // One card, counted on the one approve row each card renders exactly once. (It used to be
    // counted on "The text the family will get", which Vera's card no longer has a heading for:
    // the message is a bubble and the bubble is not labelled.)
    expect(countOf(textOf(html), approval.approveAndSend)).toBe(1);
  });

  it("renders no card for a thread the queue has nothing for", async () => {
    const queue = await queueOf([row("C1")]);
    const html = render({ openKey: "C3", proposals: queue });
    // The tab still counts the one that is waiting — it is waiting, just not here.
    expect(textOf(html)).toContain(`${familyTexts.tabForYou} 1`);
    expect(textOf(html)).not.toContain(approval.approveAndSend);
  });
});

describe("with no approval rows there is no card and the tab says so (S1-2)", () => {
  it("renders the empty state, no card, and no Approve", async () => {
    const queue = await queueOf([]);
    expect(queue).toEqual([]);
    const html = textOf(render({ openKey: "C2", proposals: queue }));
    expect(html).toContain(approval.none);
    expect(html).not.toContain(approval.approveAndSend);
  });
});

describe("a model that cannot be reached means the alert, never a scripted card (S1-2)", () => {
  it("renders no card even with rows waiting, because nothing read the family's text", async () => {
    const queue = await queueOf([row("C1")]);
    expect(queue).toHaveLength(1);
    /*
     * Gate 5 beats the queue, and it has to: a row in the table is a record that *something* was
     * proposed, and with no model reachable this render cannot know that something still holds.
     * What the tab shows instead is the "needs a person" alert, which `agent/run/loop.ts`
     * (`modelDown` → `raiseModelUnavailableAlert`) is what writes — a `NEEDS_PERSON` task, proved
     * in src/modules/agent/model-unavailable.test.ts. There is no third option any more: with the
     * fixture card deleted there is nothing for a model failure to fall back to.
     */
    const html = textOf(
      renderToStaticMarkup(
        createElement(TextsScreen, {
          tab: "for-you",
          rows: conversationRows(texts, []),
          thread: threadView({
            selected: texts[texts.length - 1],
            thread: threadFor(texts[texts.length - 1].childKey),
            proposal: queue[0],
            day,
            assistantReachable: false,
            mayApprove: true,
          }),
          proposals: [],
          alerts: [],
          alertsUnreadable: false,
          assistantReachable: false,
          context: null,
          editing: false,
          editedTime: null,
          threadOpen: false,
          decide: async (): Promise<DecisionState> => ({ status: "idle" }),
          takeAlert: async () => {},
          showForYouTab: true,
        }),
      ),
    );
    expect(html).not.toContain(approval.approveAndSend);
  });
});

describe("the ticks are computed from the roster and fit.ts, not hardcoded (S1-2)", () => {
  it("shows '{adult} on file' for a family whose file allows it", async () => {
    // C1/F1 holds `FULL_SCOPES`, `RECEIVE_CHILD` among them.
    const [card] = await queueOf([row("C1")]);
    expect(card.checks).toContain(fill(approval.checkOnFile, { adult: "Alma R." }));
    expect(card.pickupLabel).toBe(fill(approval.pickupSame, { adult: "Alma R." }));
  });

  it("does NOT show it for the family whose file says no adult may collect the child", async () => {
    /*
     * C2/F2 is the AT-13 case: every scope except `RECEIVE_CHILD` (fixtures/standard.ts,
     * `NO_RECEIVER_SCOPES`). The old hardcoded chip claimed "Dara O. on file" on this exact card,
     * which is the opposite of what the file says — and this is the card the demo opens on.
     */
    const [card] = await queueOf([row("C2")]);
    expect(card.checks).not.toContain(fill(approval.checkOnFile, { adult: "Dara O." }));
    for (const check of card.checks) expect(check).not.toContain("on file");
    // And the pick-up row is left out rather than claiming an adult the file does not allow.
    expect(card.pickupLabel).toBe("");
    // The two the plan *can* answer are still there, so the absence above is about the file.
    expect(card.checks).toEqual([approval.checkSameVan, approval.checkFits]);
  });

  it("claims no van and no fit for a child on no run this leg", async () => {
    const offRun = CHILDREN.find((c) => !hasRun(c.key));
    if (!offRun) return; // every child rides today; nothing to assert
    const [card] = await queueOf([row(offRun.key)]);
    expect(card.checks).not.toContain(approval.checkSameVan);
    expect(card.checks).not.toContain(approval.checkFits);
  });

  it("prints the stop as a landmark, never as the token an SMS carries", async () => {
    const [card] = await queueOf([row("C1")]);
    expect(card.stopTo).toBe(stopByKey(childByKey("C1")!.stopKey!).label);
    expect(card.stopTo).not.toBe(stopByKey(childByKey("C1")!.stopKey!).smsToken);
  });
});

describe("the fixture card is gone, structurally (S1-2)", () => {
  const read = (file: string) => readFileSync(`${__dirname}/${file}`, "utf8");
  /** A file's code, comments stripped: the prose here is *about* the deleted thing. */
  const code = (file: string) =>
    read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");

  it("no module under this folder builds a card out of the change-request fixture", () => {
    for (const file of ["conversations.ts", "page.tsx", "queue.ts", "TextsScreen.tsx"]) {
      expect(code(file), `${file} builds a proposal from the demo fixture`).not.toMatch(
        /proposalFromDemo|proposalChecks\s*\(/,
      );
    }
    // `conversations.ts` does not reach the change-request module for a card at all any more.
    expect(code("conversations.ts")).not.toMatch(/checkSameVan|checkFits|checkOnFile/);
  });

  it("the page has no 'no rows → fixture' branch left", () => {
    const page = code("page.tsx");
    // The old shape was `if (logged.length > 0) … else requests.map(proposalFromDemo)`.
    expect(page).not.toMatch(/requests\.map\(/);
    expect(page).not.toMatch(/logged/);
    // One read, named, and it is the queue's.
    expect(page).toContain("approvalQueue(");
  });

  it("the queue renders the words through the decision model's own renderer", () => {
    // Never a string stored at proposal time: `bodyOf` is `renderTemplate` over the row's vars.
    expect(code("queue.ts")).toContain("bodyOf(");
    expect(code("queue.ts")).not.toMatch(/draftText:\s*"/);
  });
});

/* ───────────────────────────── helpers ───────────────────────────── */

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Does this child ride a van this afternoon? The roster's own runs answer. */
function hasRun(childKey: string): boolean {
  return runOfChild(childKey) !== undefined;
}

/* ───────────────────────── Vera's S1-2 checklist, items a and b ───────────────────────── */

/**
 * The thread these two sections open. It has to be a child the day's own replay has a thread for
 * (`demoLateDropoffs` covers the late run), because a card renders in the thread it belongs to and
 * `render` falls back to the newest thread for a key it cannot find — which would leave every
 * assertion below passing against a screen with no card on it at all.
 */
const OPEN = "C3";
const OPEN_STOP = stopByKey(childByKey(OPEN)!.stopKey!);

/**
 * ITEM A — "Each proposal has ONE approve row, labelled 'Agent' (from copy.ts), with no internal
 * codes and no vendor or provider names." (Vera, 2026-10-18.)
 *
 * Three separate claims, and the third is the one that rots quietly:
 *
 *  - **one** approve row. The mockup's card has a single `.acts`
 *    (/workspace/ppec-redesign/mockups/approvals.html, the `.prop` block): Approve & send, Edit,
 *    Don't send. Two rows would be two decisions offered for one proposal, and a coordinator
 *    cannot tell which of them the server will act on.
 *  - labelled **"Agent"**, and from `copy.ts` rather than spelled into the component — which is
 *    what makes it one word on every surface instead of "Assistant" here and "Agent" in the feed
 *    header beside it.
 *  - **no internal codes and no provider names.** The row that drives this card is full of both:
 *    `DROPOFF_CHANGE`, `PARENT_REQUEST`, a template id, a stop token, two uuids. None of them is
 *    a thing a coordinator calls anything (COPY-GUIDE §9.3), and the provider underneath is a
 *    deployment detail that belongs in `agent/config.ts` and the server log — a card that named it
 *    would be dating itself the next time that configuration changes.
 */
describe("the card is one approve row, labelled Agent, with no codes on it (S1-2 item a)", () => {
  it("renders exactly one approve row, and one of each control in it", async () => {
    const queue = await queueOf([row(OPEN)]);
    const text = textOf(render({ openKey: OPEN, proposals: queue }));
    // One card (`.prop`) is one row of controls: `.acts`, as the mockup draws it. The card has no
    // heading of its own to count any more (Vera, 7:51 AM ET) — it is the parent's name, the
    // message as a bubble, and these three.
    expect(countOf(text, approval.approveAndSend)).toBe(1);
    expect(countOf(text, approval.edit)).toBe(1);
    expect(countOf(text, approval.dontSend)).toBe(1);
  });

  it("keeps the author 'Agent' in copy.ts, and heads the card with who the reply goes to", async () => {
    // The word itself lives in copy, so the feed header and the card cannot drift apart.
    expect(approval.agentLabel).toBe("Agent");
    expect(approval.draftedBy).toContain("{agent}");

    const [card] = await queueOf([row(OPEN)]);
    expect(card.draftedLabel.startsWith(`${approval.agentLabel} ·`)).toBe(true);
    const text = textOf(render({ openKey: OPEN, proposals: [card] }));
    /*
     * The author is on the card as the mark's accessible name and nowhere else. The
     * "Agent · 3:58 PM" LINE is gone: Vera's card carries no clock time (7:51 AM ET), and a
     * drafted-at minute is a clock time wherever it sits. So the label stays a fact about the
     * row — the queue builds it and this asserts it — and the card draws the word, not the time.
     */
    expect(text).not.toContain(card.draftedLabel);
    /*
     * And the head says the act rather than the author (Firia, 11:11 AM ET 2026-10-18): "Reply to
     * Dara", in words every reader gets. The robot mark that carried "Agent" for a screen reader
     * came off with that ruling (ProposalCard.tsx).
     */
    expect(text).toContain(fill(approval.replyTo, { parent: card.parentFirstName }));
    expect(render({ openKey: OPEN, proposals: [card] })).not.toContain(`aria-label="${approval.agentLabel}"`);
    // Not the old word, anywhere on the screen.
    expect(text).not.toContain("Assistant ·");
  });

  it("puts no internal code anywhere a person reads", async () => {
    const queue = await queueOf([row(OPEN)]);
    const text = textOf(render({ openKey: OPEN, proposals: queue }));
    // Enum names stay on developer surfaces (COPY-GUIDE §2, the outbox's own rule).
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/);
    // The row's own fields, one by one: kind, reason code, template id, stop token, ids.
    expect(text).not.toContain(DROPOFF_CHANGE_KIND);
    expect(text).not.toContain("PARENT_REQUEST");
    expect(text).not.toContain("dropoff.changed");
    expect(text).not.toContain(OPEN_STOP.smsToken);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // The stop is still named, so the absence of its token above is about the token.
    expect(text).toContain(OPEN_STOP.label);
  });

  it("names no vendor, provider or model", async () => {
    const queue = await queueOf([row(OPEN)]);
    const text = textOf(render({ openKey: OPEN, proposals: queue }));
    // The derivation has to have produced something, or every assertion below passes vacuously.
    expect(PROVIDER_NAMES.length).toBeGreaterThan(3);
    const copy = JSON.stringify(approval);
    for (const vendor of PROVIDER_NAMES) {
      const name = new RegExp(vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      expect(text, `the card names ${vendor}`).not.toMatch(name);
      // And not in the copy the card is built out of either, which is where one would arrive first.
      expect(copy, `approval copy names ${vendor}`).not.toMatch(name);
    }
  });
});

/**
 * The names a staff screen must never carry — **read out of `agent/config.ts`**, not spelled here.
 *
 * Two reasons it is derived rather than listed. The first is that a list would be wrong the day
 * the deployment moves to the HIPAA endpoint: the thing that must not reach the card is whatever
 * model is configured *now*, and `MODEL_PRIMARY` / `MODEL_BACKUP` / `DEFAULT_MODEL_ALLOW_LIST` are
 * where that lives (B-08 slice 5). The second is that writing the slugs out would itself break
 * `src/modules/agent/no-hardcoded-models.test.ts`, which bans a model id anywhere in `src/`
 * outside those three files — and it is right to: a second copy of a slug is a place the switch
 * can be half-done. Importing the values is exactly what that rule wants.
 *
 * On top of them, the routers and labs by their bare company names, which are not model ids and
 * are not covered by that scanner.
 */
const PROVIDER_NAMES: readonly string[] = [
  ...new Set(
    [MODEL_PRIMARY, MODEL_BACKUP, ...DEFAULT_MODEL_ALLOW_LIST]
      /*
       * "vendor/family-4-31b-it:free" → the whole id, "vendor", "family".
       *
       * The vendor and the model family and nothing else. Not the parameter counts, and
       * emphatically not the tier suffix: "free" is a word the product's own copy uses ("Free text
       * to a family needs its own approval step"), so banning it would fail this screen for a
       * sentence that has nothing to do with a provider. A name longer than three letters, for the
       * same reason in general.
       */
      .flatMap((id) => {
        const [vendor, slug = ""] = id.split("/");
        return [id, vendor, slug.split(/[-:]/)[0]];
      })
      .filter((word) => word.length > 3),
  ),
  "openrouter",
  "hugging face",
];

/**
 * ITEM B — "Drafts contain no clock times." (Vera, 2026-10-18; the COPY RULE in
 * p-rework-approvals5, which says it of "no draft (parent reply or chat proposal)" and gives the
 * wording: "Yes, Jonah gets off at Palm Beach State College today".)
 *
 * Scoped to the **draft**, deliberately. The card around it still shows a time in two places and
 * both are right: "Agent · 3:58 PM" is when the agent wrote the row, and the Time row is the
 * before → after of a field a coordinator is deciding and can Edit. What may not carry one is the
 * sentence that leaves the building, because a minute in it is a promise about traffic — and this
 * screen gives a family no ETAs at all (Firia, 2026-10-17 8:36 PM and 10:51 PM ET).
 *
 * Asserted over every child the roster has rather than over one card, so a template added for
 * another family cannot slip a clock back in.
 */
describe("no draft carries a clock time (S1-2 item b)", () => {
  const CLOCK = /\d{1,2}:\d{2}|\b\d{1,2}\s?[ap]\.?m\.?\b/i;

  it("every proposal the queue can build reads as a place and a day, never a minute", async () => {
    // Every child the roster puts at a stop: a proposal needs a place to name, and a child with
    // no `stopKey` has no drop-off to change (the spare row in `fixtures/standard.ts`).
    const named = CHILDREN.filter((c) => c.stopKey !== null);
    expect(named.length).toBeGreaterThan(1);
    for (const child of named) {
      const [card] = await queueOf([row(child.key)]);
      expect(card.draftText, `${child.key}: "${card.draftText}"`).not.toMatch(CLOCK);
      // Rendered rather than refused, so the absence above is a sentence and not an empty string.
      expect(card.draftText, child.key).not.toBe("");
      expect(card.draftText, child.key).toContain(child.firstName);
    }
  });

  it("and the draft on the screen is that same text, so the absence is the rendered one", async () => {
    const queue = await queueOf([row(OPEN)]);
    const text = textOf(render({ openKey: OPEN, proposals: queue }));
    expect(text).toContain(queue[0].draftText);
    expect(queue[0].draftText).not.toMatch(CLOCK);
  });

  it("an Edit to the time changes the card's Time row and not the words", async () => {
    /*
     * The one case where a clock could leak in by the back door: Edit re-renders the body for a
     * new time. It must move the row a coordinator reads and leave the sentence alone.
     */
    const edited = await approvalQueue({
      db: execOf([row(OPEN)]),
      siteIds: [SITE],
      day,
      editedTime: "17:45",
    });
    expect(edited[0].timeTo).toBe("5:45 PM");
    expect(edited[0].draftText).not.toMatch(CLOCK);
  });
});
