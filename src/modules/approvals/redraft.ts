/**
 * A TIME CHANGE REDRAFTS THE REPLY — one POST, and the new sentence is stored with the time it was
 * written for (PPE-106 / PPE-107, Veri's S1 of 2026-10-18).
 *
 * ## What was wrong
 *
 * The Family texts card had two controls for one act. The drop-off time was a little `GET` form
 * that re-rendered the page — so it wiped anything typed in the reply box (PPE-107) — and the box
 * itself came back holding the model's ORIGINAL sentence. A coordinator who moved the drop-off to
 * 5:45 and pressed Approve without retyping moved the leg to 5:45 and queued the family words
 * naming five o'clock: the right ride and the wrong promise, in the model's voice.
 *
 * ## What happens now
 *
 * The time field and the reply box are one form, and changing the time submits it to this
 * function:
 *
 *  - **the coordinator's own words are never touched.** If the box differs from the draft it was
 *    showing, those words are the new draft for the new time, to the character. A time change is
 *    not permission to rewrite a person's sentence.
 *  - **otherwise the reply is redrafted for the new time** — the model through the port below, and
 *    the agent's own fallback line when no model answers.
 *  - **and the new draft is stored**, in the proposal jsonb the row already has
 *    (`drafts.ts`), so the card shows it, Approve sends it, and the decision can refuse a draft
 *    written for a time nobody is approving (`decide.DRAFT_FOR_OTHER_TIME`).
 *
 * Nothing here sends anything, moves any ride or decides anything. It writes one field of one
 * undecided row: the guard is `decided_at IS NULL` plus the site and the role, which is exactly
 * `decideApproval`'s own door, so a decided proposal cannot acquire a new draft and another
 * tenant's id is the same uniform 404 it is there.
 *
 * ## IS THE MODEL REDRAFT REAL? NOT YET, AND THE PORT IS WHY THE ANSWER IS ONE WORD
 *
 * `redraftPort` is the seam. The default (`noModelRedraftPort`) answers "nothing", which lands
 * every redraft on the fallback line — the same copy line, through the same function, that the
 * agent's own writer falls back to when a model's reply cannot be used
 * (`agent/alert-words.dropoffReplyWords`). A deployment with no key behaves identically either
 * way, which is the case this had to get right first.
 *
 * It is a port and not a call because a model redraft from this surface is not clean today, and
 * three separate rules in this codebase say so rather than one opinion:
 *
 *  1. **no server action may spend a model call** (`agent/vendor-failure-panel.test.ts`, check 5
 *     part 5: "a model call belongs on the queue (`/api/queues/agent`), not behind a button").
 *     This redraft is behind a button.
 *  2. **the decision action may not reach a vendor at all** (`agent/key-never-leaves.test.ts`
 *     asserts the Family texts server action's import graph does not reach `providers/remote.ts`).
 *     A gateway on this path would be that import.
 *  3. **the catalog has no redraft tool.** The only argument that carries a reply to a family is
 *     `propose_dropoff_change.reply`, whose schema also requires a leg, a rationale code, an
 *     alert line, a source message id and a plan version — so a redraft would have to fake a
 *     whole new proposal call to get one sentence back, and the gateway's own rate window is
 *     per-run rather than per-press.
 *
 * So when the model redraft lands it lands on the agent's side of that line — a run triggered by
 * the press, writing the draft through this same function — and this port is where it plugs in.
 * Until then the fallback is the honest answer: a sentence that names the new time, in the voice
 * the family already reads, held to the same `replyTextIssue` shape as the model's own.
 */
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import { APPROVAL_ROLES } from "@/auth/access";
import type { Exec } from "@/db/exec";
import { dropoffReplyWords } from "@/modules/agent/alert-words";
import { replyTextIssue } from "@/modules/messaging/reply-text";
import { bodyOf, editableReply, type DecideError } from "./decide";
import { DROPOFF_CHANGE_KIND } from "./dropoff-change";
import { draftsOf, isClock, latestDraft, withDraft, type DraftSource } from "./drafts";

/**
 * WHAT THE PORT IS ASKED, and it is three code-shaped values.
 *
 * Token-only by construction: the child as the operational tables name them, a wall clock, and the
 * sentence already on the card — which has been through `replyTextIssue` at every door it came in
 * by. No word of what the family typed reaches here, so a model port built on this cannot be the
 * thing that puts a parent's own text in a prompt.
 */
export type RedraftAsk = {
  readonly childToken: string;
  /** The new drop-off time, "HH:MM". */
  readonly time: string;
  /** The draft being replaced, so a port can be asked to say the same thing about a new minute. */
  readonly previous: string;
};

/** A redrafter: the new sentence, or null for "nobody answered" — which is the fallback. */
export type RedraftPort = (ask: RedraftAsk) => Promise<string | null>;

/** The default: no model is asked from this surface at all (see this file's header). */
export const noModelRedraftPort: RedraftPort = async () => null;

/** How long a redraft waits for a port before it writes the fallback line instead. */
export const REDRAFT_TIMEOUT_MS = 4_000;

export type RedraftDeps = {
  readonly model: RedraftPort;
  readonly timeoutMs: number;
};

export const redraftDeps = (over: Partial<RedraftDeps> = {}): RedraftDeps => ({
  model: over.model ?? noModelRedraftPort,
  timeoutMs: over.timeoutMs ?? REDRAFT_TIMEOUT_MS,
});

export type RedraftRequest = {
  readonly userId?: string;
  readonly approvalId: string;
  /** The time field as the one form carried it. */
  readonly time: string;
  /** Whatever is in the reply box right now — their words, or the draft it was showing. */
  readonly boxText: string;
  readonly now: Date;
};

export type RedraftResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly ok: true;
        /** The sentence to put in the box. */
        readonly text: string;
        /** The same sentence as the card's bubble, through the one renderer — what Approve posts
         * back as the words that were on screen (`decideApproval`'s `approvedText`). */
        readonly body: string;
        readonly time: string;
        readonly source: DraftSource;
      };
    }
  | { readonly status: 401 | 403 | 404 | 409 | 422; readonly body: { readonly ok: false; readonly error: DecideError } };

type Row = {
  id: string;
  site_id: string;
  decided_at: Date | string | null;
  proposal: {
    kind?: string;
    child_token?: string;
    template_id?: string;
    vars?: Record<string, unknown>;
    drafts?: unknown;
    requested_dropoff_time?: string | null;
  };
  display_name: string | null;
};

/**
 * REDRAFT THE REPLY FOR A NEW TIME, and store it as this proposal's newest draft.
 *
 * Answers `{status, body}` like `decideApproval` and throws for nothing a caller can be told
 * about, so the screen always has a sentence to show. The codes are that function's own
 * (`DecideError`), because they are the same refusals about the same row and a second vocabulary
 * for them would be a second set of words on screen.
 */
export async function redraftReply(
  db: Exec,
  req: RedraftRequest,
  deps: RedraftDeps = redraftDeps(),
): Promise<RedraftResponse> {
  if (!req.userId) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
  if (!isClock(req.time)) return { status: 422, body: { ok: false, error: "NOT_A_TIME" } };

  const found = await db.query<Row>(
    `SELECT a.id, a.site_id, a.decided_at, a.proposal, c.display_name
     FROM ops.approval_request a
     LEFT JOIN ops.child_profile c
       ON c.child_token = (a.proposal ->> 'child_token')::uuid AND c.site_id = a.site_id
     WHERE a.id = $1`,
    [isUuid(req.approvalId) ? req.approvalId : null],
  );
  const row = found.rows[0];
  if (!row) return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };

  /*
   * The same door `decideApproval` opens: the named role constant AND the caller's membership at
   * the approval's own site. Another site's id answers 404 exactly as an id that exists nowhere,
   * because a 403 would tell a caller that the id is real.
   */
  try {
    await requireSiteAccess(db, req.userId, row.site_id, APPROVAL_ROLES);
  } catch (e) {
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: "NOT_YOUR_ROLE" } };
    throw e;
  }

  const proposal = row.proposal ?? {};
  // A decided proposal has no draft to change. The UPDATE below is guarded on the same fact; this
  // is the answer a coordinator reads rather than a write that silently matched no row.
  if (row.decided_at !== null) return { status: 409, body: { ok: false, error: "ALREADY_DECIDED" } };
  /*
   * Only where the card's body IS a drafted sentence — `editableReply`, the same function the
   * decision asks before it accepts an edited reply and the same one the card renders its box on.
   * A fixed-copy template has no sentence to redraft: its body is the centre's own words, rendered
   * from the time, so moving the time moves the words with it and there is nothing to ask anybody.
   */
  const showing = proposal.kind === DROPOFF_CHANGE_KIND ? editableReply(proposal) : null;
  if (showing === null) return { status: 422, body: { ok: false, error: "TEXT_NOT_EDITABLE" } };

  const typed = req.boxText.trim();
  /*
   * HAVE THEY TYPED? The box against the draft it was showing — the LATEST stored draft, which is
   * what the card prefilled it with. Anything else is a person's own sentence and is kept to the
   * character; a time change may move a ride, and may not rewrite somebody's words.
   */
  const theirs = typed !== "" && typed !== showing;
  const latest = latestDraft(proposal);

  /*
   * NOTHING TO REDRAFT. The press carries the draft it was given, for the minute it was written
   * for — somebody pressed "Update the time" without changing anything. The sentence is said back
   * and the row is not touched: no model is asked, no draft is appended, and the model's own
   * words are not quietly replaced by a plainer line for a press that asked for nothing.
   */
  if (!theirs && (latest?.time ?? null) === req.time) {
    return {
      status: 200,
      body: {
        ok: true,
        text: showing,
        body: bodyOf(proposal, req.time, row.display_name),
        time: req.time,
        source: latest?.source ?? "original",
      },
    };
  }

  const written = theirs
    ? { text: typed, source: "coordinator" as DraftSource }
    : await redrafted(deps, {
        childToken: String(proposal.child_token ?? ""),
        time: req.time,
        previous: showing,
      });

  /*
   * EVERY STORED DRAFT IS SENDABLE (the ruling PPE-97 settled, applied one step earlier).
   *
   * `replyTextIssue` is the one shape check — no phone number, no link, no address, no code, no
   * `PPEC:` prefix, no line break, `REPLY_TEXT_MAX` — and it runs here on whatever is about to
   * become a draft, whoever wrote it. So the box never fills with words Approve would refuse, and
   * a coordinator's unsendable sentence is a refusal they can fix in the field in front of them
   * rather than one that waits until the press.
   */
  if (replyTextIssue(written.text) !== null) {
    return { status: 422, body: { ok: false, error: "TEXT_NOT_SENDABLE" } };
  }

  const drafts = withDraft(proposal, {
    time: req.time,
    text: written.text,
    source: written.source,
    at: req.now.toISOString(),
  });
  /*
   * ONE FIELD OF ONE UNDECIDED ROW, in the jsonb that is already there — no column, no second
   * table, no migration. Guarded on `decided_at IS NULL` and the site, so a proposal somebody
   * decided while this was being typed takes no draft and the coordinator is told.
   */
  const stored = await db.query<{ id: string }>(
    `UPDATE ops.approval_request
     SET proposal = jsonb_set(proposal, '{drafts}', $3::jsonb, true),
         updated_at = $4, updated_by = $5, version = version + 1
     WHERE id = $1 AND site_id = $2 AND decided_at IS NULL
     RETURNING id`,
    [row.id, row.site_id, JSON.stringify(drafts), req.now, `staff:${req.userId}`],
  );
  if (stored.rows.length !== 1) {
    return { status: 409, body: { ok: false, error: "ALREADY_DECIDED" } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      text: written.text,
      // The bubble, through the decision model's own renderer over the row AS IT NOW IS: the card
      // posts this back with the press, and `decideApproval` refuses a press whose words are not
      // the ones it renders (`MESSAGE_CHANGED`). One renderer, so they cannot differ.
      body: bodyOf({ ...proposal, drafts }, req.time, row.display_name),
      time: req.time,
      source: written.source,
    },
  };
}

/**
 * The model's new sentence, or the agent's own fallback line for the new time.
 *
 * Four ways to land on the fallback and they are one branch: no port wired, a port that answered
 * nothing, a port that threw, and a port that took longer than `timeoutMs`. A coordinator waiting
 * on a box does not wait on a vendor, and every one of the four is the same honest sentence rather
 * than an error on a card.
 *
 * The fallback is `dropoffReplyWords` with no reply in hand — the identical call the agent's
 * proposal writer makes when a model's reply cannot be used — so the words a redraft falls back to
 * are the words the card would have been born with, naming the new time through the one clock
 * helper (`familyTexts.dropoffReplyFallback`, `sayClock`).
 */
async function redrafted(
  deps: RedraftDeps,
  ask: RedraftAsk,
): Promise<{ text: string; source: DraftSource }> {
  const answer = await asked(deps, ask);
  if (answer !== null && replyTextIssue(answer) === null) return { text: answer, source: "model" };
  const fallback = dropoffReplyWords({ reply: null, childToken: ask.childToken, requestedTime: ask.time });
  return { text: fallback.text, source: "fallback" };
}

/** One port call, bounded. Null for every way of not getting a usable sentence back. */
async function asked(deps: RedraftDeps, ask: RedraftAsk): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      deps.model(ask),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deps.timeoutMs);
      }),
    ]);
    const written = typeof answer === "string" ? answer.trim() : "";
    return written === "" ? null : written;
  } catch {
    // A port that threw is a port that did not answer. The reason is the port's to log; a vendor's
    // own words are never carried out of here (`agent/gateway.ts` holds the same line).
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A uuid, so a non-uuid id is a clean not-found rather than a Postgres cast error. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
