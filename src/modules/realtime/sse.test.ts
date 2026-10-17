/**
 * The SSE wire format, and the protocol the live board speaks over it.
 *
 * Three things here are invisible in a browser and break silently when they are wrong: the
 * blank line that dispatches an event, the `id` a reconnect resumes from, and the frame that
 * must *not* carry one. So they are asserted as text.
 */
import { describe, expect, it } from "vitest";
import { liveStreamConfig } from "@/config/live";
import { BOARD_SCENARIO_TICK } from "@/domain/board/day";
import { snapshotFor, type LiveSnapshot } from "@/domain/board/live";
import { LAST_TICK } from "@/domain/eta/scenario-clock";
import {
  advance,
  atEndOfMorning,
  openStream,
  streamExpired,
  tickIntervalMs,
} from "./live-board-stream";
import {
  encodeComment,
  encodeFrame,
  encodeRetry,
  LAST_EVENT_ID_HEADER,
  LIVE_EVENT,
  SSE_CONTENT_TYPE,
  SSE_HEADERS,
} from "./sse";

describe("the wire format", () => {
  it("ends every event with the blank line that dispatches it", () => {
    const text = encodeFrame({ event: LIVE_EVENT.delta, id: 7, data: { a: 1 } });
    expect(text).toBe('id: 7\nevent: delta\ndata: {"a":1}\n\n');
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("omits the id on a frame that must not move the client's resume point", () => {
    const text = encodeFrame({ event: LIVE_EVENT.idle, data: { tick: 3 } });
    expect(text.startsWith("event: idle")).toBe(true);
    expect(text).not.toContain("id:");
  });

  it("writes one data line, because JSON can hold no raw newline", () => {
    const text = encodeFrame({
      event: LIVE_EVENT.snapshot,
      id: 1,
      data: { note: "two\nlines", clock: "7:42 AM" },
    });
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    expect(dataLines).toHaveLength(1);
    expect(JSON.parse(dataLines[0].slice("data: ".length))).toEqual({
      note: "two\nlines",
      clock: "7:42 AM",
    });
  });

  it("tells the browser how long to wait before reconnecting", () => {
    expect(encodeRetry(2000)).toBe("retry: 2000\n\n");
    expect(encodeRetry(-1)).toBe("retry: 0\n\n");
  });

  it("keeps a comment on one line", () => {
    expect(encodeComment("still here\nreally")).toBe(": still here really\n\n");
  });

  it("answers as an event stream that nothing may cache or buffer", () => {
    expect(SSE_HEADERS["content-type"]).toContain(SSE_CONTENT_TYPE);
    expect(SSE_HEADERS["cache-control"]).toContain("no-store");
    expect(SSE_HEADERS["x-accel-buffering"]).toBe("no");
    expect(LAST_EVENT_ID_HEADER).toBe("last-event-id");
  });
});

/** The role every assertion below subscribes as, unless it is about roles. */
const DIRECTOR = "DIRECTOR" as const;

describe("a fresh connection", () => {
  it("opens at the instant the page itself was rendered at, with the whole board", () => {
    const { tick, frames } = openStream(null, DIRECTOR);
    expect(tick).toBe(BOARD_SCENARIO_TICK);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe(LIVE_EVENT.snapshot);
    expect(frames[0].id).toBe(BOARD_SCENARIO_TICK);
    expect(frames[0].data).toEqual(snapshotFor(DIRECTOR, BOARD_SCENARIO_TICK));
  });
});

describe("a reconnecting connection (ADR-002: no missed and no duplicate event)", () => {
  it("sends no snapshot: the client already holds that board", () => {
    const resumed = openStream(BOARD_SCENARIO_TICK, DIRECTOR);
    expect(resumed.tick).toBe(BOARD_SCENARIO_TICK);
    expect(resumed.frames).toEqual([]);
  });

  it("resumes at the tick the client named, so the next id is the next tick", () => {
    const resumed = openStream(100, DIRECTOR);
    const step = advance(resumed.tick, resumed.tick, tickIntervalMs(1), 1, DIRECTOR);
    expect(step.frames[0].id).toBe(101);
    expect(step.frames[0].event).toBe(LIVE_EVENT.delta);
  });

  it("carries a delta measured from the client's own tick, so it can be applied", () => {
    const resumed = openStream(144, DIRECTOR);
    const step = advance(resumed.tick, resumed.tick, tickIntervalMs(1) * 3, 1, DIRECTOR);
    expect(step.frames[0].data).toMatchObject({ fromTick: 144, tick: 147 });
  });
});

describe("walking the clock", () => {
  it("sends nothing until a whole tick of wall time has passed", () => {
    const step = advance(144, 144, tickIntervalMs(1) - 1, 1, DIRECTOR);
    expect(step.tick).toBe(144);
    expect(step.frames[0].event).toBe(LIVE_EVENT.idle);
  });

  it("covers several missed ticks with one delta rather than a burst", () => {
    const step = advance(144, 144, tickIntervalMs(1) * 12, 1, DIRECTOR);
    expect(step.tick).toBe(156);
    expect(step.frames).toHaveLength(1);
    expect(step.frames[0].data).toMatchObject({ fromTick: 144, tick: 156 });
  });

  it("reads the target off the elapsed time, so a slow loop never drifts", () => {
    // Two steps, the second one late: the tick is where the wall clock says, not one further.
    const first = advance(144, 144, tickIntervalMs(1), 1, DIRECTOR);
    const late = advance(144, first.tick, tickIntervalMs(1) * 9, 1, DIRECTOR);
    expect(late.tick).toBe(153);
  });

  it("holds at the end of the morning and keeps saying so", () => {
    const step = advance(LAST_TICK, LAST_TICK, tickIntervalMs(60) * 10_000, 60, DIRECTOR);
    expect(step.tick).toBe(LAST_TICK);
    expect(step.frames[0].event).toBe(LIVE_EVENT.idle);
    expect(atEndOfMorning(LAST_TICK)).toBe(true);
    expect(atEndOfMorning(BOARD_SCENARIO_TICK)).toBe(false);
  });

  it("closes under the platform's ceiling so the browser can reconnect", () => {
    expect(streamExpired(0)).toBe(false);
    expect(streamExpired(liveStreamConfig.maxStreamSeconds * 1000 - 1)).toBe(false);
    expect(streamExpired(liveStreamConfig.maxStreamSeconds * 1000)).toBe(true);
    expect(liveStreamConfig.maxStreamSeconds).toBeLessThan(300);
  });
});

describe("what a subscriber is sent depends on their role (map-view matrix)", () => {
  it("gives the demo's own internals to the director and not to the coordinator", () => {
    const director = openStream(null, "DIRECTOR").frames[0].data as LiveSnapshot;
    const coordinator = openStream(null, "COORDINATOR").frames[0].data as LiveSnapshot;

    // The fault internals: the van with no binding, and the dropped-point counts.
    expect(director.silent.length).toBeGreaterThan(0);
    expect(coordinator.silent).toEqual([]);
    expect(director.vehicles.every((v) => v.counts !== undefined)).toBe(true);
    expect(coordinator.vehicles.every((v) => v.counts === undefined)).toBe(true);

    // Everything the board is actually about is the same for both.
    expect(coordinator.vehicles.map((v) => v.id)).toEqual(director.vehicles.map((v) => v.id));
    expect(coordinator.rides).toEqual(director.rides);
    expect(coordinator.notifications).toEqual(director.notifications);
  });

  it("strips the family label and the windows for a role that may not hold them", () => {
    const frontDesk = openStream(null, "FRONT_DESK").frames[0].data as LiveSnapshot;
    expect(frontDesk.notifications).toEqual([]);
    for (const vehicle of frontDesk.vehicles) {
      for (const stop of vehicle.stops) expect(stop.familyLabel).toBeUndefined();
    }
  });

  it("sends a role with no map at all no vans and no routes", () => {
    const nobody = openStream(null, "ANONYMOUS").frames[0].data as LiveSnapshot;
    expect(nobody.vehicles).toEqual([]);
    expect(nobody.routes).toEqual([]);
    expect(nobody.gpsAgeSeconds).toBeNull();
  });

  it("filters a delta the same way, so one can always be applied to the other", () => {
    const step = advance(144, 144, tickIntervalMs(1) * 12, 1, "COORDINATOR");
    const delta = step.frames[0].data as { vehicles: Array<{ counts?: unknown }> };
    expect(delta.vehicles.every((v) => v.counts === undefined)).toBe(true);
  });
});
