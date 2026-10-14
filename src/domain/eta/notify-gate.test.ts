import { describe, expect, it } from "vitest";
import {
  emptyGateState,
  evaluateStop,
  NOTIFY_CONSECUTIVE_CALCS,
  NOTIFY_COOLDOWN_SECONDS,
  NOTIFY_ESCALATION_SECONDS,
  NOTIFY_IMPROVEMENT_SECONDS,
  NOTIFY_MIN_LEAD_SECONDS,
  NOTIFY_SHIFT_SECONDS,
  publishedWindow,
  type GateState,
  type NotificationDecision,
} from "./notify-gate";
import { formatWindow, windowFor, type StopEta } from "./eta";

const T0 = Date.UTC(2026, 9, 14, 11, 30, 0);

/** A pending stop whose ETA is `leadSeconds` away. */
function stop(leadSeconds: number, over: Partial<StopEta> = {}): StopEta {
  const etaMs = T0 + leadSeconds * 1000;
  const window = windowFor(etaMs);
  return {
    stopIndex: 1,
    stopId: "S1",
    stopName: "Greenacres Branch Library",
    familyLabel: "F2",
    status: "pending",
    etaMs,
    uncertaintySeconds: 300,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    windowText: formatWindow(window.startMs, window.endMs),
    ...over,
  };
}

/** Feed a sequence of (clock offset, lead) pairs through the gate. */
function feed(
  steps: Array<{ atSeconds: number; leadSeconds: number; suppressed?: boolean; over?: Partial<StopEta> }>,
): { state: GateState; decisions: NotificationDecision[] } {
  let state = emptyGateState();
  const decisions: NotificationDecision[] = [];
  for (const step of steps) {
    const nowMs = T0 + step.atSeconds * 1000;
    const etaMs = nowMs + step.leadSeconds * 1000;
    const window = windowFor(etaMs);
    const evaluated = evaluateStop(state, {
      stop: {
        ...stop(0, step.over),
        etaMs,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        windowText: formatWindow(window.startMs, window.endMs),
      },
      nowMs,
      etaTextSuppressed: step.suppressed ?? false,
    });
    state = evaluated.state;
    decisions.push(evaluated.decision);
  }
  return { state, decisions };
}

describe("ASM-14 thresholds", () => {
  it("uses the decided values", () => {
    expect(NOTIFY_SHIFT_SECONDS).toBe(600);
    expect(NOTIFY_CONSECUTIVE_CALCS).toBe(2);
    expect(NOTIFY_MIN_LEAD_SECONDS).toBe(600);
    expect(NOTIFY_COOLDOWN_SECONDS).toBe(1200);
    expect(NOTIFY_ESCALATION_SECONDS).toBe(900);
    expect(NOTIFY_IMPROVEMENT_SECONDS).toBe(900);
  });
});

describe("baseline", () => {
  it("publishes a window on the first calculation and notifies nobody", () => {
    const { state, decisions } = feed([{ atSeconds: 0, leadSeconds: 1800 }]);
    expect(decisions[0]).toMatchObject({ outcome: "SUPPRESS", reason: "baseline" });
    expect(publishedWindow(state, "S1")).toBe(decisions[0].windowText);
  });

  it("does not start the 20-minute cooldown, so the first real delay still lands", () => {
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 2340 }, // +11 min
      { atSeconds: 120, leadSeconds: 2340 },
    ]);
    expect(decisions.map((d) => d.outcome)).toEqual(["SUPPRESS", "SUPPRESS", "NOTIFY"]);
  });
});

describe("hysteresis and damping", () => {
  it("ignores a shift under 10 minutes however often it repeats", () => {
    // A vehicle standing still: the lead stays the same, so the ETA slips a minute a
    // minute. Four calcs in, the slip is 9 minutes — still not worth a text.
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      ...Array.from({ length: 4 }, (_, i) => ({ atSeconds: 60 * (i + 1), leadSeconds: 2100 })),
    ]);
    expect(decisions.filter((d) => d.outcome === "NOTIFY")).toHaveLength(0);
    expect(decisions.at(-1)).toMatchObject({ reason: "below-threshold", shiftText: "+9 min" });
  });

  it("needs the shift to persist across two consecutive calculations", () => {
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 2460 },
    ]);
    expect(decisions[1]).toMatchObject({ outcome: "SUPPRESS", reason: "not-persisted" });
  });

  it("resets persistence when the shift changes direction", () => {
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 2460 }, // +11 min
      { atSeconds: 120, leadSeconds: 780 }, // −17 min
      { atSeconds: 180, leadSeconds: 2460 }, // +11 min again: counts as the first
    ]);
    expect(decisions.map((d) => d.reason)).toEqual([
      "baseline",
      "not-persisted",
      "not-persisted",
      "not-persisted",
    ]);
  });

  it("notifies once, then holds the cooldown for 20 minutes", () => {
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 2460 },
      { atSeconds: 120, leadSeconds: 2460 }, // NOTIFY
      { atSeconds: 180, leadSeconds: 3120 }, // +11 min again
      { atSeconds: 240, leadSeconds: 3120 },
    ]);
    expect(decisions.map((d) => d.outcome)).toEqual([
      "SUPPRESS",
      "SUPPRESS",
      "NOTIFY",
      "SUPPRESS",
      "SUPPRESS",
    ]);
    expect(decisions[4].reason).toBe("cooldown");
  });

  it("breaks the cooldown when the ETA slips a further 15 minutes", () => {
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 2460 },
      { atSeconds: 120, leadSeconds: 2460 }, // NOTIFY, shift +11 min
      { atSeconds: 180, leadSeconds: 4200 }, // +29 min: 18 min more than the last notified
      { atSeconds: 240, leadSeconds: 4200 },
    ]);
    expect(decisions.map((d) => d.outcome).filter((o) => o === "NOTIFY")).toHaveLength(2);
  });

  it("keeps quiet about an improvement under 15 minutes, and speaks at 15", () => {
    const small = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 1140 }, // −11 min
      { atSeconds: 120, leadSeconds: 1140 },
    ]);
    expect(small.decisions.map((d) => d.reason)).toEqual([
      "baseline",
      "improvement-too-small",
      "improvement-too-small",
    ]);

    const big = feed([
      { atSeconds: 0, leadSeconds: 2400 },
      { atSeconds: 60, leadSeconds: 1380 }, // −17 min
      { atSeconds: 120, leadSeconds: 1380 },
    ]);
    expect(big.decisions.at(-1)?.outcome).toBe("NOTIFY");
  });

  it("will not text about a stop less than 10 minutes away", () => {
    const { decisions } = feed([
      { atSeconds: 0, leadSeconds: 1200 },
      { atSeconds: 60, leadSeconds: 540 },
      { atSeconds: 120, leadSeconds: 540 },
    ]);
    // An 11-minute improvement, but the stop is 9 minutes out: nothing useful to say.
    expect(decisions.at(-1)).toMatchObject({ outcome: "SUPPRESS" });
    expect(["too-close", "improvement-too-small"]).toContain(decisions.at(-1)?.reason);
  });

  it("stays quiet when the 10-minute window text has not changed", () => {
    let state = emptyGateState();
    const first = evaluateStop(state, { stop: stop(1800), nowMs: T0, etaTextSuppressed: false });
    state = first.state;
    // Same window bucket, but a +10 min shift in raw ETA: hand-built to collide.
    const collide = { ...stop(1800), etaMs: T0 + 2460_000 };
    for (const _ of [1, 2]) {
      const evaluated = evaluateStop(state, {
        stop: { ...collide, windowText: first.decision.windowText },
        nowMs: T0 + 60_000,
        etaTextSuppressed: false,
      });
      state = evaluated.state;
      if (evaluated.decision.outcome === "NOTIFY") throw new Error("should not notify");
      expect(["not-persisted", "same-window"]).toContain(evaluated.decision.reason);
    }
  });
});

describe("LOC-03: stale GPS suppresses ETA texts", () => {
  it("suppresses before any other rule and freezes the published window", () => {
    const { state, decisions } = feed([
      { atSeconds: 0, leadSeconds: 1800 },
      { atSeconds: 60, leadSeconds: 3600, suppressed: true },
      { atSeconds: 120, leadSeconds: 3600, suppressed: true },
    ]);
    expect(decisions.slice(1).map((d) => d.reason)).toEqual(["gps-stale", "gps-stale"]);
    expect(publishedWindow(state, "S1")).toBe(decisions[0].windowText);
  });
});

describe("who gets a decision", () => {
  it("never notifies about an arrived or passed stop (downstream only)", () => {
    for (const status of ["arrived", "passed"] as const) {
      const evaluated = evaluateStop(emptyGateState(), {
        stop: { ...stop(1800), status, etaMs: undefined },
        nowMs: T0,
        etaTextSuppressed: false,
      });
      expect(evaluated.decision).toMatchObject({ outcome: "SUPPRESS", reason: "arrived" });
    }
  });

  it("publishes the board window for a stop with no family but texts nobody", () => {
    let state = emptyGateState();
    const noFamily = { ...stop(1800), stopId: "CENTER", familyLabel: undefined };
    const first = evaluateStop(state, { stop: noFamily, nowMs: T0, etaTextSuppressed: false });
    state = first.state;
    expect(publishedWindow(state, "CENTER")).toBe(first.decision.windowText);

    const shifted = (atSeconds: number) => {
      const nowMs = T0 + atSeconds * 1000;
      const etaMs = T0 + 1800_000 + 1200_000;
      const window = windowFor(etaMs);
      return {
        stop: {
          ...noFamily,
          etaMs,
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
          windowText: formatWindow(window.startMs, window.endMs),
        },
        nowMs,
        etaTextSuppressed: false,
      };
    };
    state = evaluateStop(state, shifted(60)).state;
    const opened = evaluateStop(state, shifted(120));
    expect(opened.decision).toMatchObject({ outcome: "SUPPRESS", reason: "no-family" });
    // The board moved; nobody was texted.
    expect(publishedWindow(opened.state, "CENTER")).toBe(opened.decision.windowText);
  });

  it("is a pure reducer: the input state is never mutated", () => {
    const state = emptyGateState();
    const next = evaluateStop(state, { stop: stop(1800), nowMs: T0, etaTextSuppressed: false }).state;
    expect(state.stops).toEqual({});
    expect(next).not.toBe(state);
  });
});
