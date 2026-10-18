"use client";

import { usePathname } from "next/navigation";
import { Check } from "lucide-react";
import { canSeeMapData } from "@/domain/access/map-view";
import type { StaffRole } from "@/auth/core";
import { formatClock } from "@/domain/eta/eta";
import { SCENARIO_START_MS } from "@/fixtures/replays";
import { fill, liveMap } from "./copy";
import { SPEEDS, demoClock, useDemoClock } from "./demo-clock";
import { icon } from "./tokens";
import styles from "./DemoClock.module.css";

/**
 * THE SCENARIO CLOCK, IN THE DEMO BAR — the readout and its controls, at the bar's trailing end,
 * beside "Restart demo day" (Firia, 2026-10-17 8:36 PM ET).
 *
 * It was a row at the top of the live map, above the map pane, which audit §3 and §4 item 5 both
 * delete from that screen. The clock is not a fact about the fleet, it is the demo being driven,
 * so it belongs with the demo's other control, in the one piece of chrome that is allowed to be
 * violet (§7, D-5). The map reads the same clock from the same store (src/ui/demo-clock.ts), so
 * the vans move to the time the bar is showing.
 *
 * **Only where it means something.** The clock is shown on the live map and nowhere else: it is
 * the screen whose content it moves, and a time ticking over a page it does not touch is a
 * readout nobody can act on. `usePathname` is how a component in the root layout knows.
 *
 * **The controls are a demo control (§6.2), the readout is not.** So Pause, the three speeds and
 * Restart are drawn only for a role that holds `clockControls` in the map matrix
 * (src/domain/access/map-view.ts) — the same condition that drew them on the map — and the time
 * itself is drawn for everyone who is on that screen.
 */
export function DemoClock({ role }: { role: StaffRole | null }) {
  const pathname = usePathname();
  const { seconds, playing, speed } = useDemoClock();
  const viewer = role ?? "ANONYMOUS";
  if (pathname !== "/live-map") return null;
  const nowMs = SCENARIO_START_MS + seconds * 1000;
  return (
    <div className={styles.clock} data-demo-clock>
      {/*
        The time, and only the time (png/live-map-390.png, png/live-map.png: "3:24 PM"). The
        words that used to sit in front of it are the element's accessible name now — free at
        any width, and the reason the bar fits a 390 px phone.
      */}
      <span className={styles.time} aria-label={liveMap.clockLabel}>
        {fill(liveMap.clock, { time: formatClock(nowMs) })}
      </span>
      {canSeeMapData(viewer, "clockControls") ? (
        <>
          <button type="button" className={styles.button} onClick={() => demoClock.toggle()}>
            {playing ? liveMap.pause : liveMap.play}
          </button>
          {SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              className={styles.button}
              aria-pressed={speed === option}
              onClick={() => demoClock.setSpeed(option)}
            >
              {speed === option ? <Check size={icon.pill} aria-hidden="true" /> : null}
              {fill(liveMap.speed, { factor: option })}
            </button>
          ))}
          <button type="button" className={styles.button} onClick={() => demoClock.restart()}>
            {liveMap.restart}
          </button>
        </>
      ) : null}
    </div>
  );
}
