"use client";

import { useActionState, type ReactNode } from "react";
import { Check, Pencil, X } from "lucide-react";
import { REPLY_TEXT_MAX } from "@/modules/messaging/reply-text";
import { approval, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { DecideAction, DecisionState, RedraftAction, RedraftState } from "./actions";
import type { ProposalView } from "./conversations";
import styles from "./texts.module.css";

/**
 * THE APPROVE CARD, rendered inside the thread, under the message it answers.
 *
 * Four things and nothing else: **who the reply goes to** ("Reply to Dara"), **the message as a
 * bubble**, **one line of what the plan changes**, and **the three buttons**, worded exactly as
 * mockups/approvals.html words them. Vera's card (7:51 AM ET) was the first three minus the line;
 * the line arrived with Firia's 11:11 AM ruling, because Approve stopped being only a send — it
 * moves the leg's drop-off time, the placement and the receiver on the child's file, and a
 * coordinator signing for that has to be able to read it without knowing the plan by heart.
 *
 * ## What came off it, and why that is not a loss
 *
 *  - **The Stop / Time / Pick-up table.** The message already says what changes, in the words
 *    the family will read. The table said it again in a shape only somebody who already knew the
 *    plan could check, and it put a clock time on the card — which is the "NO Time row" half of
 *    the ruling, in the one place a stray time was still being drawn.
 *  - **The green check chips.** They were facts, and they are still facts: `queue.ts` computes
 *    them and `real-card-only.test.ts` holds them. A row of ticks over a decision is the screen
 *    reassuring itself, and a coordinator who trusts the ticks is not reading the sentence.
 *  - **"The text the family will get".** A label on a bubble that already looks like a text.
 *    The region's accessible name (`approval.cardLabel`) says it once, for a reader who cannot
 *    see that it is a bubble.
 *
 * ## The three controls are still the whole of Firia's gates 1 and 2
 *
 *  - **Approve & send** posts to `decideApprovalAction`, which calls `decideApproval` and nothing
 *    else. One write path, for all three controls (gate 1).
 *  - **Edit** is a `GET` to this same screen. It writes nothing and sends nothing: it opens the
 *    state that has the fields on it, and the card comes back *pending*, so **an edited message
 *    needs a fresh approval** (gate 2). Edit changes the words and only the words — it moves no
 *    ride, because the ride is saved by the decision and by nothing else.
 *  - **Don't send** posts the same action with `DECLINED`: the decision is written and nothing
 *    else happens.
 *
 * ## ONE FORM HOLDS THE TIME AND THE REPLY (PPE-107, Veri's S1 of 2026-10-18)
 *
 * The time used to be a little `GET` form of its own. Two things were wrong with that and both
 * were the same thing: it re-rendered the page, so it wiped anything typed in the reply box; and
 * the box came back holding the model's ORIGINAL sentence, so a coordinator who moved the
 * drop-off to 5:45 and pressed Approve without retyping moved the ride to 5:45 and promised the
 * family five o'clock.
 *
 * So the time field is inside the form that approves, and its own button submits that form to
 * `redraftReplyAction` instead — a POST, never a GET, because it writes: the reply is redrafted
 * for the new time and stored as this proposal's newest draft
 * (`modules/approvals/redraft.ts`). What comes back is the sentence, which this card puts in the
 * box and in the bubble before anything is approved, so the words a person signs are the words
 * they just read. Typed words are kept exactly — the server compares the box to the draft it was
 * showing — and a refusal carries the box back rather than clearing it.
 *
 * The decision's own press is unchanged and is still the only thing that sends: the time field,
 * the box and both buttons are one POST to `decideApprovalAction`, and a press whose words were
 * drafted for another time is refused there (`approval.retypeForNewTime`) rather than sent.
 *
 * ## The reply itself is editable (PPE-97, founder's ruling of 2026-10-18)
 *
 * In the Edit state the draft is a `<textarea>` holding the whole sentence, and that field is
 * **inside the Approve form**. So there is one press and it is the approval: the words a
 * coordinator typed are submitted by the button that decides, and there is no save-the-draft
 * endpoint, no second send path and nothing stored between the two. The same shape check the
 * model's own reply passed and the 320-character cap run server-side in `decideApproval` on
 * exactly these words; `maxLength` here is a courtesy to the typist and nothing is enforced in
 * this file.
 *
 * The field appears only where `proposal.draftReplyText` is non-null — `decide.editableReply`'s
 * answer, the same function the decision asks — so the card cannot offer to rewrite the centre's
 * own fixed copy, and the prefix the template adds (`PPEC:`) is not in the box.
 *
 * The plan line under the bubble is untouched by any of it: it is built from the **proposal** and
 * the placement the plan holds (`queue.ts`), never from the draft, because what a coordinator
 * signs for is the ride and not the sentence.
 *
 * Everything else is still `renderTemplate`'s output over the proposal's own template, which is
 * what keeps "no free text to a family" true of the approval path as well as the automatic one:
 * the one prose var on the one template, checked at every door it passes.
 */
export function ProposalCard({
  proposal,
  decide,
  redraft,
  editHref,
  editing = false,
  className,
}: {
  readonly proposal: ProposalView;
  readonly decide: DecideAction;
  /**
   * The redraft POST (PPE-107), for the card's own "Update the time" button.
   *
   * Optional, and absent exactly where the card has no field on it: the agent bubble renders this
   * card in its resting state (`ui/AgentThread.tsx`), where there is no time to change and Edit is
   * a link to this screen. With no action in hand the button is not drawn — a control that posted
   * nowhere would be worse than one more press on the way.
   */
  readonly redraft?: RedraftAction;
  /** Where Edit submits: this screen, with the thread and tab it is already on. */
  readonly editHref: string;
  /** True in the state Edit navigates to, which is the only state with a field on it. */
  readonly editing?: boolean;
  readonly className?: string;
}) {
  const [state, submit, pending] = useActionState<DecisionState, FormData>(decide, { status: "idle" });
  const [drafted, redraftSubmit, redrafting] = useActionState<RedraftState, FormData>(
    redraft ?? keepTheDraft,
    { status: "idle" },
  );
  /*
   * Whether this press carries a rewritten reply: the Edit state, on a card whose words are a
   * draft somebody may rewrite (PPE-97). `draftReplyText` is `decide.editableReply`'s answer, so
   * the field is offered exactly where the decision would accept one.
   */
  const rewritable = editing && proposal.draftReplyText !== null;
  /*
   * WHAT THE CARD IS SHOWING, after a redraft and before one (PPE-107).
   *
   * The server's answer wins while there is one: the sentence it stored goes in the box and in the
   * bubble, and the time it was written for goes in the field — so the three cannot disagree about
   * which minute these words are about. A **refused** redraft answers too, carrying the box and
   * the time back, because a refusal that reset the field would wipe what somebody just typed.
   *
   * With no answer yet these are the row's own, rendered by the page from the latest stored draft
   * (`queue.ts`). The box and the field are keyed on the value, which is how an uncontrolled field
   * takes a new default: a redraft replaces what is in them, and typing never does.
   */
  const answered = drafted.status === "idle" ? null : drafted;
  const boxText = answered === null ? proposal.draftReplyText ?? "" : answered.text;
  const timeValue = answered === null ? proposal.requestedHhmm ?? "" : answered.time;
  const shownBody = drafted.status === "redrafted" ? drafted.body : proposal.draftText;
  const working = pending || redrafting;
  /*
   * The time's own button, where there is an action for it to post to. It submits the form it is
   * in — `formAction` — so the time and the box go to the redraft together, and the sentence that
   * comes back is the sentence Approve would send.
   *
   * Only on a card with a drafted reply on it. A fixed-copy card has no sentence to redraft — its
   * body is the centre's own words rendered from the time — so there the field is set and the
   * decision carries it, which is the one way that card has always been edited.
   */
  const updateTime =
    redraft === undefined || !rewritable ? null : (
      <UpdateTimeButton submit={redraftSubmit} pending={working} />
    );

  return (
    <section
      className={[styles.card, className].filter(Boolean).join(" ")}
      aria-label={fill(approval.cardLabel, { adult: proposal.adultName })}
    >
      {/*
        * WHAT THIS CARD IS FOR, and who it goes to: "Reply to Dara" (Firia, 11:11 AM ET
        * 2026-10-18).
        *
        * The robot icon and the bare name are both gone. The icon said who *drafted* the words,
        * which is a fact about the build rather than about the decision — and it was the only
        * thing on the row a screen reader could be told, so a non-sighted reader got "Agent" and
        * the parent's name and had to infer the rest. The heading now says the act, in words, for
        * every reader: this is a reply, and it is going to this parent.
        */}
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{fill(approval.replyTo, { parent: proposal.parentFirstName })}</h3>
      </div>

      {/*
        * The message, as a bubble — the same shape it will have in the thread when it is sent,
        * because it is the same words. Never shortened, and never the send step's furniture: the
        * STOP/HELP footer and the [DEMO] tag are appended by `renderForSend` and belong on a
        * family's phone, not on the thing a person is deciding (Firia, 2026-10-17 10:51 PM ET).
        */}
      <p className={[styles.bubble, styles.out, styles.cardBubble].join(" ")}>
        {shownBody === "" ? approval.draftFailed : shownBody}
      </p>

      {/*
        * ONE LINE OF WHAT THE PLAN DOES, under the words the family reads (same ruling).
        *
        * Approve is not a send any more — it moves the plan: the leg's drop-off time, the van the
        * child stays on, the adult recorded as receiving them (`modules/approvals/decide.ts`). The
        * bubble above says what the family is told; this says what a coordinator is signing for,
        * computed from the proposal and the placement the plan holds (`queue.ts`). Absent, rather
        * than vague, when those facts cannot be answered.
        */}
      {proposal.changeLine === "" ? null : (
        <p className={styles.changeLine}>{proposal.changeLine}</p>
      )}

      {editing ? (
        /*
         * THE TIME FIELD, THE REPLY BOX AND THE TWO DECISION BUTTONS, IN ONE FORM (PPE-97 +
         * PPE-107).
         *
         * One form on purpose, and it is the whole of "the edit + Approve press is the approval":
         * the fields are submitted by the button that decides, so the time, the words a
         * coordinator typed and the decision about them arrive in the same POST, to the same
         * action, through the one write path. Nothing is stored in between, there is nothing to
         * approve twice, and there is no second endpoint that could send these words without
         * `decideApproval`'s checks.
         *
         * The one other button in it is "Update the time", which submits this same form to the
         * redraft action (`formAction`) rather than navigating: it writes a draft, it approves
         * nothing, and the card comes back pending with the new sentence in the box. That is why
         * the time is no longer a `GET` of its own — a GET that re-rendered the page wiped
         * whatever was typed in the box beside it, and left the box holding a sentence drafted for
         * a minute nobody was proposing any more.
         */
        <form action={submit} className={styles.editReply}>
          <DecisionFields proposal={proposal} body={shownBody} time={timeValue} timeField update={updateTime} />
          {rewritable ? (
            <div className={styles.editReplyField}>
              <label className={styles.diffKey} htmlFor={`reply-${proposal.approvalId}`}>
                {approval.editTextLabel}
              </label>
              {/*
                * The sentence, not the rendered body: `PPEC:` is the template's own prefix and
                * `messaging/reply-text.ts` refuses a reply that carries it, so a box prefilled with
                * the whole bubble would hand back a refusal nobody earned.
                *
                * `maxLength` is the one number this file knows, read from the same constant the
                * server checks against — a courtesy, so the box stops rather than the decision.
                *
                * Uncontrolled, and keyed on the sentence it was given: typing is the typist's and
                * nothing re-renders under them, and a redraft arrives as a new default rather than
                * as a value fighting the keyboard.
                */}
              <textarea
                key={boxText}
                id={`reply-${proposal.approvalId}`}
                className={styles.editText}
                name="replyText"
                rows={3}
                maxLength={REPLY_TEXT_MAX}
                defaultValue={boxText}
              />
            </div>
          ) : null}
          <div className={styles.actions}>
            <ApproveButton pending={working} />
            <span className={styles.actionSpacer} />
            <DontSendButton pending={working} />
          </div>
        </form>
      ) : (
        /*
         * The one action row (mockups/approvals.html `.acts`): three controls, teal first. Two
         * forms, because the three are two different kinds of thing — Edit is a navigation and the
         * other two are the decision — and HTML forms cannot nest, so they sit side by side in one
         * row and read as one bar.
         */
        <div className={styles.actions}>
          {/* Approve and Don't send: the one write path, twice. */}
          <form action={submit} className={styles.decideForm}>
            <DecisionFields proposal={proposal} body={shownBody} time={timeValue} />
            <ApproveButton pending={working} />
          </form>

          {/* Edit: a navigation, not a decision. It writes nothing and sends nothing (gate 2). */}
          {editing ? null : (
            <form method="get" action={editHref} className={styles.editForm}>
              <input type="hidden" name="edit" value={proposal.approvalId} />
              <button type="submit" className={styles.secondary}>
                <Pencil size={icon.inline} aria-hidden="true" />
                {approval.edit}
              </button>
            </form>
          )}

          {/* approvals.html `.acts .sp`: Don't send sits at the far end, away from the two
            * controls that go on with the change. */}
          <span className={styles.actionSpacer} />

          <form action={submit} className={styles.decideForm}>
            <DecisionFields proposal={proposal} body={shownBody} time={timeValue} />
            <DontSendButton pending={working} />
          </form>
        </div>
      )}

      {/*
        * One live region, and the decision's own word wins it: a refused redraft says why while
        * nothing has been decided, and the moment there is a decision that is what a person needs
        * to read (PPE-107).
        */}
      <p className={styles.outcome} role="status">
        {state.status === "idle" && drafted.status === "refused" ? drafted.message : outcomeOf(state)}
      </p>
    </section>
  );
}

/**
 * The hidden half of a decision: which approval, which time, and the words the card was showing.
 *
 * One component because the card posts the decision from two or three places depending on its
 * state, and three copies of these inputs is three places for one of them to go missing — which
 * on the `text` field would mean a press that is not checked against what was on screen (S1-7).
 */
function DecisionFields({
  proposal,
  body,
  time,
  timeField = false,
  update = null,
}: {
  readonly proposal: ProposalView;
  /** The words this card is showing right now — the row's, or a redraft's (PPE-107). */
  readonly body: string;
  /** The time these words were written for, "HH:MM". */
  readonly time: string;
  /** True in the Edit state, where the time is a field a person sets rather than a hidden value. */
  readonly timeField?: boolean;
  /** The redraft control, beside the field. Absent where no redraft action was handed in. */
  readonly update?: ReactNode;
}) {
  return (
    <>
      <input type="hidden" name="approval" value={proposal.approvalId} />
      {timeField ? (
        /*
         * THE TIME, AS A FIELD, IN THE FORM THAT APPROVES (PPE-107) — with its own button, which
         * submits this form to the redraft action rather than navigating anywhere.
         *
         * Keyed on the value for the same reason the box is: it is uncontrolled, so a redraft's
         * answer arrives as a new default and nothing fights the person setting it.
         */
        <div className={styles.editTimeRow}>
          <label className={styles.diffKey} htmlFor={`time-${proposal.approvalId}`}>
            {approval.editTimeLabel}
          </label>
          <input
            key={time}
            id={`time-${proposal.approvalId}`}
            className={styles.editTime}
            type="time"
            name="time"
            defaultValue={time}
          />
          {update}
        </div>
      ) : (
        <input type="hidden" name="time" value={time} />
      )}
      {/* The words this card is showing, so the decision is a signature on them and not on
        * whatever the row says by the time it is read (S1-7). With a rewritten reply this is
        * still the DRAFT: it answers "was the card current", and `replyText` is what replaces it. */}
      <input type="hidden" name="text" value={body} />
    </>
  );
}

/** The teal control, wherever the card's state puts it. */
function ApproveButton({ pending }: { readonly pending: boolean }) {
  return (
    <button type="submit" name="decision" value="APPROVED" className={styles.primary} disabled={pending}>
      <Check size={icon.inline} aria-hidden="true" />
      {approval.approveAndSend}
    </button>
  );
}

/**
 * "Update the time" — the one control on this card that is neither a decision nor a navigation.
 *
 * `formAction` on a submit button inside the decision's own form: the press carries the time field
 * and the reply box to `redraftReplyAction`, which stores a draft for the new time and approves
 * nothing. It used to be a `GET` form of its own, which re-rendered the page and wiped the box
 * (PPE-107).
 */
function UpdateTimeButton({
  submit,
  pending,
}: {
  readonly submit: (payload: FormData) => void;
  readonly pending: boolean;
}) {
  return (
    <button type="submit" formAction={submit} className={styles.secondary} disabled={pending}>
      <Pencil size={icon.inline} aria-hidden="true" />
      {approval.editApply}
    </button>
  );
}

/** And the quiet one at the far end: the decision is written and nothing else happens. */
function DontSendButton({ pending }: { readonly pending: boolean }) {
  return (
    <button type="submit" name="decision" value="DECLINED" className={styles.quiet} disabled={pending}>
      <X size={icon.inline} aria-hidden="true" />
      {approval.dontSend}
    </button>
  );
}

/**
 * The redraft that is not wired: the card is rendered somewhere with no action for its time field
 * (the agent bubble's resting card), so there is no button either and this is never dispatched.
 * `useActionState` needs an action whatever the state of the card, and this is the honest one —
 * it answers "nothing changed" and writes nothing.
 */
async function keepTheDraft(previous: RedraftState): Promise<RedraftState> {
  return previous;
}

/**
 * What the card says after a decision, or before one.
 *
 * "Nothing until you approve" is the line that has to be there before anything is pressed: a
 * person reading a drafted text has to know the family has not seen it — the more so now that the
 * words sit in a bubble that will look exactly like this when it has been sent. Afterwards it is
 * what happened — including "approved, and nobody on this family's file may be texted", which is
 * a real outcome and not an error.
 */
function outcomeOf(state: DecisionState): string {
  if (state.status === "refused") return state.message;
  if (state.status !== "decided") return approval.nothingUntilApproved;
  if (state.decision === "DECLINED") return approval.declined;
  return state.queued === 0 ? approval.sentToNobody : approval.sent;
}
