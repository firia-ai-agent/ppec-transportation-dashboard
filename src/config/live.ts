/**
 * The live board's numbers, in one file.
 *
 * SOURCE: PRD §8 (the parameter table: recompute policy ASM-11, dwell/service ASM-12,
 * uncertainty ASM-13, notify gate ASM-14, freshness ASM-15), PRD LOC-02 / LOC-03
 * (180 s badge + suppressed ETA texts, 600 s exception + dispatcher ping),
 * DECISION-LEDGER row 30 (the four GPS bands), ADR-002 (SSE), DESIGN-DIRECTION §2
 * ("SSE down >15 s" amber bar) and §6.2 (the ×1/×10/×60 clock speeds).
 *
 * Why a config module rather than constants beside the code that uses them: every one of
 * these numbers is a **calibration**, not a fact about the domain. PRD §8 gives each one a
 * decided value *and* a calibration alternative (dwell 3 min or 120 s, stale 180 s or
 * 180-only, the gate's 10/2/20/15), so the next change to any of them is a tuning decision
 * taken once, for the whole system, by someone reading this table — not a search through
 * the modules for a literal. The domain modules below import from here and re-export under
 * their own names, so there is exactly one place a threshold is written down and every
 * module still reads in its own vocabulary.
 *
 * Not env-tunable on purpose. These are the thresholds a safety story is told against — a
 * deployment that could quietly raise "location lost" to an hour would make every test of
 * LOC-03 meaningless. Changing one is a code change, with the tests that hold it.
 *
 * Pure data: no clock, no environment, no imports.
 */

/** PRD §8 / ledger row 30: when a position stops counting as a position. */
export const freshnessConfig = {
  /** Live band ends here: `fresh` below, `aging` from here. */
  freshSeconds: 60,
  /** LOC-03 / ASM-15 first half: STALE badge **and** ETA texts suppressed. */
  staleSeconds: 180,
  /** LOC-03 / ASM-15 second half: location-loss exception + dispatcher ping. */
  lostSeconds: 600,
  /**
   * How far ahead of our clock a carrier stamp may sit and still be believed. Device clocks
   * drift; past this it is a broken clock and the point tells us nothing about now.
   */
  maxFutureSkewMs: 60_000,
} as const;

/** PRD §8 ASM-14, the hysteresis: what it takes to move the window a family holds. */
export const notifyGateConfig = {
  /** A shift must reach 10 minutes to be worth a text. */
  shiftSeconds: 600,
  /** …and must persist across 2 consecutive calculations. */
  consecutiveCalcs: 2,
  /** Never notify about a stop less than 10 minutes away. */
  minLeadSeconds: 600,
  /** At most one notification per stop per 20 minutes… */
  cooldownSeconds: 1200,
  /** …unless the ETA has slipped a further 15 minutes. */
  escalationSeconds: 900,
  /** An improvement is only worth a text at 15 minutes. */
  improvementSeconds: 900,
} as const;

/** PRD §8 ASM-11: when the ETA engine recomputes, and how often the sweeper looks. */
export const recomputeConfig = {
  /** A new position after ≥60 s… */
  minSeconds: 60,
  /** …or ≥300 m… */
  minMeters: 300,
  /** …and at least every 5 minutes. */
  periodSeconds: 300,
  /** …with a 30 s debounce. */
  debounceSeconds: 30,
  /** ARCHITECTURE §6: the freshness sweeper runs every minute. */
  sweepSeconds: 60,
} as const;

/**
 * The live stream (ADR-002) and the scenario clock behind it (PRD §8: clock acceleration
 * applies to the scenario clock only, never to a carrier timestamp).
 */
export const liveStreamConfig = {
  /**
   * Scenario seconds per tick. Five, because that is the telemetry cadence the simulator and
   * every committed replay emit at (src/domain/location/simulator.ts): a finer tick would
   * publish the same positions twice.
   */
  tickScenarioSeconds: 5,
  /** §6.2 clock speeds. ×1 is the console's: a demo day that runs at the speed of a day. */
  speeds: [1, 10, 60] as const,
  defaultSpeed: 1,
  /**
   * DESIGN-DIRECTION §2: with no event for this long the board says so — the amber bar, the
   * §5 copy, and the data left visible underneath it.
   */
  pausedAfterSeconds: 15,
  /**
   * ADR-002: the stream self-closes under Vercel's 300 s default and the browser reconnects
   * with `Last-Event-ID`.
   */
  maxStreamSeconds: 290,
  /** `retry:` — how long the browser waits before reconnecting. */
  reconnectAfterMs: 2_000,
} as const;

/**
 * Alerts the agent hears (ledger #74 e). An alert raised for staff starts one agent run that may
 * only propose; this bounds how many such runs one centre can start in an hour, so a burst of
 * alerts — or a rule that misfires — cannot turn into a burst of model calls.
 */
export const alertAgentConfig = {
  maxRunsPerSitePerHour: 20,
  /** A queued alert run whose wake-up was lost is woken again by the one-minute sweep after this. */
  rewakeAfterSeconds: 60,
} as const;

/** Every live number in one object, for a caller that wants to print or diff the table. */
export const liveConfig = {
  alertAgent: alertAgentConfig,
  freshness: freshnessConfig,
  notifyGate: notifyGateConfig,
  recompute: recomputeConfig,
  stream: liveStreamConfig,
} as const;
