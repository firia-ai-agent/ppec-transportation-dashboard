"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API, rolesWhoCanCall } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { scenarioClock } from "./copy";
import { demoClockReadout, restartDemoClock, resumeDemoClock, useDemoClock } from "./demo-clock";
import { postDemoReset, startDemoDay } from "./demo-day";
import styles from "./ScenarioClock.module.css";

/**
 * DESIGN-DIRECTION §2 header: the scenario clock, with the demo's one control beside it (§6.1
 * "Clock": a time readout and a control; COPY-GUIDE §52: "Demo not started" with a [Start]
 * button).
 *
 * **It starts the demo day — the data and the clock.** The founder's final ruling (2026-10-17
 * 14:44 ET, DECISION-LEDGER row 88): the press puts the demo back to the start of the day with
 * all of its data, through `POST /api/demo/reset`, and then starts the scenario clock. The two
 * are ordered and that order is in src/ui/demo-day.ts, which this component only wires to the
 * screen. Before that ruling the button started a clock and nothing else; before *that* it was
 * rendered inert — `aria-disabled`, no handler, and a tooltip saying the demo controls were not
 * connected, which is the one thing a control may never be (founder, 2026-10-17 14:40 ET).
 *
 * One button, and the state is in its words rather than in a colour (§3, §9):
 *
 *  - not run yet → "Start demo day", and no confirm: there is nothing of anybody's to lose, so
 *    it resets and starts straight away;
 *  - running → "Restart demo day", which asks first — a demo in progress is a thing to lose;
 *  - while the data goes back → "Starting…" / "Restarting…", and the button cannot be pressed
 *    twice. That is the only state it is ever unavailable in.
 *
 * Who sees it: the roles the access table opens the endpoint to, read from the table itself
 * (`rolesWhoCanCall`), so this cannot drift from the guard. The front desk sees the readout and
 * **no button at all** — not a disabled one, which would be the inert control all over again.
 * Hiding it is a courtesy either way: the server refuses their POST (guard-matrix.test.ts).
 *
 * On a preview the reset refuses by design, because the database there is production's served
 * read-only (DECISION-LEDGER #43): the clock still starts and one line says the reset is the
 * live site's. A real failure says so instead, and starts nothing.
 *
 * **A reload keeps the day.** The start is remembered in this tab's `sessionStorage`, and on load
 * the clock resumes at the tick it would have reached (`resumeDemoClock`), so a refresh still
 * offers "Restart demo day" and its confirm. The no-confirm press is the first one of the tab,
 * not the first one since the last refresh — which is what it was, and what lost the demo.
 *
 * No live region on the readout: it changes every half-second while the day runs, and a screen
 * reader reading each one would talk over the board. The line beneath it is a `status`, because
 * it appears in answer to a press and is the only thing on this control that has to be heard.
 */
export function ScenarioClock({ role }: { role: StaffRole | null }) {
  const clock = useDemoClock();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  /*
   * A reload lands here. The store is module state, so a refresh came back to "Demo not started"
   * and the next press was a first press: it reset the day with no confirm and took everything
   * changed since the start with it. The start is remembered in this tab's `sessionStorage`
   * instead (`resumeDemoClock`), and this is where it is read: in an effect, after hydration, so
   * the first client render is still the server's "not started" and nothing mismatches.
   */
  useEffect(() => {
    resumeDemoClock();
  }, []);

  // §9: the dialog takes the focus when it opens, and the quiet keypress — Enter, Escape — is
  // the harmless one. Cancel is what the founder's ruling puts the focus on.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  /** The roles the endpoint's own row names. A role that cannot call it is offered no button. */
  const mayReset = role !== null && rolesWhoCanCall(API.demoReset).includes(role);

  async function run() {
    setConfirming(false);
    setPending(true);
    setNote(null);
    const outcome = await startDemoDay({
      reset: postDemoReset,
      startClock: restartDemoClock,
      refresh: () => router.refresh(),
    });
    setPending(false);
    setNote(
      outcome.started
        ? outcome.note === null
          ? null
          : { text: outcome.note, failed: false }
        : { text: outcome.error, failed: true },
    );
    buttonRef.current?.focus();
  }

  const label = pending
    ? clock.running
      ? scenarioClock.restarting
      : scenarioClock.starting
    : clock.running
      ? scenarioClock.restart
      : scenarioClock.start;

  return (
    <div className={styles.row}>
      {/* The attribute is how the browser check reads the running clock off the real screen. */}
      <span className={`${styles.readout} tabularNums`} data-scenario-clock="readout">
        {demoClockReadout(clock)}
      </span>
      {mayReset ? (
        <button
          type="button"
          ref={buttonRef}
          className={styles.start}
          // Unavailable only while the press it answers is still running, never at rest.
          disabled={pending}
          aria-busy={pending}
          onClick={clock.running ? () => setConfirming(true) : run}
        >
          {label}
        </button>
      ) : null}
      {note ? (
        <p className={styles.note} role="status" data-scenario-clock={note.failed ? "error" : "note"}>
          {note.text}
        </p>
      ) : null}
      {confirming ? (
        <div className={styles.scrim}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            onKeyDown={(event) => {
              if (event.key === "Escape") setConfirming(false);
            }}
          >
            <h2 id={titleId} className={styles.dialogTitle}>
              {scenarioClock.confirmTitle}
            </h2>
            <p id={bodyId} className={styles.dialogBody}>
              {scenarioClock.confirmBody}
            </p>
            <div className={styles.dialogActions}>
              {/* The destructive one, and it says so in red (§8's critical pair, inverted). */}
              <button type="button" className={styles.danger} onClick={run}>
                {scenarioClock.confirmRestart}
              </button>
              <button
                type="button"
                ref={cancelRef}
                className={styles.cancel}
                onClick={() => {
                  setConfirming(false);
                  buttonRef.current?.focus();
                }}
              >
                {scenarioClock.confirmCancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
