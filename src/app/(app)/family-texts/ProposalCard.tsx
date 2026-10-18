"use client";

import { useActionState } from "react";
import { ArrowRight, Bot, Check, Pencil, X } from "lucide-react";
import { StateChip } from "@/ui/StateChip";
import { approval } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { DecideAction, DecisionState } from "./actions";
import type { ProposalView } from "./conversations";
import styles from "./texts.module.css";

/**
 * THE APPROVE CARD (mockups/approvals.html `.prop`), rendered inside the thread.
 *
 * What a coordinator reads before anything happens to a family: what kind of change it is, the
 * before and after of each field that moves, the checks that passed, and the exact words the
 * family would get. Then three controls, and the three of them are the whole of Firia's gates 1
 * and 2:
 *
 *  - **Approve and send** posts to `decideApprovalAction`, which calls `decideApproval` and
 *    nothing else. One write path, for all three controls (gate 1).
 *  - **Edit** is a `GET` to this same screen. It writes nothing and sends nothing: the card comes
 *    back *pending*, now with a time field on it, and the reply re-rendered from the same
 *    template — so an edited message needs a **fresh** approval (gate 2). An Edit that
 *    approved-with-a-different-time would be a send nobody signed.
 *  - **Don't send** posts the same action with `DECLINED`: the decision is written and nothing
 *    else happens.
 *
 * ## One row of three buttons, and nothing else
 *
 * Firia, 2026-10-17 10:51 PM ET: "ONE row of three buttons: teal 'Approve & send', 'Edit', 'Don't
 * send'. No time input, no helper text." So the resting card is exactly mockups/approvals.html
 * `.acts` — three controls, the first of them teal — and the time field exists only in the state
 * Edit navigates to (`?edit=`), which is not a state the mockup draws. A field sitting on the
 * resting card was the screen asking a question nobody had asked it.
 *
 * The words are never editable, only the time: the reply below is always `renderTemplate`'s
 * output over the proposal's own template. That is what keeps "no free text to a family" true of
 * the approval path as well as the automatic one.
 */
export function ProposalCard({
  proposal,
  decide,
  editHref,
  editing = false,
  className,
}: {
  readonly proposal: ProposalView;
  readonly decide: DecideAction;
  /** Where Edit submits: this screen, with the thread and tab it is already on. */
  readonly editHref: string;
  /** True in the state Edit navigates to, which is the only state with a time field on it. */
  readonly editing?: boolean;
  readonly className?: string;
}) {
  const [state, submit, pending] = useActionState<DecisionState, FormData>(decide, { status: "idle" });

  return (
    <section className={[styles.card, className].filter(Boolean).join(" ")} aria-label={approval.changeDropoff}>
      <div className={styles.cardHead}>
        <Bot size={icon.inline} aria-hidden="true" />
        <h3 className={styles.cardTitle}>{approval.changeDropoff}</h3>
        <StateChip state={{ icon: Bot, label: proposal.childLabel, tone: "neutral" }} />
        <span className={styles.headerSpacer} />
        {proposal.draftedLabel === "" ? null : <span className={styles.cardWhen}>{proposal.draftedLabel}</span>}
      </div>

      <dl className={styles.diff}>
        {proposal.stopTo === "" ? null : (
          <DiffRow label={approval.diffStop} from={proposal.stopFrom} to={proposal.stopTo} />
        )}
        {proposal.timeTo === null ? null : (
          <DiffRow label={approval.diffTime} from={proposal.timeFrom} to={proposal.timeTo} />
        )}
        {proposal.pickupLabel === "" ? null : (
          <DiffRow label={approval.diffPickup} from={null} to={proposal.pickupLabel} />
        )}
      </dl>

      {proposal.checks.length === 0 ? null : (
        <div className={styles.checks}>
          {proposal.checks.map((check) => (
            <StateChip key={check} state={{ icon: Check, label: check, tone: "ok" }} />
          ))}
        </div>
      )}

      <div className={styles.draft}>
        <h4 className={styles.draftLabel}>{approval.exactTextHeading}</h4>
        {/* The exact body, as the family would read it. Plain text, never shortened. */}
        <blockquote>{proposal.draftText === "" ? approval.draftFailed : proposal.draftText}</blockquote>
      </div>

      {/* The time field, in the Edit state only — never on the resting card (10:51 PM ET). */}
      {editing ? (
        <form method="get" action={editHref} className={styles.editForm}>
          <input type="hidden" name="edit" value={proposal.approvalId} />
          <label className={styles.diffKey} htmlFor={`time-${proposal.approvalId}`}>
            {approval.editTimeLabel}
          </label>
          <input
            id={`time-${proposal.approvalId}`}
            className={styles.editTime}
            type="time"
            name="time"
            defaultValue={proposal.requestedHhmm ?? ""}
          />
          <button type="submit" className={styles.secondary}>
            <Pencil size={icon.inline} aria-hidden="true" />
            {approval.editApply}
          </button>
        </form>
      ) : null}

      {/*
        * The one action row (mockups/approvals.html `.acts`): three controls, teal first. Two
        * forms, because the three are two different kinds of thing — Edit is a navigation and the
        * other two are the decision — and HTML forms cannot nest, so they sit side by side in one
        * row and read as one bar.
        */}
      <div className={styles.actions}>
        {/* Approve and Don't send: the one write path, twice. */}
        <form action={submit} className={styles.decideForm}>
          <input type="hidden" name="approval" value={proposal.approvalId} />
          <input type="hidden" name="time" value={proposal.requestedHhmm ?? ""} />
          <button type="submit" name="decision" value="APPROVED" className={styles.primary} disabled={pending}>
            <Check size={icon.inline} aria-hidden="true" />
            {approval.approveAndSend}
          </button>
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

        <form action={submit} className={styles.decideForm}>
          <input type="hidden" name="approval" value={proposal.approvalId} />
          <input type="hidden" name="time" value={proposal.requestedHhmm ?? ""} />
          <button type="submit" name="decision" value="DECLINED" className={styles.quiet} disabled={pending}>
            <X size={icon.inline} aria-hidden="true" />
            {approval.dontSend}
          </button>
        </form>
      </div>

      <p className={styles.outcome} role="status">
        {outcomeOf(state)}
      </p>
    </section>
  );
}

/** One row of the before → after. No arrow when there is no before: nothing moved. */
function DiffRow({
  label,
  from,
  to,
}: {
  readonly label: string;
  readonly from: string | null;
  readonly to: string;
}) {
  return (
    <>
      <dt className={styles.diffKey}>{label}</dt>
      <dd className={from === null ? styles.diffValue : styles.diffOld}>{from === null ? to : from}</dd>
      {from === null ? (
        <span />
      ) : (
        <span className={styles.arrow}>
          <span className="srOnly">{approval.diffBecomes}</span>
          <ArrowRight size={icon.inline} aria-hidden="true" />
        </span>
      )}
      {from === null ? <span /> : <dd className={styles.diffValue}>{to}</dd>}
    </>
  );
}

/**
 * What the card says after a decision, or before one.
 *
 * "Nothing until you approve" is the line that has to be there before anything is pressed: a
 * person reading a drafted text has to know the family has not seen it. Afterwards it is what
 * happened — including "approved, and nobody on this family's file may be texted", which is a
 * real outcome and not an error.
 */
function outcomeOf(state: DecisionState): string {
  if (state.status === "refused") return state.message;
  if (state.status !== "decided") return approval.nothingUntilApproved;
  if (state.decision === "DECLINED") return approval.declined;
  return state.queued === 0 ? approval.sentToNobody : approval.sent;
}
