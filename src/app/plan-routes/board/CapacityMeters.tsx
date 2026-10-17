"use client";

import { Check, X } from "lucide-react";
import { EQUIPMENT_COUNTERS } from "@/config/equipment";
import type { Used, VanSetup } from "@/domain/plan/fit";
import { equipment, vanArrival } from "@/ui/copy";
import { COUNTER_ICON, LIFT_ICON } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import { countChip, countChipLabel, meterSr } from "./lines";
import styles from "./board.module.css";

/**
 * A van's four counters and its lift, read-only (redesign spec §1.2 as re-cut on 2026-10-17
 * 5:55 PM ET).
 *
 * The board **reads** counts and never writes them (Firia's rule 1): the ⚙ button and the setup
 * popover #66 had are gone, and a chip is a link to the one screen where a van is counted — the
 * ramp iPad, opened on this van (`?van=`). So "Seats 4/6" is both the number and the way to go
 * and change it, and there is nowhere on this screen that can produce a `PLANNED` row.
 *
 * §0's rule 3 — numbers are big, words are small — so the label is small and the count is the
 * big part, with the whole thing read out as "4 of 6 Seats" for a screen reader. The list and its
 * order come from src/config/equipment.ts, so a fifth counter appears here without this file
 * changing.
 *
 * Three levels, each with something other than colour to read: full is ink, over is crit **and**
 * the number turns with it, and a van that carries none of a thing is dimmed to 45 % — which is
 * §1.2's own rule, and the reason "0/0" never reads as a fault.
 */
export function CapacityMeters({
  setup,
  used,
  vanName,
  rampHref,
}: {
  setup: VanSetup;
  used: Used;
  vanName: string;
  /** Where this van is counted. Null for a role that cannot open the ramp: then it is a chip. */
  rampHref: string | null;
}) {
  return (
    <div className={styles.meters}>
      {EQUIPMENT_COUNTERS.map((counter) => {
        const total = setup[counter.key];
        const taken = used[counter.key];
        const level = total === 0 ? "none" : taken > total ? "over" : taken === total ? "full" : "some";
        const Icon = COUNTER_ICON[counter.key];
        const percent = total === 0 ? 0 : Math.min(100, Math.round((taken / total) * 100));
        const inside = (
          <>
            <Icon size={icon.inline} aria-hidden="true" />
            <b className={styles.meterValue}>
              <span className="srOnly">{meterSr(taken, total, counter.key)}</span>
              <span aria-hidden="true">{countChip(counter.key, taken, total)}</span>
            </b>
            <span className={styles.bar} aria-hidden="true">
              <span className={styles.barFill} style={{ width: `${percent}%` }} />
            </span>
          </>
        );
        return rampHref ? (
          <a
            key={counter.key}
            className={styles.meter}
            href={rampHref}
            data-level={level}
            data-counter={counter.key}
            title={countChipLabel(vanName)}
          >
            {inside}
          </a>
        ) : (
          <div key={counter.key} className={styles.meter} data-level={level} data-counter={counter.key}>
            {inside}
          </div>
        );
      })}
      <div className={styles.liftRow} data-counter="lift">
        <LIFT_ICON size={icon.inline} aria-hidden="true" />
        <span className={styles.liftLabel} aria-hidden="true">
          {equipment.lift}
        </span>
        {/* A tick is not a word, so the word is here: "Lift: Yes" / "Lift: No" (§0's rule 2). */}
        <span className="srOnly">
          {`${equipment.lift}: ${setup.hasLift ? vanArrival.yes : vanArrival.no}`}
        </span>
        {setup.hasLift ? (
          <Check size={icon.inline} aria-hidden="true" />
        ) : (
          <X size={icon.inline} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
