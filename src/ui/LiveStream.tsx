"use client";

/**
 * The live board, on the client (ADR-002, PRD §14 SURF-01, DESIGN-DIRECTION §2).
 *
 * One subscription per tab, held by the console shell, so the board and the header's own GPS
 * pill read the same instant: a header that aged its pill off a second connection would drift
 * from the rows underneath it within a minute.
 *
 * It owns three facts and no decisions. The decisions — what a delta means, whether one fits
 * the board we hold — are the pure functions in src/domain/board/live.ts, which is also what
 * the server serialises, so there is exactly one merge rule and it is unit-tested.
 *
 *  - the snapshot we hold;
 *  - when the last event arrived, which is what DESIGN-DIRECTION §2's amber bar is about;
 *  - whether anybody has asked for the stream at all. Surfaces that have no day — Setup,
 *    Health — open no connection and their pills keep saying "Simulated", which is true.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { API } from "@/auth/access";
import { liveStreamConfig } from "@/config/live";
import { applyLiveDelta, type LiveDelta, type LiveSnapshot } from "@/domain/board/live";
import { LIVE_EVENT } from "@/modules/realtime/sse";

export interface LiveBoardState {
  /** The board as the stream last left it, or `null` before the first event. */
  snapshot: LiveSnapshot | null;
  /** DESIGN-DIRECTION §2: no event for longer than the configured gap. */
  paused: boolean;
  /** Seconds since the last event, or `null` while nothing has been asked for. */
  staleSeconds: number | null;
  /** True once a surface has asked for the stream. */
  requested: boolean;
  /** Called by the surface that wants updates. Idempotent. */
  request: (enabled: boolean, speed: number) => void;
}

const NOT_REQUESTED: LiveBoardState = {
  snapshot: null,
  paused: false,
  staleSeconds: null,
  requested: false,
  request: () => {},
};

const LiveBoardContext = createContext<LiveBoardState>(NOT_REQUESTED);

/** What the board and the header read. Safe outside the provider: nothing is live there. */
export function useLiveBoard(): LiveBoardState {
  return useContext(LiveBoardContext);
}

/**
 * Ask for the stream from a surface that has a day (the board does; nothing else does yet).
 * Called in an effect so the request belongs to a mounted surface and is dropped with it.
 */
export function useRequestLiveBoard(enabled: boolean, speed: number): void {
  const { request } = useLiveBoard();
  useEffect(() => {
    request(enabled, speed);
    return () => request(false, speed);
  }, [request, enabled, speed]);
}

/** How often the "how stale is this board" question is re-asked. */
const STALENESS_TICK_MS = 1000;

export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const [wanted, setWanted] = useState<{ enabled: boolean; speed: number; sinceMs: number }>({
    enabled: false,
    speed: liveStreamConfig.defaultSpeed,
    sinceMs: 0,
  });
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [lastEventAtMs, setLastEventAtMs] = useState<number | null>(null);
  /**
   * Zero until an effect runs, so the server-rendered markup and the first client render agree
   * — a clock read during render would be two different numbers and a hydration mismatch.
   */
  const [nowMs, setNowMs] = useState(0);
  /** Bumped to rebuild the connection when a delta cannot be applied to what we hold. */
  const [resyncs, setResyncs] = useState(0);

  const request = useCallback((enabled: boolean, speed: number) => {
    setWanted((previous) =>
      previous.enabled === enabled && previous.speed === speed
        ? previous
        : /*
           * When the ask began, which is what staleness is measured from until the first event
           * arrives: a stream that never delivers — refused, blocked, a dead proxy — then
           * raises the §2 bar after the configured gap instead of leaving a board that looks
           * fresh forever.
           */
          { enabled, speed, sinceMs: Date.now() },
    );
  }, []);

  useEffect(() => {
    if (!wanted.enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    const url =
      wanted.speed === liveStreamConfig.defaultSpeed
        ? API.stream
        : `${API.stream}?speed=${wanted.speed}`;
    const source = new EventSource(url);

    const seen = () => setLastEventAtMs(Date.now());

    const onSnapshot = (event: MessageEvent<string>) => {
      setSnapshot(JSON.parse(event.data) as LiveSnapshot);
      seen();
    };
    const onDelta = (event: MessageEvent<string>) => {
      const delta = JSON.parse(event.data) as LiveDelta;
      setSnapshot((held) => {
        if (held === null) return held;
        if (delta.fromTick !== held.tick) {
          /*
           * The delta is measured from a tick we do not hold, so applying it would leave the
           * board a mixture of two instants. Drop the connection instead and take a whole
           * board from a fresh one — a redraw is cheap, a half-applied board is not.
           */
          setResyncs((n) => n + 1);
          return held;
        }
        return applyLiveDelta(held, delta);
      });
      seen();
    };

    source.addEventListener(LIVE_EVENT.snapshot, onSnapshot as EventListener);
    source.addEventListener(LIVE_EVENT.delta, onDelta as EventListener);
    // "Alive, nothing moved": enough to keep the bar down, and it carries no resume point.
    source.addEventListener(LIVE_EVENT.idle, seen as EventListener);
    source.addEventListener("open", seen);

    return () => {
      source.removeEventListener(LIVE_EVENT.snapshot, onSnapshot as EventListener);
      source.removeEventListener(LIVE_EVENT.delta, onDelta as EventListener);
      source.removeEventListener(LIVE_EVENT.idle, seen as EventListener);
      source.removeEventListener("open", seen);
      source.close();
    };
  }, [wanted.enabled, wanted.speed, resyncs]);

  // The board's own age, re-read once a second. Only while something is subscribed: a page
  // with no stream has no age to show and no reason to wake up.
  useEffect(() => {
    if (!wanted.enabled) return;
    const id = window.setInterval(() => setNowMs(Date.now()), STALENESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [wanted.enabled]);

  const value = useMemo<LiveBoardState>(() => {
    // Before the first event, the board's age is the age of the *ask*: see `request` above.
    const since = lastEventAtMs ?? (wanted.enabled ? wanted.sinceMs : null);
    const staleSeconds =
      since === null || nowMs === 0 ? null : Math.max(0, (nowMs - since) / 1000);
    return {
      snapshot,
      paused: staleSeconds !== null && staleSeconds >= liveStreamConfig.pausedAfterSeconds,
      staleSeconds,
      requested: wanted.enabled,
      request,
    };
  }, [snapshot, lastEventAtMs, nowMs, wanted.enabled, wanted.sinceMs, request]);

  return <LiveBoardContext.Provider value={value}>{children}</LiveBoardContext.Provider>;
}
