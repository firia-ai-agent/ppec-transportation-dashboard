"use client";

import { Calendar, Check, Save, Sparkles, Undo2 } from "lucide-react";
import type { Direction } from "@/domain/day/leg";
import { planBoard } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import { placedLine, saveLine, type SaveState } from "./lines";
import styles from "./board.module.css";

/**
 * The board's toolbar (redesign spec §1.2's `BoardToolbar`).
 *
 * Left to right: the screen's name, the day, the leg, how much of the day is placed, then the
 * save state and the three controls. Nine visible words plus a date and a count, which is the
 * §1.5 budget — #58's header carried four sentences.
 *
 * Two things are deliberate. **Auto-plan is primary only on an empty board** (§1.2): it is the
 * first step of a fresh day and an ordinary button once a coordinator has started placing people
 * themselves, so the one primary on the screen moves to Save. And the save state is a chip with a
 * word in it — "Not saved", "Saving…", "Saved 2:41 PM" — because a dot is a colour and a colour
 * is never the only cue (§0's rule 2).
 */
export function BoardToolbar({
  dateLabel,
  direction,
  hrefFor,
  placed,
  total,
  save,
  canUndo,
  onUndo,
  onAutoPlan,
  autoPlanPrimary,
  onSave,
  canSave,
}: {
  /** "Sat, Oct 17" — the day the app was opened, in centre time (§0). */
  dateLabel: string;
  direction: Direction;
  /** Where each leg lives, because the leg is part of the address (§9.3) and not of a handler. */
  hrefFor: (leg: Direction) => string;
  placed: number;
  total: number;
  save: SaveState;
  canUndo: boolean;
  onUndo: () => void;
  onAutoPlan: () => void;
  autoPlanPrimary: boolean;
  onSave: () => void;
  canSave: boolean;
}) {
  const state = saveLine(save);
  return (
    <div className={styles.toolbar}>
      <h1 className={styles.heading}>{planBoard.heading}</h1>
      <span className={styles.date}>
        <Calendar size={icon.inline} aria-hidden="true" />
        <time dateTime={dateLabel}>{dateLabel}</time>
      </span>

      {/*
        Two links, not two buttons: the leg a board is on is part of its address (§9.3), so a
        reload or a shared link lands on the same board — and the current one is marked by
        `aria-current` and a check mark as well as its fill, never by colour alone.
      */}
      <nav className={styles.segmented} aria-label={planBoard.heading}>
        {(["AM", "PM"] as const).map((leg) => (
          <a
            key={leg}
            className={styles.segment}
            href={hrefFor(leg)}
            aria-current={direction === leg ? "page" : undefined}
            data-leg={leg}
          >
            {direction === leg ? <Check size={icon.chip} aria-hidden="true" /> : null}
            {leg === "AM" ? planBoard.morning : planBoard.afternoon}
          </a>
        ))}
      </nav>

      <span className={styles.placed} data-placed="">
        {placedLine(placed, total)}
      </span>

      <span className={styles.spacer} />

      <span className={styles.chip} data-tone={state.tone} data-save-state={save.kind}>
        {state.label}
      </span>

      <button
        type="button"
        className={[styles.button, styles.iconButton].join(" ")}
        aria-label={planBoard.undo}
        title={planBoard.undo}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 size={icon.inline} aria-hidden="true" />
      </button>

      <button
        type="button"
        className={styles.button}
        data-variant={autoPlanPrimary ? "primary" : undefined}
        data-auto-plan=""
        onClick={onAutoPlan}
      >
        <Sparkles size={icon.inline} aria-hidden="true" />
        {planBoard.autoPlan}
      </button>

      <button
        type="button"
        className={styles.button}
        data-variant={autoPlanPrimary ? undefined : "primary"}
        data-save=""
        disabled={!canSave}
        onClick={onSave}
      >
        <Save size={icon.inline} aria-hidden="true" />
        {planBoard.save}
      </button>
    </div>
  );
}
