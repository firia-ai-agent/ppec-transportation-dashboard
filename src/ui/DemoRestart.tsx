"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { ConfirmRestart } from "./ConfirmRestart";
import { demoDay } from "./copy";
import { restartStep, savedPlanToday, sendDemoReset, type RestartStep } from "./restart-confirm";
import { icon } from "./tokens";
import styles from "./DemoRestart.module.css";

/**
 * "Restart demo day" — the one control in the DEMO bar (REDESIGN-SPEC §0, and the mockups,
 * which put it at the bar's right-hand end).
 *
 * It calls the reset the app already has rather than a new one: the same endpoint the demo
 * controls were always going to call, with the same three gates in front of it (the deployment
 * gate, the session guard this route's row in the access table names, and the per-site check
 * inside the handler). This is a button on a bar; it decides nothing about who may reset.
 *
 * Which is why the *bar* decides whether to render it, from the roles that row names
 * (src/ui/DemoBanner.tsx): a control that answers 403 to the person looking at it is worse than
 * no control, and the front desk — who must never see this (§0) — is excluded by the same fact
 * that makes the server refuse them, rather than by a second list here.
 *
 * **It asks first when there is a plan to lose** (Vera's copy, 2026-10-18): a reset clears the
 * saved plan for all three vans, so a press with a plan saved for today opens "Restart today?"
 * and a press with nothing saved goes straight through, exactly as before. Both the question and
 * the decision are shared with the board's "Start demo day" — src/ui/ConfirmRestart.tsx and
 * src/ui/restart-confirm.ts — because the two controls call the same irreversible endpoint.
 * Whether a plan is saved is read through the board route the screens already read, so this adds
 * no store and no query of its own.
 *
 * The addresses come from `API`, the one table that holds this app's endpoint paths, so no
 * screen file writes an `/api/…` string (src/ui/no-internals.test.ts holds that).
 *
 * After a reset the day on screen is the old one, so the route is refreshed rather than
 * reloaded: the server components re-run and every screen under the bar is re-read. A refusal
 * says one line beside the button and leaves it pressable — there is nothing to recover from
 * and nothing to report.
 */
export function DemoRestart() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState<RestartStep>("IDLE");
  /** The saved-plan read a press makes before it decides. Not a restart yet, so not "busy". */
  const [checking, setChecking] = useState(false);
  const busy = step === "SENDING" || pending;

  const send = async () => {
    setFailed(false);
    try {
      if (!(await sendDemoReset())) {
        setFailed(true);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setFailed(true);
    } finally {
      setStep("IDLE");
    }
  };

  /** The press: ask when today has a saved plan, send when it does not. */
  const press = async () => {
    if (busy || checking) return;
    setFailed(false);
    setChecking(true);
    try {
      const next = restartStep("PRESS", await savedPlanToday());
      setStep(next.step);
      if (next.send) await send();
    } finally {
      setChecking(false);
    }
  };

  const answer = (event: "KEEP" | "RESTART") => {
    const next = restartStep(event, true);
    setStep(next.step);
    // "Keep plan" closes the dialog and sends nothing (restart-confirm.ts: `send: false`).
    if (next.send) void send();
  };

  return (
    <span className={styles.wrap}>
      {/* The reason the last press did not work, next to the control it is about (§4.2). */}
      {failed ? (
        <span role="status" className={styles.failed}>
          {demoDay.failed}
        </span>
      ) : null}
      <button
        type="button"
        className={styles.button}
        data-demo-restart="true"
        onClick={() => void press()}
        disabled={busy || checking}
        aria-busy={busy || undefined}
      >
        <RotateCcw size={icon.chip} aria-hidden="true" />
        {/*
          One accessible name at every state: the label changes to say what is happening, and
          the word the button is known by does not move (COPY-GUIDE §3).
        */}
        <span className={styles.label}>{busy ? demoDay.restarting : demoDay.restart}</span>
      </button>
      {step === "ASKING" ? (
        <ConfirmRestart onKeep={() => answer("KEEP")} onRestart={() => answer("RESTART")} />
      ) : null}
    </span>
  );
}
