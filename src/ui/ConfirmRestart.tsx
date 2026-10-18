"use client";

import { useEffect, useRef } from "react";
import { demoDay } from "./copy";
import styles from "./ConfirmRestart.module.css";

/**
 * "RESTART TODAY?" — the one question both restart controls ask (Vera's copy, 2026-10-18).
 *
 * One component, used by the DEMO bar's "Restart demo day" (src/ui/DemoRestart.tsx) and by the
 * board's own "Start demo day" (src/app/plan-routes/board/PlanBoard.tsx), because they call the
 * same irreversible endpoint and must therefore ask the same question in the same words. The
 * decision about *when* to ask is not here either — it is src/ui/restart-confirm.ts, which both
 * callers share.
 *
 * The safe answer is the default one, three ways over: "Keep plan" is the primary, it takes the
 * focus when the dialog opens, and Escape is that same answer. Nothing in this component can
 * send anything — it calls back, and the caller owns the request.
 *
 * "Restart" is coral, which is what coral is for and the only thing it is for (src/ui/tokens.ts
 * `alert`, "a fill with `ink` on it and never text of its own").
 */
export function ConfirmRestart({
  onKeep,
  onRestart,
  busy = false,
}: {
  /** "Keep plan", Escape, or the scrim: close, and send nothing. */
  onKeep: () => void;
  onRestart: () => void;
  /** The reset is already in flight, so neither answer can be given twice. */
  busy?: boolean;
}) {
  const keep = useRef<HTMLButtonElement | null>(null);

  /*
   * The focus goes to the safe answer, and Escape is that answer. One listener on the window in
   * the bubble phase: this dialog is the only thing on screen that owns the key while it is open,
   * and the board's own unsaved-changes dialog cannot be open at the same time.
   */
  useEffect(() => {
    keep.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onKeep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);

  return (
    <div className={styles.dialog} data-restart-confirm="">
      {/* The scrim is a layer, not a button: clicking it is the safe answer, like Escape. */}
      <div className={styles.scrim} onClick={onKeep} aria-hidden="true" />
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="restart-confirm-title"
        aria-describedby="restart-confirm-body"
      >
        <h2 className={styles.title} id="restart-confirm-title">
          {demoDay.confirm.title}
        </h2>
        <p className={styles.body} id="restart-confirm-body">
          {demoDay.confirm.body}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            ref={keep}
            className={styles.button}
            data-variant="primary"
            data-restart-keep=""
            autoFocus
            disabled={busy}
            onClick={onKeep}
          >
            {demoDay.confirm.keep}
          </button>
          <button
            type="button"
            className={styles.button}
            data-variant="alert"
            data-restart-go=""
            disabled={busy}
            onClick={onRestart}
          >
            {demoDay.confirm.restart}
          </button>
        </div>
      </div>
    </div>
  );
}
