/**
 * What is actually running — SURF-06 (PRD §14 l.1063, §18.4's source-mode matrix,
 * DESIGN-DIRECTION §4.6).
 *
 * One row per part of the system a demo makes a claim about: the texts families get, the maps
 * and van locations the arrival times come from, and the assistant. Each row answers three
 * questions, and all three are read rather than written down here:
 *
 *  1. **Which mode is it in** — mocked or live. All three are mocked on this build, and that is
 *     read off the wiring rather than asserted here: there is no live adapter behind any of them
 *     to be in the other mode. SMS has one provider wired (`outboxDeps()` builds the SIM
 *     provider; `twilioStub` is a stub whose `send` throws, in every environment). There is no
 *     routing adapter at all — the vans drive the committed ADR-007 routes and their travel
 *     times come with them. And no agent run can be driven: `agentRunner()` refuses by name,
 *     because §11.1's context assembler does not exist.
 *
 *     The mode is deliberately **not** derived from an environment variable, and that is the
 *     honest reading rather than a missing one. A row that read `APP_DATA_CLASS` would print
 *     "Live" for a carrier adapter that refuses every send the moment the class changed — a
 *     green chip over a code path that does not exist, which is the single thing SURF-06 is for
 *     stopping. `LIVE` stays in the type and in the panel's own copy for the adapter that lands
 *     first; `allMocked` is computed off the rows, so the day one row goes live the panel's
 *     opening sentence changes by itself and nothing here has to be remembered.
 *  2. **What it is doing on today's data** — numbers this build computed from the same board and
 *     the same committed replays the Today screen reads, so a row cannot say "working" while the
 *     screen next to it says otherwise. The assistant's number is the one genuine configuration
 *     read on the screen: its own three-condition fail-shut guard (`demoDataGuardRefusal`),
 *     which answers whether a live model call would be permitted here at all.
 *  3. **What a person does when it stops** — the degraded instruction PRD l.1200 puts in the
 *     on-duty coordinator's hands. The words are in src/ui/copy.ts; the codes are here.
 *
 * What this module does **not** carry, and why: SURF-06's "last event / last success / error rate
 * / queue depth / breaker state" columns. Each of them is a count over tables this slice does not
 * read (the message log, the job queue, the breaker's own state), and a health panel that printed
 * a zero for a number it never measured would be worse than a panel that does not claim it.
 *
 * Pure: an environment and a board in, codes and counts out. No I/O, no clock, no secret — the
 * agent's API key is referenced by variable name by its own config module and never read here.
 */

import { demoDataGuardRefusal, loadAgentConfig } from "@/modules/agent/config";
import { replayForVehicle, runOfChild } from "@/domain/board/scenario";
import type { Board, LegRow } from "@/domain/board/board";

/** The three parts of the system this demo makes a claim about, in reading order. */
export const ADAPTERS = ["SMS", "MAPS", "AGENT"] as const;
export type AdapterKey = (typeof ADAPTERS)[number];

export type AdapterMode = "MOCK" | "LIVE";

/**
 * Why a row is not live. Codes, so the words stay in src/ui/copy.ts — and three of them rather
 * than one, because "the carrier adapter refuses every send", "nothing asks a map service
 * anything" and "no run can be driven" are three different facts about three different seams.
 */
export const MOCK_REASONS = ["NO_CARRIER_ADAPTER", "REPLAYED_ROUTES", "NO_RUNNER"] as const;
export type MockReason = (typeof MOCK_REASONS)[number];

export type AdapterStatus = {
  key: AdapterKey;
  mode: AdapterMode;
  /** Why it is not live, or null when it is. */
  mockedBecause: MockReason | null;
  /** The numbers this row's own sentence fills, computed from today's board and replays. */
  facts: Readonly<Record<string, number>>;
};

export type AdapterHealth = {
  rows: readonly AdapterStatus[];
  /**
   * Every row is mocked. The panel says so before the table rather than after it: a reader who
   * skims rows with nothing red in them concludes that everything works, and here that is false
   * of every row.
   */
  allMocked: boolean;
};

/* ───────────────────────────── modes, read from configuration ───────────────────────────── */

/**
 * Whether a live model call would be refused by this deployment's own data check.
 *
 * Read through the agent module's fail-shut guard, so this screen and the outbound path agree by
 * construction. A configuration this module cannot even parse is reported as refused: a
 * deployment whose agent config is invalid is certainly not one that may call a vendor.
 */
export function liveModelCallsRefused(env: Record<string, string | undefined>): boolean {
  try {
    return demoDataGuardRefusal(loadAgentConfig(env), env) !== null;
  } catch {
    return true;
  }
}

/* ───────────────────────────── what today's data says ───────────────────────────── */

/** The vehicle keys carrying a child on this board, in board order, each once. */
function vansToday(board: Board): string[] {
  const seen = new Set<string>();
  for (const leg of board.legs) {
    const run = runOfChild(leg.child.childKey);
    if (run) seen.add(run.vehicleKey);
  }
  return [...seen];
}

/** The vans a predicate holds of on at least one of their rides. */
function vansWhere(board: Board, predicate: (leg: LegRow) => boolean): Set<string> {
  const out = new Set<string>();
  for (const leg of board.legs) {
    if (!predicate(leg)) continue;
    const run = runOfChild(leg.child.childKey);
    if (run) out.add(run.vehicleKey);
  }
  return out;
}

/**
 * The texts the day has weighed up, and the texts it decided were worth sending.
 *
 * Both halves come from the notify gate over the committed replays (src/domain/eta/notify-gate,
 * PRD §8 ASM-14): every recalculation of an arrival produces a decision per stop, and only a
 * shift that is big enough, has persisted, is far enough out and is not inside its own cooldown
 * opens the gate. `considered` counts the decisions about a stop that has a family — a stop with
 * nobody to tell was never a text — and `sent` counts the ones the gate opened for.
 *
 * It is the one number on this screen that is about the system's restraint rather than about the
 * day: §18.2 step 7 is "one damped window message to downstream families only; jitter
 * suppressed", and a demo that cannot show the suppression has only shown the sending.
 *
 * Counted up to the instant the board was read, so it says "so far today" truthfully.
 */
function smsFacts(board: Board): { considered: number; sent: number } {
  let considered = 0;
  let sent = 0;
  for (const vehicleKey of vansToday(board)) {
    const replay = replayForVehicle(vehicleKey);
    if (!replay) continue;
    for (const decision of replay.decisions) {
      if (decision.atMs > board.nowMs) continue;
      if (decision.familyLabel === undefined) continue;
      considered += 1;
      if (decision.outcome === "NOTIFY") sent += 1;
    }
  }
  return { considered, sent };
}

/**
 * The vans, and how many of them this screen can actually locate.
 *
 * `locating` is a van with a position the board may draw — which is not the same as a *fresh*
 * one, and the row says so by counting the paused ones separately: a van whose position is stale
 * is still on the map, and what stopped is the arrival text about it (LOC-03). A van that has
 * never sent a position we may draw is in neither count, which is exactly the unbound-device
 * case (LOC-01) and the reason this is "2 of 3" rather than a percentage.
 */
function mapFacts(board: Board): { vans: number; locating: number; paused: number } {
  return {
    vans: vansToday(board).length,
    locating: vansWhere(board, (leg) => leg.ride.gpsFreshness !== null).size,
    paused: vansWhere(board, (leg) => leg.ride.etaPaused).size,
  };
}

/* ───────────────────────────── the panel ───────────────────────────── */

/**
 * The three rows for one board and one environment.
 *
 * Every mode is `MOCK`, because on this build every one of the three has a mocked seam and no
 * live one (see the header). `allMocked` is still *computed* off the rows rather than returned as
 * `true`: it is what the panel's opening sentence is chosen by, and the day the first real
 * adapter lands that sentence has to change on its own rather than be remembered.
 */
export function adapterHealth(
  board: Board,
  env: Record<string, string | undefined>,
): AdapterHealth {
  const rows: AdapterStatus[] = [
    {
      key: "SMS",
      // One provider is wired and it writes to the demo phones; the carrier adapter in this
      // build is a stub whose `send` throws. No environment makes it a real send.
      mode: "MOCK",
      mockedBecause: "NO_CARRIER_ADAPTER",
      facts: smsFacts(board),
    },
    {
      key: "MAPS",
      // There is no routing adapter to configure at all, so "Live" here would name a code path
      // that does not exist.
      mode: "MOCK",
      mockedBecause: "REPLAYED_ROUTES",
      facts: mapFacts(board),
    },
    {
      key: "AGENT",
      // `agentRunner()` refuses by name on every deployment: there is nothing to drive a run.
      mode: "MOCK",
      mockedBecause: "NO_RUNNER",
      // The one thing configuration still decides about it, and the operator's own question:
      // would a live call be permitted at all if there were something to drive it?
      facts: { liveCallsRefused: liveModelCallsRefused(env) ? 1 : 0 },
    },
  ];
  return { rows, allMocked: rows.every((row) => row.mode === "MOCK") };
}
