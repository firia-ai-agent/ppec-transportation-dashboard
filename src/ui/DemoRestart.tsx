"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { API } from "@/auth/access";
import { demoDay } from "./copy";
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
 * The address comes from `API`, the one table that holds this app's endpoint paths, so no
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
  const [sending, setSending] = useState(false);
  const busy = sending || pending;

  const restart = async () => {
    setFailed(false);
    setSending(true);
    try {
      const response = await fetch(API.demoReset, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
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
        onClick={restart}
        aria-busy={busy || undefined}
      >
        <RotateCcw size={icon.chip} aria-hidden="true" />
        {/*
          One accessible name at every state: the label changes to say what is happening, and
          the word the button is known by does not move (COPY-GUIDE §3).
        */}
        <span className={styles.label}>{busy ? demoDay.restarting : demoDay.restart}</span>
      </button>
    </span>
  );
}
