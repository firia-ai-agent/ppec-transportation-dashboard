"use client";

import { Check, X } from "lucide-react";
import { EQUIPMENT_COUNTERS } from "@/config/equipment";
import type { Used, VanSetup } from "@/domain/plan/fit";
import { equipment, vanArrival } from "@/ui/copy";
import { COUNTER_ICON, LIFT_ICON } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import { meterSr } from "./lines";
import styles from "./board.module.css";

/**
 * A van's four counters and its lift (redesign spec §1.2's `CapacityMeters`).
 *
 * §0's rule 3 — numbers are big and words are small — so a meter is `4/6` and a 3 px bar, with
 * the words only in the screen-reader label ("4 of 6 Seats"). The list and its order come from
 * src/config/equipment.ts, so a fifth counter appears here without this file changing.
 *
 * Three levels, each with something other than colour to read: full is ink, over is crit **and**
 * the number turns with it, and a van that carries none of a thing is dimmed to 45 % — which is
 * §1.2's own rule, and the reason "0/0" never reads as a fault.
 */
export function CapacityMeters({ setup, used }: { setup: VanSetup; used: Used }) {
  return (
    <div className={styles.meters}>
      {EQUIPMENT_COUNTERS.map((counter) => {
        const total = setup[counter.key];
        const taken = used[counter.key];
        const level = total === 0 ? "none" : taken > total ? "over" : taken === total ? "full" : "some";
        const Icon = COUNTER_ICON[counter.key];
        const percent = total === 0 ? 0 : Math.min(100, Math.round((taken / total) * 100));
        return (
          <div
            key={counter.key}
            className={styles.meter}
            data-level={level}
            data-counter={counter.key}
          >
            <Icon size={icon.inline} aria-hidden="true" />
            <b className={styles.meterValue}>
              <span className="srOnly">{meterSr(taken, total, counter.key)}</span>
              <span aria-hidden="true">
                {taken}
                <i className={styles.meterTotal}>/{total}</i>
              </span>
            </b>
            <span className={styles.bar} aria-hidden="true">
              <span className={styles.barFill} style={{ width: `${percent}%` }} />
            </span>
          </div>
        );
      })}
      <div className={styles.liftRow} data-counter="lift">
        <LIFT_ICON size={icon.inline} aria-hidden="true" />
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
