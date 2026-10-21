"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { REPLY_TEXT_MAX } from "@/modules/messaging/reply-text";
import styles from "@/app/(app)/family-texts/texts.module.css";
import { approval, confirmCopy } from "./copy";
import type { PanelView } from "./panel";
import { usePanelActions } from "./PanelActions";
import { icon } from "./tokens";

/** What the panel says after a press, or before one. */
type PanelState =
  | { readonly status: "idle" }
  | { readonly status: "said"; readonly message: string }
  /** The plan would not take it: what is in the way, and the one place to fix it (ledger #80). */
  | { readonly status: "refused"; readonly message: string; readonly fix?: { readonly label: string; readonly href: string } };

/**
 * THE AGENT PANEL (ledger #79): one component for everything the agent proposes — a reply to a
 * family with the change it makes to the ride, or a change to the day — in the bubble, on Family
 * texts and in a leg's drawer alike.
 *
 * Read top to bottom it is the decision: what it is for, the agent's sentence, what Approve does to
 * the day (one line each, generated from the plan), and the words a family would get, as the bubble
 * they will see. Approve runs all of it as one decision; Don't changes nothing. Edit (a link, never a
 * decision) opens the reply's words in a box on the family's thread, and the typed words travel only
 * in the Approve press — never in an address.
 */
export function AgentPanel({ panel, editing = false, className }: { readonly panel: PanelView; readonly editing?: boolean; readonly className?: string }) {
  const actions = usePanelActions();
  const [state, submit, pending] = useActionState<PanelState, FormData>(async (_previous, form) => {
    if (!actions) return { status: "idle" };
    if (panel.kind === "confirm") {
      const r = await actions.confirm({ status: "idle" }, form);
      if (r.status === "refused") return { status: "refused", message: r.message, fix: r.fix };
      return r.status === "done" ? { status: "said", message: r.decision === "APPROVED" ? confirmCopy.done : confirmCopy.declined } : { status: "idle" };
    }
    const r = await actions.decide({ status: "idle" }, form);
    if (r.status === "refused") return { status: "refused", message: r.message, fix: r.fix };
    if (r.status !== "decided") return { status: "idle" };
    return { status: "said", message: r.decision === "DECLINED" ? approval.declined : r.queued === 0 ? approval.sentToNobody : approval.sent };
  }, { status: "idle" });

  const reply = panel.kind === "reply";
  const idField = reply ? "approval" : "card";
  const canEdit = panel.message?.editable != null && panel.threadHref !== null;
  const editHref = panel.threadHref ? `${panel.threadHref}${panel.threadHref.includes("?") ? "&" : "?"}edit=${encodeURIComponent(panel.id)}` : "";
  const formId = `approve-${panel.id}`;
  const fieldId = `reply-${panel.id}`;

  return (
    <section className={[styles.card, className].filter(Boolean).join(" ")} aria-label={panel.label} data-agent-panel={panel.kind}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{panel.title}</h3>
      </div>
      {panel.note ? <p className={styles.changeLine}>{panel.note}</p> : null}

      {/* What Approve does to the day, generated from the plan: who moves or waits, when, does it fit. */}
      {panel.lines.length > 0 ? (
        <ul className={styles.impactList}>
          {panel.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {/* The words a family would get, as the bubble they will see. In Edit, the bubble is the box. */}
      {panel.message && !(editing && canEdit) ? <p className={[styles.bubble, styles.out, styles.cardBubble].join(" ")}>{panel.message.text}</p> : null}

      <form action={submit} id={formId} className={styles.approveForm}>
        <input type="hidden" name={idField} value={panel.id} />
        {editing && canEdit ? (
          <>
            <label className="srOnly" htmlFor={fieldId}>
              {approval.editLabel}
            </label>
            <textarea
              id={fieldId}
              name="edited"
              className={styles.editText}
              defaultValue={panel.message?.editable ?? ""}
              maxLength={REPLY_TEXT_MAX}
              rows={3}
              required
              autoFocus
            />
            <p className={styles.editHint}>{approval.editHint}</p>
          </>
        ) : panel.message ? (
          // The words on screen, so the decision is a signature on them and not on whatever the row says later.
          <input type="hidden" name="text" value={panel.message.text} />
        ) : null}
      </form>
      <div className={styles.actions}>
        <button type="submit" form={formId} name="decision" value="APPROVED" className={styles.primary} disabled={pending}>
          <Check size={icon.inline} aria-hidden="true" />
          {reply ? approval.approveAndSend : confirmCopy.confirm}
        </button>
        {!canEdit ? null : editing ? (
          <Link href={panel.threadHref!} className={styles.secondary} scroll={false}>
            <X size={icon.inline} aria-hidden="true" />
            {approval.editCancel}
          </Link>
        ) : (
          <Link href={editHref} className={styles.secondary} scroll={false}>
            <Pencil size={icon.inline} aria-hidden="true" />
            {approval.edit}
          </Link>
        )}
        <span className={styles.actionSpacer} />
        <form action={submit} className={styles.decideForm}>
          <input type="hidden" name={idField} value={panel.id} />
          {panel.message ? <input type="hidden" name="text" value={panel.message.text} /> : null}
          <button type="submit" name="decision" value="DECLINED" className={styles.quiet} disabled={pending}>
            <X size={icon.inline} aria-hidden="true" />
            {panel.decline}
          </button>
        </form>
      </div>
      {state.status === "refused" ? (
        <p className={styles.refusedLine} role="alert" data-refused="">
          {state.message}{" "}
          {state.fix ? <Link href={state.fix.href}>{state.fix.label}</Link> : null}
        </p>
      ) : (
        <p className={styles.outcome} role="status">
          {state.status === "said" ? state.message : reply ? approval.nothingUntilApproved : confirmCopy.pending}
        </p>
      )}
    </section>
  );
}
