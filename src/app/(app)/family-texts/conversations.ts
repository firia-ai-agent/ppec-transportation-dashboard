/**
 * WHAT THE FAMILY TEXTS SCREEN RENDERS — the whole view model, in one pure module.
 *
 * The screen is an iMessage thread (mockups/family-texts.html) and a queue of proposals
 * (mockups/approvals.html, which is this screen's "For you" tab and not a page of its own). Both
 * shapes are computed here, from data the page hands in, so every component under this folder is
 * markup over a plain object and the hard parts — who wrote a bubble, where a run of bubbles ends,
 * which proposal belongs to which thread — are testable without a browser.
 *
 * Three rules this module exists to keep:
 *
 *  1. **"Auto · Delivered" is earned, not assumed** (Firia's gate 4). A run of bubbles carries
 *     that meta line only when its author is `AUTO`, which `thread.ts` reads off the template the
 *     body was rendered from (`messaging/auto-sends.ts`). An approved reply and a staff reply are
 *     both `STAFF` and get no auto label, ever.
 *  2. **A proposal is never shown when the assistant is unreachable** (gate 5). The page hands in
 *     whether a model can be reached at all; with no model there is no card, and the "needs a
 *     person" alert is what the tab shows instead. That is a property of this function rather
 *     than a condition some component remembers to write.
 *  3. **No provider name, no raw state, no enum** in anything a bubble or a pill renders (gate 6).
 *     Every word here is `src/ui/copy.ts` or a value the fixtures already print on a staff screen
 *     (a person's name, a landmark, a clock time).
 *
 * It imports nothing from `@/modules/approvals/decide`, and that is structural rather than tidy:
 * the two client components under this folder import this module's *types*, and
 * `agent/key-never-leaves.test.ts` follows a type-only import the way a conservative bundler
 * would. Through `decide.ts` the walk reaches the agent's config — the module that holds the
 * key's name — so the one function that needed a database row's type (`proposalFromRow`) lives
 * on the page, which is server-only, and this module stays reachable from a browser safely.
 */
import { formatClock } from "@/domain/eta/eta";
import type { ServiceDay } from "@/domain/board/day";
import type { DemoChangeRequest } from "@/modules/demo/change-request";
import type { LateDropoff } from "@/modules/demo/late-dropoff";
import { approval, fill, familyTexts, onDay } from "@/ui/copy";
import type { Bubble, BubbleAuthor, Thread, ThreadSource } from "./thread";

/** The three tabs over the list. `for-you` is the approvals queue (REDESIGN-SPEC §9.2). */
export const TABS = ["for-you", "sent", "all"] as const;
export type TabKey = (typeof TABS)[number];

/** A `?tab=` value as a tab, defaulting to the whole list rather than refusing. */
export function tabFrom(value: string | undefined): TabKey {
  return TABS.find((t) => t === value) ?? "all";
}

/** The five pills a conversation row can wear. Every one is a fact about that row. */
export type RowState = "changeReady" | "needsYou" | "autoLate" | "autoDropped" | "done";

/** One row of the conversation list. */
export type ConversationRow = {
  /** The fixture child key: what `?thread=` names, and what the thread pane is keyed by. */
  readonly key: string;
  /** "DO" — initials off the adult's own name, never a code. */
  readonly initials: string;
  readonly adultName: string;
  readonly childFirstName: string;
  /** The time of the newest message in the thread. */
  readonly timeLabel: string;
  /** The newest message, one line, truncated by CSS rather than cut here. */
  readonly preview: string;
  readonly state: RowState;
  /** Something on this row nobody has read. Never the only cue (§9): the pill says it too. */
  readonly unread: boolean;
};

/** A run of bubbles from one author, as the thread draws it. */
export type BubbleRun = {
  readonly id: string;
  readonly side: "IN" | "OUT";
  readonly author: BubbleAuthor;
  /** The centred timestamp above the run: the day and the time it started. */
  readonly stampDay: string;
  readonly stampTime: string;
  /** The bubbles themselves. Only the last one gets a tail (the mockup's `.tail`). */
  readonly bubbles: readonly { readonly id: string; readonly body: string }[];
  /**
   * The meta line under the run, or null. "Auto · Delivered" on a templated follow-up the day
   * sent by itself, and on nothing else (gate 4).
   */
  readonly meta: string | null;
};

/** One proposal, as the card renders it: the two halves of the change, and the reply. */
export type ProposalView = {
  readonly approvalId: string;
  /** Which thread this proposal belongs in, so the thread pane can find its own. */
  readonly threadKey: string;
  readonly childLabel: string;
  readonly adultName: string;
  /** "Assistant · 3:58 PM" — who drafted it and when. */
  readonly draftedLabel: string;
  /** The stop. `from` is null when the place does not change, and then there is no arrow. */
  readonly stopFrom: string | null;
  readonly stopTo: string;
  /** The time, the same way round. */
  readonly timeFrom: string | null;
  readonly timeTo: string | null;
  /** The adult collecting the child, and whether that part changes. */
  readonly pickupLabel: string;
  /** The checks that passed, as chip labels. */
  readonly checks: readonly string[];
  /** The exact words the family would get. */
  readonly draftText: string;
  /** The proposed time as a 24-hour clock — the only shape the Edit control takes. */
  readonly requestedHhmm: string | null;
};

/** The thread pane: who it is with, the bubbles, and the proposal inside it. */
export type ThreadView = {
  readonly key: string;
  readonly initials: string;
  readonly adultName: string;
  readonly relationship: string;
  readonly childFirstName: string;
  readonly childLabel: string;
  readonly runs: readonly BubbleRun[];
  /** Inside the thread, under the last bubble — never in a pane of its own. */
  readonly proposal: ProposalView | null;
  readonly source: ThreadSource;
};

/* ───────────────────────────── the list ───────────────────────────── */

/** Initials off a staff-facing label: "Dara O." → "DO". Two letters at most. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /[A-Za-z]/.test(part))
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

/**
 * The conversation list: one row per family the day has texted, newest first.
 *
 * The rows are the day's own texts and nothing else. A list padded out to look busy would be a
 * list of families this centre has not texted, which is the one thing a screen quoting parents
 * must never invent — so five rows in the mockup and two rows on the demo day is the honest
 * answer, and it is the day that decides.
 */
export function conversationRows(
  texts: readonly LateDropoff[],
  requests: readonly DemoChangeRequest[],
): readonly ConversationRow[] {
  const rows = texts.map((text) => {
    const request = requests.find((r) => r.childKey === text.childKey);
    const atMs = request ? request.askedAtMs : text.atMs;
    return {
      atMs,
      row: {
        key: text.childKey,
        initials: initialsOf(text.guardianName),
        adultName: text.guardianName,
        childFirstName: text.childFirstName,
        timeLabel: formatClock(atMs),
        preview: request ? request.parentText : text.body,
        // A family who has asked for something has a change ready to read; one who has not has
        // been told the van is late and that is all that has happened to them.
        state: (request ? "changeReady" : "autoLate") as RowState,
        unread: request !== undefined,
      } satisfies ConversationRow,
    };
  });
  // Newest first, on the instant rather than on the label: "11:00 AM" sorts above "4:30 PM" as
  // a string, which would put the morning at the top of an afternoon's list.
  return rows.sort((a, b) => b.atMs - a.atMs).map((r) => r.row);
}

/* ───────────────────────────── the thread ───────────────────────────── */

/** How long a pause has to be before the thread starts a new run (the mockup's grouping). */
const RUN_GAP_MS = 5 * 60 * 1000;

/**
 * The bubbles, grouped into runs.
 *
 * A run is consecutive bubbles from the same author with no long pause between them. That is what
 * gives the mockup its shape: one centred timestamp per run, 2 px between bubbles inside it, a
 * tail on the last one only, and one meta line underneath. Grouping is here rather than in the
 * component because it is the only arithmetic on this screen, and a component cannot be asked
 * about it without a renderer.
 */
export function runsOf(bubbles: readonly Bubble[], dayLabel: string): readonly BubbleRun[] {
  const runs: BubbleRun[] = [];
  let open: { side: "IN" | "OUT"; author: BubbleAuthor; stamp: string; items: { id: string; body: string }[]; atMs: number } | null = null;

  for (const bubble of bubbles) {
    const atMs = msOf(bubble);
    const sameRun =
      open !== null &&
      open.side === bubble.direction &&
      open.author === bubble.author &&
      Math.abs(atMs - open.atMs) <= RUN_GAP_MS;
    if (open && sameRun) {
      open.items.push({ id: bubble.id, body: bubble.body });
      continue;
    }
    if (open) runs.push(closeRun(open, dayLabel, runs.length));
    open = {
      side: bubble.direction,
      author: bubble.author,
      stamp: bubble.timeLabel,
      items: [{ id: bubble.id, body: bubble.body }],
      atMs,
    };
  }
  if (open) runs.push(closeRun(open, dayLabel, runs.length));
  return runs;
}

function closeRun(
  open: { side: "IN" | "OUT"; author: BubbleAuthor; stamp: string; items: { id: string; body: string }[] },
  dayLabel: string,
  index: number,
): BubbleRun {
  return {
    id: `run-${index}`,
    side: open.side,
    author: open.author,
    stampDay: dayLabel,
    stampTime: open.stamp,
    bubbles: open.items,
    // Gate 4, in one line: the label is a claim about who sent it, and only `AUTO` earns it.
    meta: open.author === "AUTO" ? familyTexts.autoDelivered : null,
  };
}

/**
 * A bubble's instant, for grouping only.
 *
 * The bubble carries a *label* ("3:58 PM") rather than an instant, because that is what a screen
 * needs; grouping needs an order, and the labels are already in order, so the index of the bubble
 * in the thread is a sound ordering and the gap test falls back to "same run" when two bubbles
 * share a minute. Parsing the label back into a Date would be the wrong kind of clever: it would
 * re-introduce a timezone into a module that has none.
 */
function msOf(bubble: Bubble): number {
  const digits = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(bubble.timeLabel);
  if (!digits) return 0;
  const hour = (Number(digits[1]) % 12) + (digits[3] === "PM" ? 12 : 0);
  return (hour * 60 + Number(digits[2])) * 60_000;
}

/* ───────────────────────────── the proposal ───────────────────────────── */

/**
 * The demo day's proposal, as the card renders it.
 *
 * The stop does not move in this request, so `stopFrom` is null and the row reads as one place.
 * The checks are the three the plan can actually answer for a time-only change on the same van:
 * the van does not change, the ride still fits it, and the adult collecting the child is the one
 * already on file. None of them is a guess, and none of them is a state code.
 */
export function proposalFromDemo(request: DemoChangeRequest): ProposalView {
  return {
    approvalId: request.approvalId,
    threadKey: request.childKey,
    childLabel: request.childLabel,
    adultName: request.guardianName,
    draftedLabel: fill(approval.draftedBy, { time: formatClock(request.draftedAtMs) }),
    stopFrom: null,
    stopTo: request.stopPlace,
    timeFrom: request.timeFrom,
    timeTo: request.timeTo,
    pickupLabel: fill(approval.pickupSame, { adult: request.guardianName }),
    checks: proposalChecks(request.guardianName),
    draftText: request.draftText,
    requestedHhmm: request.requestedHhmm,
  };
}

/** The three chips, in the order the mockup reads them. */
function proposalChecks(adultName: string): readonly string[] {
  return [approval.checkSameVan, approval.checkFits, fill(approval.checkOnFile, { adult: adultName })];
}

/* ───────────────────────────── putting it together ───────────────────────────── */

/**
 * The thread pane for one family.
 *
 * Two flags, and a card needs both. `assistantReachable` is gate 5: with no model there is no
 * card, whatever else is true, because nothing read the family's text. `mayApprove` is gate 8's
 * courtesy half: a role that cannot decide is shown no decision — in the thread as well as on the
 * tab, since a card with buttons the server will refuse is worse than no card. The thread itself
 * still renders either way: the texts that went out went out.
 */
export function threadView(a: {
  readonly selected: LateDropoff;
  readonly thread: Thread;
  readonly request: DemoChangeRequest | undefined;
  readonly day: ServiceDay;
  readonly assistantReachable: boolean;
  /** False for a role that may not decide: they get the thread and no card in it either. */
  readonly mayApprove: boolean;
}): ThreadView {
  const bubbles = a.request ? [...a.thread.bubbles, parentBubble(a.request)] : a.thread.bubbles;
  return {
    key: a.selected.childKey,
    initials: initialsOf(a.selected.guardianName),
    adultName: a.selected.guardianName,
    relationship: a.selected.relationship,
    childFirstName: a.selected.childFirstName,
    childLabel: a.selected.childLabel,
    runs: runsOf(bubbles, stampFor(a.day)),
    proposal: a.request && a.assistantReachable && a.mayApprove ? proposalFromDemo(a.request) : null,
    source: a.thread.source,
  };
}

/**
 * What the centred stamp calls the day: "Today" on the demo day, the date on any other.
 *
 * The §5 rule, through the same `onDay` the board's heading uses, so a thread from a finished day
 * cannot say "Today" (Veri #49).
 */
function stampFor(day: ServiceDay): string {
  return onDay({ today: familyTexts.stampToday, otherDay: familyTexts.stampOtherDay }, day);
}

/** The family's own reply, as a bubble. Their words, unread and unsummarized. */
function parentBubble(request: DemoChangeRequest): Bubble {
  return {
    id: `ask-${request.childKey}`,
    direction: "IN",
    author: "PARENT",
    timeLabel: formatClock(request.askedAtMs),
    body: request.parentText,
    delivery: null,
    reachedPhone: true,
  };
}
