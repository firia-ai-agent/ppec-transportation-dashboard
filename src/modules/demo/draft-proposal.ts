/**
 * THE DEMO DAY'S ONE CARD, DRAFTED BY THE MODEL — not seeded as fixed copy.
 *
 * Firia, 2026-10-18 11:04 AM ET, on the founder's complaint: the drop-off reply card was the fixed
 * `dropoff.changed` template ("PPEC: Yes — {childName} gets off at {stopLabel} today.") and it did
 * not answer what Dara asked. She asked for five o'clock. So the card the walked demo opens on is
 * written by **the real agent turn over her real text** — `demoAgentTurn`, the configured
 * OpenRouter model, the real gateway, the real policy engine — and the reply on it is the model's
 * own sentence, carried on `propose_dropoff_change`'s `reply` argument.
 *
 * ## Why this is not in the seed, and must never be
 *
 * `demo/seed.ts` runs inside one transaction and **Restart has to finish**. A vendor call in there
 * is a reset that hangs when OpenRouter is slow, fails when the key is missing, and rolls the whole
 * day back when the model errors — for the sake of one sentence. So the order is: the reset commits
 * the day with no proposal on it, and then this module drafts the card, outside the transaction,
 * with its own timeout (`DRAFT_TIMEOUT_MS`). Every way the model can fail — refused wiring, a
 * timeout, a gateway rejection, a blocked call, a reply that breaks the shape — ends in the copy
 * fallback (`familyTexts.dropoffReplyFallback`), which names the parent, the child and the time
 * they asked for. There is always exactly one card.
 *
 * ## Exactly one card, however many times this runs
 *
 * Two callers run it: the reset route, right after the day is written, and the Family texts page on
 * its first load — because a preview's database is read-only for the webhook, and a founder who
 * reloads the screen before the route finished must still see a card. Both are safe because the row
 * is written on the demo's own id (`demoId(KIND.approvalRequest, 1)`) with `ON CONFLICT DO
 * NOTHING`, and because the first thing this function does is look for that row. Two concurrent
 * drafts therefore cost two model calls at worst and write one row.
 *
 * ## What it never does
 *
 * It does not read the parent's sentence for a time or a place (`no-keyword-fallback.test.ts`): the
 * change is the model's own schema-validated arguments or it is the day's scripted request, and
 * never prose. It does not log, return or store the key — nothing here ever sees it, because the
 * key is read inside `providers/remote.ts` (`key-never-leaves.test.ts`). And it is demo-only: the
 * gates are `APP_DATA_CLASS=SYNTHETIC` here plus the §2.5A demo-data guard inside `chooseProvider`,
 * so an unconfirmed deployment produces the fallback card and no vendor call at all.
 */
import type { Db } from "@/db/exec";
import type { ServiceDay } from "@/domain/board/day";
import { isSyntheticDemo } from "@/lib/env";
import { isReplyText } from "@/modules/messaging/reply-text";
import { fill, familyTexts } from "@/ui/copy";
import { demoAgentTurn, type TurnInput } from "./agent-turn";
import { demoChangeRequests, type DemoChangeRequest } from "./change-request";
import { seedDemoChangeRequest, type SeededApproval } from "./approval-seed";
import { KIND, demoId } from "./fixtures/standard";

/**
 * How long the demo waits for the model before it drafts the card from copy instead.
 *
 * Eight seconds is a founder pressing Restart and watching: long enough for a model that is
 * answering, short enough that nobody wonders whether the button worked. The turn that loses the
 * race is abandoned, not awaited — it writes nothing, so there is nothing to undo.
 */
export const DRAFT_TIMEOUT_MS = 8_000;

/** What the drafting step did, for the route's log line and for a test to assert on. */
export type DraftedProposal = {
  /** The row, or null when the day has no change request or its leg is not in this database. */
  readonly approval: SeededApproval | null;
  /** True when the row this call found was already there: a second run drafts nothing. */
  readonly alreadyDrafted: boolean;
  /** True when the words on the card are the model's own, false when they are the copy fallback. */
  readonly modelWritten: boolean;
};

export type DraftDeps = {
  readonly siteId: string;
  readonly serviceDate: string;
  readonly day: ServiceDay;
  readonly env?: Record<string, string | undefined>;
  readonly now?: Date;
  /** A provider to drive instead of the configured one. Tests only; production passes none. */
  readonly provider?: TurnInput["provider"];
  readonly timeoutMs?: number;
};

/**
 * Draft the demo day's one proposal, if it is not drafted already.
 *
 * Never throws: a caller is a page render or a reset route, and neither has anything useful to do
 * with a drafting failure. A database that will not take the row answers `null` and the screen's
 * own empty state says there is nothing waiting.
 */
export async function draftDemoProposal(db: Db, a: DraftDeps): Promise<DraftedProposal> {
  const none: DraftedProposal = { approval: null, alreadyDrafted: false, modelWritten: false };
  if (!isSyntheticDemo(a.env ?? process.env)) return none;
  const request = demoChangeRequests(a.day)[0];
  if (!request) return none;

  try {
    if (await alreadyDrafted(db, request)) {
      return { approval: null, alreadyDrafted: true, modelWritten: false };
    }
    // THE MODEL CALL, OUTSIDE EVERY TRANSACTION. Below this line nothing can take longer than a write.
    const drafted = await modelReply(request, a);
    const replyText = drafted ?? fallbackReply(request);
    const approval = await db.tx((tx) =>
      seedDemoChangeRequest(tx, {
        siteId: a.siteId,
        serviceDate: a.serviceDate,
        day: a.day,
        replyText,
      }),
    );
    return { approval, alreadyDrafted: false, modelWritten: drafted !== null };
  } catch {
    /*
     * A read-only preview, a database that is away, a row another request wrote between the check
     * and the write. None of them is worth a 500 on a demo screen, and none of them can produce a
     * second card: the insert is `ON CONFLICT DO NOTHING` on one fixed id.
     */
    return none;
  }
}

/** Is the day's one card already in the database? Its id is the demo's own, so this is one read. */
async function alreadyDrafted(db: Db, request: DemoChangeRequest): Promise<boolean> {
  const r = await db.query<{ id: string }>("SELECT id FROM ops.approval_request WHERE id = $1", [
    request.approvalId,
  ]);
  return r.rows.length > 0;
}

/**
 * The model's reply to this parent, or null when no model answered in time.
 *
 * Null for every one of the ways that can happen, deliberately undifferentiated here: the wiring
 * refused (no key, an unconfirmed demo deployment), every attempt failed, the gateway rejected the
 * turn, the policy engine blocked the call, the model called a different tool, it proposed no
 * drop-off, it wrote no reply, the reply broke the shape, or the whole thing took longer than the
 * timeout. The card is the same in all nine cases, so the caller has one branch and not nine.
 */
async function modelReply(request: DemoChangeRequest, a: DraftDeps): Promise<string | null> {
  const turn = await withTimeout(
    demoAgentTurn({
      childKey: request.childKey,
      // Her own words, as the day's script holds them — read by the model, parsed by nothing.
      text: request.parentText,
      day: a.day,
      env: a.env,
      now: a.now,
      provider: a.provider,
    }),
    a.timeoutMs ?? DRAFT_TIMEOUT_MS,
  );
  if (turn === null || turn.modelUnavailable) return null;
  // A proposal and nothing else: a blocked turn, another tool, or a call that asked for no
  // drop-off has written no reply this card could carry.
  if (turn.verdict === "BLOCK" || turn.dropoff === null) return null;
  const reply = turn.args.reply;
  return isReplyText(reply) ? String(reply).trim() : null;
}

/**
 * The copy fallback: the same answer, in the same voice, from `src/ui/copy.ts`.
 *
 * Filled from the day's own fixtures — the guardian's given name, the child's given name and the
 * time the parent asked for, as a person reads it. Held to the same shape as the model's own reply
 * (`reply-text.ts`), so the one thing that cannot happen is a fallback card that the egress door
 * would then refuse to send.
 */
export function fallbackReply(request: DemoChangeRequest): string {
  const text = fill(familyTexts.dropoffReplyFallback, {
    // "Dara O." → "Dara": the given name, as the sentence addresses her.
    parentName: request.guardianName.split(/\s+/)[0] ?? "",
    childName: request.childFirstName,
    // Already formatted for a person by `change-request.ts` ("5:00 PM"), through the day's clock.
    eta: request.timeTo,
  });
  return isReplyText(text) ? text : "";
}

/** `promise`, or null if it has not answered within `ms`. The loser is abandoned, never awaited. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        // A refusal is a result: the card is drafted from copy and the demo goes on.
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The demo's one approval id, for a caller that wants to look for the card itself. */
export const DEMO_APPROVAL_ID = demoId(KIND.approvalRequest, 1);
