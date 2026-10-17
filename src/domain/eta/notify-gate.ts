/**
 * Notify gate (B-11) — hysteresis and damping over ETA recalculations.
 *
 * SOURCE: PRD §8 ASM-14 ("≥10 min shift vs last notified, persisted 2 consecutive
 * calcs, stop ≥10 min away; ≤1/stop/20 min unless +15 more; improvement ≥15 min"),
 * LOC-02, LOC-03 (180 s STALE suppresses ETA texts), AT-03 (downstream only,
 * hysteresis, deterministic replay), PRD §18.2 step 7 ("one damped 10-min window SMS
 * to downstream families only; jitter suppressed").
 *
 * **Decisions only.** This module returns what *would* be notified and why. It sends
 * nothing, writes no outbox row and touches no database — queueing belongs to B-03's
 * outbox (ADR-003) and pre-send revalidation to NTF-04, both out of M5 scope.
 *
 * The published window is the hysteresis: it changes only when the gate opens, so a
 * ±40 m jitter fault moves the raw ETA by a few seconds and the family-facing text not
 * at all (the visible proof DESIGN-DIRECTION §5.1 asks for).
 */

import { formatDelta, type StopEta } from "./eta";

/** ASM-14: a shift must reach 10 minutes to be worth a text. */
export const NOTIFY_SHIFT_SECONDS = 600;
/** ASM-14: …and must persist across 2 consecutive calculations. */
export const NOTIFY_CONSECUTIVE_CALCS = 2;
/** ASM-14: never notify about a stop less than 10 minutes away. */
export const NOTIFY_MIN_LEAD_SECONDS = 600;
/** ASM-14: at most one notification per stop per 20 minutes… */
export const NOTIFY_COOLDOWN_SECONDS = 1200;
/** …unless the ETA has slipped a further 15 minutes. */
export const NOTIFY_ESCALATION_SECONDS = 900;
/** ASM-14: an improvement is only worth a text at 15 minutes. */
export const NOTIFY_IMPROVEMENT_SECONDS = 900;

/**
 * The gate's thresholds, as one value a caller can hand it.
 *
 * ASM-14 fixes the numbers and the constants above are those numbers — but *what counts as late
 * enough to text a family about* is an operational setting, not a law of the domain, and the demo
 * has to be able to say so without a code change (B-05/B-06: "ETA threshold → deterministic →
 * template"). So the gate takes an optional set of thresholds, the defaults are ASM-14's, and the
 * one place a deployment's numbers are read from the environment is
 * `src/modules/messaging/eta-notice.ts` (`loadEtaNoticeConfig`) — this module still reads nothing.
 */
export type NotifyThresholds = {
  /** Seconds of shift against the last notified ETA that make a text worth sending. */
  readonly shiftSeconds: number;
  /** How many consecutive calculations that shift must hold for. */
  readonly consecutiveCalcs: number;
  /** Never notify about a stop closer than this. */
  readonly minLeadSeconds: number;
  /** At most one notification per stop per this long… */
  readonly cooldownSeconds: number;
  /** …unless the ETA has slipped a further this much. */
  readonly escalationSeconds: number;
  /** How much earlier an arrival has to get before it is worth a text. */
  readonly improvementSeconds: number;
};

/** ASM-14's own numbers: what the gate uses when a caller names none. */
export const ASM14_THRESHOLDS: NotifyThresholds = {
  shiftSeconds: NOTIFY_SHIFT_SECONDS,
  consecutiveCalcs: NOTIFY_CONSECUTIVE_CALCS,
  minLeadSeconds: NOTIFY_MIN_LEAD_SECONDS,
  cooldownSeconds: NOTIFY_COOLDOWN_SECONDS,
  escalationSeconds: NOTIFY_ESCALATION_SECONDS,
  improvementSeconds: NOTIFY_IMPROVEMENT_SECONDS,
};

export type DecisionOutcome = "NOTIFY" | "SUPPRESS";

export type SuppressReason =
  /** LOC-03: GPS ≥180 s old. ETA texts are suppressed outright. */
  | "gps-stale"
  /** First calculation for this stop: it sets the baseline, it does not notify. */
  | "baseline"
  /** The stop has been arrived at or passed — it is not downstream of anything. */
  | "arrived"
  /** No family to tell (the center drop). */
  | "no-family"
  /** |shift| < 10 min vs the last notified window. */
  | "below-threshold"
  /** The shift has not yet held for 2 consecutive calculations. */
  | "not-persisted"
  /** The stop is less than 10 minutes away. */
  | "too-close"
  /** Inside the 20-minute cooldown and not a further 15 min worse. */
  | "cooldown"
  /** An improvement smaller than 15 min. */
  | "improvement-too-small"
  /** The 10-minute window text has not actually changed. */
  | "same-window";

/** One decision about one stop at one recalculation. Never a send. */
export interface NotificationDecision {
  /** Clock instant of the calculation, epoch ms. */
  atMs: number;
  stopId: string;
  familyLabel?: string;
  outcome: DecisionOutcome;
  reason: SuppressReason | "shift-persisted";
  /** Seconds the ETA has moved against the last notified ETA (+ late, − early). */
  shiftSeconds: number;
  /** "+12 min" / "−3 min" / "On time" (COPY-GUIDE l.36). */
  shiftText: string;
  /** The 10-minute window that would be published, e.g. "8:20–8:30 AM". */
  windowText?: string;
  windowStartMs?: number;
  windowEndMs?: number;
}

/** Per-stop gate memory. */
export interface StopGateState {
  /** ETA last published to the family, epoch ms. */
  lastNotifiedEtaMs?: number;
  /** When it was published, epoch ms. */
  lastNotifiedAtMs?: number;
  /** The window text the family currently holds — the only text the UI should show. */
  publishedWindowText?: string;
  publishedWindowStartMs?: number;
  publishedWindowEndMs?: number;
  /** |shift| at the last notification, for the "+15 more" escalation rule. */
  lastNotifiedShiftSeconds?: number;
  /** How many consecutive calcs have shown a gate-worthy shift in this direction. */
  pendingCalcs: number;
  pendingSign: 0 | 1 | -1;
}

export interface GateState {
  stops: Readonly<Record<string, StopGateState>>;
}

export function emptyGateState(): GateState {
  return { stops: {} };
}

function stopState(state: GateState, stopId: string): StopGateState {
  return state.stops[stopId] ?? { pendingCalcs: 0, pendingSign: 0 };
}

function put(state: GateState, stopId: string, next: StopGateState): GateState {
  return { stops: { ...state.stops, [stopId]: next } };
}

export interface GateInput {
  /** One stop's ETA from {@link computeEta}. */
  stop: StopEta;
  nowMs: number;
  /**
   * LOC-03: true once GPS is ≥180 s old, from
   * `freshnessOf(...).etaTextSuppressed`. Suppresses before any other rule.
   */
  etaTextSuppressed: boolean;
  /** The operator's thresholds for this run. ASM-14's own numbers when absent. */
  thresholds?: NotifyThresholds;
}

/**
 * Evaluate the gate for one stop at one recalculation.
 *
 * The first calculation for a stop sets the baseline window (so the board has a window
 * to show) without producing a notification: a demo must not open with a text.
 */
export function evaluateStop(
  state: GateState,
  input: GateInput,
): { state: GateState; decision: NotificationDecision } {
  const { stop, nowMs, etaTextSuppressed } = input;
  const limits = input.thresholds ?? ASM14_THRESHOLDS;
  const prior = stopState(state, stop.stopId);

  const base = {
    atMs: nowMs,
    stopId: stop.stopId,
    familyLabel: stop.familyLabel,
    shiftSeconds: 0,
    shiftText: formatDelta(0),
    windowText: prior.publishedWindowText,
    windowStartMs: prior.publishedWindowStartMs,
    windowEndMs: prior.publishedWindowEndMs,
  };

  const suppress = (reason: SuppressReason, extra: Partial<NotificationDecision> = {}) => ({
    state,
    decision: { ...base, outcome: "SUPPRESS" as const, reason, ...extra },
  });

  if (stop.status !== "pending") return suppress("arrived");
  if (stop.etaMs === undefined) return suppress("arrived");
  // LOC-03 / ASM-15: stale GPS suppresses ETA texts, whatever the numbers say. It also
  // freezes the published window: the board keeps the last good one beside a STALE
  // badge rather than quietly re-rounding a window nobody can stand behind.
  if (etaTextSuppressed) return suppress("gps-stale");

  const etaMs = stop.etaMs;
  const windowText = stop.windowText;

  if (prior.lastNotifiedEtaMs === undefined) {
    // Baseline: publish the window to the board, tell nobody.
    return {
      state: put(state, stop.stopId, {
        ...prior,
        lastNotifiedEtaMs: etaMs,
        // `lastNotifiedAtMs` stays unset on purpose: ASM-14's 20-minute cooldown counts
        // from a *notification*, and a baseline is not one. Setting it here would make
        // the first real delay of a run arrive 20 minutes late, or never.
        publishedWindowText: windowText,
        publishedWindowStartMs: stop.windowStartMs,
        publishedWindowEndMs: stop.windowEndMs,
        lastNotifiedShiftSeconds: 0,
        pendingCalcs: 0,
        pendingSign: 0,
      }),
      decision: {
        ...base,
        outcome: "SUPPRESS",
        reason: "baseline",
        windowText,
        windowStartMs: stop.windowStartMs,
        windowEndMs: stop.windowEndMs,
      },
    };
  }

  const shiftSeconds = (etaMs - prior.lastNotifiedEtaMs) / 1000;
  const sign: 0 | 1 | -1 = shiftSeconds > 0 ? 1 : shiftSeconds < 0 ? -1 : 0;
  const shiftText = formatDelta(shiftSeconds);
  const withShift = { ...base, shiftSeconds, shiftText };

  const threshold =
    shiftSeconds < 0 ? limits.improvementSeconds : limits.shiftSeconds;
  const material = Math.abs(shiftSeconds) >= threshold;

  // Persistence is counted whether or not the other rules pass, so a shift that is
  // held back only by the cooldown is still "persisted" when the cooldown expires.
  const pendingCalcs = material && sign === prior.pendingSign ? prior.pendingCalcs + 1 : material ? 1 : 0;
  const pendingSign = material ? sign : 0;
  const counted: StopGateState = { ...prior, pendingCalcs, pendingSign };
  const stateWithCount = put(state, stop.stopId, counted);
  const suppressCounted = (reason: SuppressReason) => ({
    state: stateWithCount,
    decision: { ...withShift, outcome: "SUPPRESS" as const, reason },
  });

  if (!material) {
    return suppressCounted(
      shiftSeconds < 0 ? "improvement-too-small" : "below-threshold",
    );
  }
  if (pendingCalcs < limits.consecutiveCalcs) return suppressCounted("not-persisted");
  if ((etaMs - nowMs) / 1000 < limits.minLeadSeconds) return suppressCounted("too-close");

  if (prior.lastNotifiedAtMs !== undefined) {
    const sinceLast = (nowMs - prior.lastNotifiedAtMs) / 1000;
    const escalated =
      Math.abs(shiftSeconds) >=
      (prior.lastNotifiedShiftSeconds ?? 0) + limits.escalationSeconds;
    if (sinceLast < limits.cooldownSeconds && !escalated) return suppressCounted("cooldown");
  }

  // A 10-minute window that rounds to the same text tells the family nothing new.
  if (windowText !== undefined && windowText === prior.publishedWindowText) {
    return suppressCounted("same-window");
  }

  // The gate is open. The window is published either way — the board always shows the
  // damped window — but only a stop with a family produces a notification decision.
  const published = {
    state: put(state, stop.stopId, {
      lastNotifiedEtaMs: etaMs,
      lastNotifiedAtMs: nowMs,
      publishedWindowText: windowText,
      publishedWindowStartMs: stop.windowStartMs,
      publishedWindowEndMs: stop.windowEndMs,
      lastNotifiedShiftSeconds: Math.abs(shiftSeconds),
      pendingCalcs: 0,
      pendingSign: 0,
    }),
    decision: {
      ...withShift,
      outcome: "NOTIFY" as const,
      reason: "shift-persisted" as const,
      windowText,
      windowStartMs: stop.windowStartMs,
      windowEndMs: stop.windowEndMs,
    },
  };
  if (!stop.familyLabel) {
    return {
      state: published.state,
      decision: { ...published.decision, outcome: "SUPPRESS", reason: "no-family" },
    };
  }
  return published;
}

/** The window the family currently holds for a stop (what the board must show). */
export function publishedWindow(state: GateState, stopId: string): string | undefined {
  return state.stops[stopId]?.publishedWindowText;
}
