"use client";

/**
 * The header's GPS pill, with a real age in it (DESIGN-DIRECTION §2, §10).
 *
 * §2 approved "<adapter> · Simulated" as an interim and said, in the same sentence, that it
 * "must switch to real ages when B-12 lands (§10)". This is that switch, for the one adapter
 * that now has an age to show: the freshest position in the fleet, from the same stream the
 * board reads, in the §3 band vocabulary and tone — "GPS · Live · 12 s", "GPS · Stale · 4 min
 * · ETA texts paused", "GPS · No signal · 11 min".
 *
 * The other three pills keep saying "Simulated" because that is still the whole truth about
 * them: there is no SMS, Teams or agent age to print yet. And on a surface that opened no
 * stream, this pill says it too — a header that aged a number nobody is streaming would be
 * the one dishonest thing in the chrome.
 *
 * §2's "dim the updated timestamps" when the stream is down: the pill carries `data-stale`
 * while the board is paused, which the stylesheet fades. The age itself is left on screen,
 * because the last thing we heard is still the last thing we heard.
 */

import { FlaskConical } from "lucide-react";
import { adapters } from "./copy";
import { FreshnessPill } from "./FreshnessPill";
import { useLiveBoard } from "./LiveStream";
import { gpsFreshnessFor, gpsFreshnessLabel, gpsFreshnessStates } from "./states";

export function GpsAdapterPill() {
  const { snapshot, paused } = useLiveBoard();
  const age = snapshot?.gpsAgeSeconds ?? null;

  if (age === null) {
    return (
      <FreshnessPill
        adapter={adapters.gps}
        value={adapters.simulatedValue}
        icon={FlaskConical}
        tone="sim"
      />
    );
  }

  const band = gpsFreshnessStates[gpsFreshnessFor(age)];
  return (
    <FreshnessPill
      adapter={adapters.gps}
      value={gpsFreshnessLabel(age)}
      icon={band.icon}
      tone={band.tone}
      stale={paused}
    />
  );
}
