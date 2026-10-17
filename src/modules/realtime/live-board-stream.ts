/**
 * What the live board stream sends, and when (ADR-002, PRD §14 SURF-01).
 *
 * The whole protocol as pure functions, so the route below it is a loop and a writer and the
 * decisions are testable without a server: what a fresh connection gets, what a reconnecting
 * one gets, which tick we should be on after a span of wall time, and when the stream has to
 * close so the browser can reconnect under the platform's 300 s ceiling.
 *
 * **Where this deliberately differs from ADR-002, and why.** The ADR tails `ops.event_log`
 * over Neon HTTP and emits `id: seq`. There is no telemetry in `event_log` to tail: the demo
 * day's positions come from the committed replays (ADR-007 routes + the B-10 simulator) and
 * nothing writes a position row — see docs/ui/B12-SLICE3-DEFERRED.md. So this stream walks the
 * same deterministic replay the board is already computed from, and keeps the two properties
 * the ADR's test is actually about: **monotone ids** (a tick number, which is also an instant)
 * and **no missed or duplicate event after a reconnect** (the client names the last tick it
 * holds and the walk continues from there, so nothing is replayed and nothing is skipped). The
 * day the board's facts live in `event_log` — which is slice 4's writes — the tail replaces
 * `advance()` and the client is unchanged.
 *
 * One consequence, stated rather than hidden: the walk is **per connection**. Two browsers that
 * open the board a minute apart are a minute apart in the replay, and a client that was away
 * resumes where it stopped rather than jumping forward. For a replayed demo day that is the
 * honest reading — the board says "Demo day", every row carries the Simulated chip, and the
 * §2 amber bar says the board may be stale while a client is disconnected.
 */

import { liveStreamConfig } from "@/config/live";
import { BOARD_SCENARIO_TICK } from "@/domain/board/day";
import { liveDeltaBetween, liveSnapshotAt } from "@/domain/board/live";
import { clampTick, LAST_TICK, ticksElapsed, tickIntervalMs } from "@/domain/eta/scenario-clock";
import { LIVE_EVENT, type SseFrame } from "./sse";

/** Where a connection starts, and the first thing it sends. */
export function openStream(lastTick: number | null): { tick: number; frames: SseFrame[] } {
  if (lastTick === null) {
    // A client with nothing: the whole board at the instant the page itself was rendered at,
    // so the first frame cannot disagree with the HTML the browser already has.
    const tick = BOARD_SCENARIO_TICK;
    return { tick, frames: [{ event: LIVE_EVENT.snapshot, id: tick, data: liveSnapshotAt(tick) }] };
  }
  /*
   * A reconnecting client already holds the board at `lastTick`. Sending a snapshot would be a
   * duplicate id and a full re-render of 56 rides for nothing; the walk resumes and the next
   * delta carries what moved. This is the ADR-002 reconnect property: no missed id, no repeat.
   */
  return { tick: clampTick(lastTick), frames: [] };
}

/**
 * The frames owed after `elapsedMs` of wall time on a connection that started at `startTick`
 * and has sent up to `currentTick`.
 *
 * The target tick is computed from the elapsed time rather than by counting the ticks we have
 * sent, so a slow event loop or a long GC pause falls behind by nothing: the next frame simply
 * covers more scenario time. Several missed ticks are one delta, never a burst of them.
 */
export function advance(
  startTick: number,
  currentTick: number,
  elapsedMs: number,
  speed: number,
): { tick: number; frames: SseFrame[] } {
  const target = clampTick(startTick + ticksElapsed(elapsedMs, speed));
  if (target <= currentTick) {
    // Nothing moved — the morning is over, or the clock has not reached the next tick yet.
    return { tick: currentTick, frames: [{ event: LIVE_EVENT.idle, data: { tick: currentTick } }] };
  }
  return {
    tick: target,
    frames: [{ event: LIVE_EVENT.delta, id: target, data: liveDeltaBetween(currentTick, target) }],
  };
}

/** ADR-002: close under the platform's 300 s default and let the browser reconnect. */
export function streamExpired(elapsedMs: number): boolean {
  return elapsedMs >= liveStreamConfig.maxStreamSeconds * 1000;
}

/** The pause between writes at this speed. */
export { tickIntervalMs };

/** True once the replay has nothing left to send: the committed runs are over. */
export function atEndOfMorning(tick: number): boolean {
  return tick >= LAST_TICK;
}
