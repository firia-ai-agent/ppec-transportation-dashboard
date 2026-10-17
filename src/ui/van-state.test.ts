import { describe, expect, it } from "vitest";
import { freshnessConfig } from "@/config/live";
import { formatClock } from "@/domain/eta/eta";
import { gpsBand } from "@/domain/location/freshness";
import { fleetMap, vanMarker } from "./copy";
import { vanMarkerStates } from "./states";
import {
  VAN_MARKER_STATES,
  VAN_MARKER_WORDS,
  VAN_STALL_SECONDS,
  lateMinutesOf,
  stopWindowText,
  vanMarkerFaded,
  vanMarkerMapLabel,
  vanMarkerStateOf,
  vanMarkerValues,
  vanMarkerWords,
} from "./van-state";

/**
 * What a van's marker says about the van (Vera's bar for the live map screen).
 *
 * Four states, one of them a time rather than an age, and the rule that decides between them.
 * These are the assertions behind every claim the screen makes: that a marker carries the van's
 * *state* in words and not only its freshness, that lateness is a word before it is a colour,
 * and that a van with no fix says when it was last seen instead of pretending to a position.
 */

/** 7:42 ET on the seeded day — the minute the board reads the demo day at. */
const NOW_MS = Date.UTC(2026, 9, 14, 11, 42, 0);

function motion(over: Partial<Parameters<typeof vanMarkerStateOf>[0]> = {}) {
  const gpsAgeSeconds = over.gpsAgeSeconds ?? 12;
  return {
    band: gpsBand(gpsAgeSeconds),
    gpsAgeSeconds,
    stoppedSeconds: 0,
    lateSeconds: null,
    lastFixMs: NOW_MS - gpsAgeSeconds * 1000,
    ...over,
  };
}

describe("the four things a marker can say", () => {
  it("says a van with a fresh position is on the way", () => {
    const van = motion();
    expect(vanMarkerStateOf(van)).toBe("ON_THE_WAY");
    expect(vanMarkerWords(van)).toBe("On the way");
    expect(vanMarkerFaded(van)).toBe(false);
  });

  it("says how late it is, in words, so the amber is never the only cue", () => {
    const van = motion({ lateSeconds: 8 * 60 });
    expect(vanMarkerStateOf(van)).toBe("LATE");
    expect(vanMarkerWords(van)).toBe("Late 8 min");
    // The word carries it; the tone is the third cue and is allowed to be one.
    expect(vanMarkerStates.LATE.tone).toBe("warn");
    expect(vanMarkerStates.LATE.label).toContain("{minutes}");
  });

  it("says a stall as words and a clock (§5.1), never as a colour", () => {
    const van = motion({ stoppedSeconds: 3 * 60 });
    expect(vanMarkerStateOf(van)).toBe("STOPPED");
    expect(vanMarkerWords(van)).toBe("Stopped 3 min");
    expect(vanMarkerStates.STOPPED.tone).toBe("neutral");
  });

  it("says when a van with no fix was last seen, as a time", () => {
    const van = motion({ gpsAgeSeconds: 11 * 60 });
    expect(vanMarkerStateOf(van)).toBe("NO_FIX");
    expect(vanMarkerWords(van)).toBe(`Last seen ${formatClock(van.lastFixMs as number)}`);
    expect(vanMarkerWords(van)).toBe("Last seen 7:31 AM");
    // An age would be the §3 freshness band's answer; this is a clock, which is Vera's.
    expect(vanMarkerWords(van)).not.toMatch(/\bmin\b/);
    expect(vanMarkerFaded(van)).toBe(true);
  });

  it("covers every state, and each one has words of its own", () => {
    expect(Object.keys(vanMarkerStates).sort()).toEqual([...VAN_MARKER_STATES].sort());
    const words = VAN_MARKER_STATES.map((state) => VAN_MARKER_WORDS[state]);
    expect(new Set(words).size).toBe(words.length);
    for (const state of VAN_MARKER_STATES) expect(words).toContain(vanMarkerStates[state].label);
  });

  /**
   * The chip in the DOM and the label on the canvas are one string, by construction: the
   * descriptor's template and the words helper read the same copy entry. Two renderings of a
   * state that could be filled from different templates is exactly how a marker ends up saying
   * "Stopped 3 min" next to a list that says "In transit".
   */
  it("fills the chip and the canvas label from the same template", () => {
    for (const state of VAN_MARKER_STATES) {
      expect(vanMarkerStates[state].label).toBe(VAN_MARKER_WORDS[state]);
    }
  });
});

describe("which of the four wins, and why", () => {
  it("puts no fix above everything: there is nothing current to say a state about", () => {
    const van = motion({ gpsAgeSeconds: 15 * 60, stoppedSeconds: 600, lateSeconds: 900 });
    expect(vanMarkerStateOf(van)).toBe("NO_FIX");
  });

  it("puts a stall above lateness: the stall is the cause, and the actionable one", () => {
    const van = motion({ stoppedSeconds: 4 * 60, lateSeconds: 12 * 60 });
    expect(vanMarkerStateOf(van)).toBe("STOPPED");
  });

  it("calls a van stopped only after a minute of it (§5.1)", () => {
    expect(VAN_STALL_SECONDS).toBe(60);
    expect(vanMarkerStateOf(motion({ stoppedSeconds: VAN_STALL_SECONDS - 1 }))).toBe("ON_THE_WAY");
    expect(vanMarkerStateOf(motion({ stoppedSeconds: VAN_STALL_SECONDS }))).toBe("STOPPED");
  });

  it("is on the way until the shift is a whole minute, and never says 'Late 0 min'", () => {
    expect(vanMarkerStateOf(motion({ lateSeconds: 20 }))).toBe("ON_THE_WAY");
    expect(vanMarkerStateOf(motion({ lateSeconds: 29 }))).toBe("ON_THE_WAY");
    expect(vanMarkerStateOf(motion({ lateSeconds: 30 }))).toBe("LATE");
    expect(vanMarkerWords(motion({ lateSeconds: 30 }))).toBe("Late 1 min");
    // Early is not late, and neither is a shift nobody could compute.
    expect(lateMinutesOf({ lateSeconds: -600 })).toBe(0);
    expect(lateMinutesOf({ lateSeconds: null })).toBe(0);
    expect(lateMinutesOf({ lateSeconds: Number.POSITIVE_INFINITY })).toBe(0);
    expect(vanMarkerStateOf(motion({ lateSeconds: -600 }))).toBe("ON_THE_WAY");
  });

  it("reads 'no fix' off the one freshness band that means it (LOC-03's 600 s)", () => {
    expect(freshnessConfig.lostSeconds).toBe(600);
    expect(vanMarkerStateOf(motion({ gpsAgeSeconds: 599 }))).not.toBe("NO_FIX");
    expect(vanMarkerStateOf(motion({ gpsAgeSeconds: 600 }))).toBe("NO_FIX");
  });

  /**
   * A van that has never had a displayable position (LOC-01, an unlinked device) is absent from
   * the map altogether — the snapshot keeps it in `silent` and the pane names it in words. This
   * is the fallback for the case the words cannot describe, and it is deliberately not a place.
   */
  it("never invents a time for a van that has never been seen", () => {
    const never = motion({ lastFixMs: null });
    expect(vanMarkerStateOf(never)).toBe("NO_FIX");
    expect(vanMarkerValues("NO_FIX", never)).toEqual({ time: vanMarker.neverSeen });
    expect(vanMarkerWords(never)).toBe("Last seen Not seen yet");
  });
});

describe("the label the marker carries on the canvas", () => {
  it("is the van, its state and how fresh the position it is drawn at is", () => {
    expect(
      vanMarkerMapLabel("V1", { state: "ON_THE_WAY", label: "On the way" }, "Live 12 s"),
    ).toBe("V1 · On the way · Live 12 s");
    expect(
      vanMarkerMapLabel("V1", { state: "LATE", label: "Late 8 min" }, "Live 8 s"),
    ).toBe("V1 · Late 8 min · Live 8 s");
  });

  it("drops the freshness for a van with no fix, whose state already is a time", () => {
    const label = vanMarkerMapLabel(
      "V2",
      { state: "NO_FIX", label: "Last seen 7:31 AM" },
      "No signal 11 min",
    );
    expect(label).toBe("V2 · Last seen 7:31 AM");
    expect(label).not.toContain("No signal");
  });

  it("names the van first, because that is what a reader is looking for", () => {
    expect(vanMarker.mapLabel.startsWith("{van}")).toBe(true);
    expect(vanMarker.mapLabelAged.startsWith("{van}")).toBe(true);
  });
});

describe("what a stop on the van's run says", () => {
  it("reads an arrival as the vehicle's, never as a handoff (AT-10)", () => {
    expect(stopWindowText("arrived")).toBe(fleetMap.arrived);
    expect(stopWindowText("arrived")).not.toMatch(/handed off/i);
    expect(stopWindowText("passed")).toBe(fleetMap.passed);
  });

  it("keeps the window a family holds on screen while the texts are paused (LOC-03)", () => {
    expect(stopWindowText("pending", "8:20–8:30 AM")).toBe("8:20–8:30 AM");
    expect(stopWindowText("pending", "8:20–8:30 AM", true)).toBe(
      "8:20–8:30 AM · ETA texts paused",
    );
    // Never a blank cell: a stop with no window says that nobody has settled the time.
    expect(stopWindowText("pending")).toBe(fleetMap.windowPending);
  });
});
