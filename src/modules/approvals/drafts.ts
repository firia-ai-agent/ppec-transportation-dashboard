/**
 * THE DRAFTS ONE APPROVAL HAS HAD, and the one of them the card is showing.
 *
 * A drop-off proposal used to carry exactly one sentence — the model's, as `vars.replyText` — and
 * the card's time field was a separate `GET` that re-rendered the page around it. So a coordinator
 * who moved the time to 5:45 and pressed Approve without retyping sent the model's sentence about
 * five o'clock with the leg moved to 5:45: the right ride and the wrong words, which is the bug
 * this module exists to make impossible (2026-10-18, Veri's S1).
 *
 * The fix is not a parser. Nothing here reads a time out of anybody's sentence — there is no
 * keyword reader in this app (`agent/no-keyword-fallback.test.ts`) and this is not one. Instead
 * **every draft is stored with the time it was written for**, so "are these words about this
 * time?" is a lookup rather than a guess, and the decision can refuse a draft that belongs to a
 * time nobody is approving (`decide.DRAFT_FOR_OTHER_TIME`).
 *
 * ## Where they live, and why there is no column
 *
 * In the proposal jsonb the agent already writes — `ops.approval_request.proposal.drafts` — and
 * nowhere else. No migration, no new column, no second table: the list is a property of the
 * proposal, it is read by the same `SELECT a.proposal` every reader already makes, and it is
 * written by one guarded `UPDATE` (`redraft.ts`).
 *
 * ## Seeded lazily, so every row already has one
 *
 * A row written before this existed — and every row the agent's own writer and the demo seed
 * write, which carry `vars.replyText` and no list — answers `draftsOf` with a single `original`
 * entry built from its own fields. There is no migration and no backfill, and a reader cannot
 * tell the two apart: `latestDraft` of an un-redrafted row is the model's sentence at the time it
 * was proposed, which is exactly what the card showed before any of this.
 */

/** A 24-hour wall-clock time — the only shape a drop-off time takes anywhere in this module. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether a value is a wall clock. The one definition the approvals module checks times with. */
export function isClock(value: unknown): value is string {
  return typeof value === "string" && CLOCK.test(value);
}

/**
 * Who wrote a draft. Provenance for the decision's record (`proposal.decision_detail`), and never
 * a thing anything decides on: what a draft is *for* is its `time`, and what it says is its
 * `text`.
 */
export type DraftSource =
  /** The sentence the proposal was written with (`propose_dropoff_change.reply`). */
  | "original"
  /** A model redraft for a new time, through the port in `redraft.ts`. */
  | "model"
  /** The copy line the agent's own fallback uses, for the new time (`agent/alert-words.ts`). */
  | "fallback"
  /** The coordinator's own words, kept exactly as they typed them across a time change. */
  | "coordinator";

const SOURCES: readonly DraftSource[] = ["original", "model", "fallback", "coordinator"];

/** One draft, and the time it was written for. */
export type StoredDraft = {
  /** "HH:MM", or null for a proposal that moves only the place. */
  readonly time: string | null;
  /** The sentence alone, trimmed — never the rendered body, which carries the `PPEC:` prefix. */
  readonly text: string;
  readonly source: DraftSource;
  /** When it was written, ISO. "" for the lazily seeded original, whose minute is the row's own. */
  readonly at: string;
};

/**
 * The fields of a proposal this module reads. Structural rather than the `DropoffProposal` type
 * in `decide.ts`, so a caller that has only just built the jsonb can ask too.
 */
export type DraftedProposal = {
  readonly drafts?: unknown;
  readonly vars?: Readonly<Record<string, unknown>> | null;
  readonly requested_dropoff_time?: string | null;
};

/**
 * HOW MANY DRAFTS ONE APPROVAL KEEPS.
 *
 * A coordinator who moves the time five times writes five drafts, and the list is read on every
 * render — so it is bounded. The **first** entry survives every trim whatever happens to the
 * middle: it is the model's own sentence, the one this bug was about sending by accident, and the
 * backstop in `decide.ts` can only refuse a draft it can still see.
 */
export const DRAFTS_KEPT = 20;

/**
 * The drafts this proposal has had, oldest first — never empty for a proposal whose words are a
 * drafted sentence, and always empty for one whose words are the centre's fixed copy.
 *
 * Read defensively, like every other field of a row that outlives the code that wrote it: an entry
 * with no sentence in it is dropped rather than rendered, a time that is not a wall clock becomes
 * null rather than a string nobody can compare, and a `drafts` that is not an array at all is a
 * row with no list — which is seeded from its own fields below.
 */
export function draftsOf(proposal: DraftedProposal): readonly StoredDraft[] {
  const stored = Array.isArray(proposal.drafts)
    ? proposal.drafts.map(oneDraft).filter((d): d is StoredDraft => d !== null)
    : [];
  if (stored.length > 0) return stored;
  const seeded = seededOriginal(proposal);
  return seeded === null ? [] : [seeded];
}

/** The draft the card is showing: the newest one, or null when this proposal has no sentence. */
export function latestDraft(proposal: DraftedProposal): StoredDraft | null {
  const drafts = draftsOf(proposal);
  return drafts.length === 0 ? null : drafts[drafts.length - 1];
}

/**
 * The list with one more draft on the end, trimmed to `DRAFTS_KEPT` and keeping the first.
 *
 * Written straight into `proposal.drafts` by `redraft.ts`; nothing else appends, which is why
 * there is one function rather than a spread at the call site.
 */
export function withDraft(
  proposal: DraftedProposal,
  draft: StoredDraft,
): readonly StoredDraft[] {
  const all = [...draftsOf(proposal), draft];
  if (all.length <= DRAFTS_KEPT) return all;
  // The original, then the newest of the rest: a middle draft nobody is looking at is what goes.
  return [all[0], ...all.slice(all.length - (DRAFTS_KEPT - 1))];
}

/** One stored entry, or null for one this reader will not vouch for. */
function oneDraft(value: unknown): StoredDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const d = value as Record<string, unknown>;
  const text = typeof d.text === "string" ? d.text.trim() : "";
  if (text === "") return null;
  const source = SOURCES.find((s) => s === d.source) ?? "original";
  return {
    time: isClock(d.time) ? d.time : null,
    text,
    source,
    at: typeof d.at === "string" ? d.at : "",
  };
}

/**
 * The model's own sentence as the list's first entry, for a row that has no list yet.
 *
 * Its time is `vars.eta` where the row has one and the time the family asked for otherwise, which
 * is the pair every other reader of this row already treats as "the time these words are about"
 * (`decide.sendShape` renders the body from `vars` and moves the leg to
 * `requested_dropoff_time`).
 */
function seededOriginal(proposal: DraftedProposal): StoredDraft | null {
  const vars = proposal.vars ?? {};
  const text = typeof vars.replyText === "string" ? vars.replyText.trim() : "";
  if (text === "") return null;
  const time = isClock(vars.eta)
    ? vars.eta
    : isClock(proposal.requested_dropoff_time)
      ? proposal.requested_dropoff_time
      : null;
  return { time, text, source: "original", at: "" };
}
