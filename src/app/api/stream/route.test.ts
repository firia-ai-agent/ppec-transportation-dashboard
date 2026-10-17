/**
 * The stream endpoint, as a `curl` would meet it.
 *
 * src/modules/realtime/sse.test.ts holds the protocol; this holds the HTTP answer: who is
 * refused, what the first bytes are, that a reconnect is resumed rather than restarted, and
 * that a site id in the query buys nothing (BUILD-PLAN §4's ID-swap row for an SSE subscribe).
 *
 * The session reader is mocked — there is no cookie jar here — and there is no database at all,
 * because this route reads none: the morning it streams is the committed replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffRole } from "@/auth/core";
import { apiAccess } from "@/ui/copy";
import { BOARD_SCENARIO_TICK } from "@/domain/board/day";
import { snapshotFor } from "@/domain/board/live";
import { LIVE_EVENT, SSE_CONTENT_TYPE } from "@/modules/realtime/sse";

const mocks = vi.hoisted(() => ({ getCaller: vi.fn(), openStream: vi.fn() }));
vi.mock("@/auth/caller", () => ({ getCaller: mocks.getCaller }));

/**
 * The board walker, wrapped rather than replaced.
 *
 * `openStream` is the first thing on this route that *reads the morning* — it builds the
 * snapshot a subscriber would be handed. Spying on it is how "the session is checked before
 * anything is streamed" becomes an assertion instead of a reading of the code: a refused
 * caller must leave this function uncalled, and the real one still runs for everybody else, so
 * every other test in this file is unaffected.
 */
vi.mock("@/modules/realtime/live-board-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/realtime/live-board-stream")>();
  return {
    ...actual,
    openStream: (...args: Parameters<typeof actual.openStream>) => {
      mocks.openStream(...args);
      return actual.openStream(...args);
    },
  };
});

function signedIn(role: StaffRole | null) {
  mocks.getCaller.mockResolvedValue(
    role
      ? { kind: "STAFF", role, userId: "u-1", memberships: [] }
      : { kind: "ANONYMOUS", memberships: [] },
  );
}

async function open(query = "", headers: Record<string, string> = {}): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new Request(`https://example.test/api/stream${query}`, { headers }));
}

/**
 * The first `n` events off a live stream, parsed. The response never ends on its own, so the
 * body is read until we have what we asked for and then cancelled — which is also what a
 * browser does when the board is closed.
 */
async function read(
  response: Response,
  n: number,
): Promise<{ raw: string; frames: Array<{ id?: string; event: string; data: unknown }> }> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const frames: Array<{ id?: string; event: string; data: unknown }> = [];
  try {
    while (frames.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      frames.length = 0;
      for (const block of raw.split("\n\n")) {
        const event = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (!event || !data) continue;
        const id = /^id: (.+)$/m.exec(block);
        frames.push({ id: id?.[1], event: event[1], data: JSON.parse(data[1]) });
      }
    }
  } finally {
    await reader.cancel();
  }
  return { raw, frames };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who may subscribe", () => {
  it("401 with no session", async () => {
    signedIn(null);
    const response = await open();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: apiAccess.signIn });
  });

  it("403 for the front desk, whose surface is the ramp iPad", async () => {
    signedIn("FRONT_DESK");
    const response = await open();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ ok: false, error: apiAccess.notYourRole });
  });

  for (const role of ["DIRECTOR", "COORDINATOR"] as const) {
    it(`streams to a ${role.toLowerCase()}`, async () => {
      signedIn(role);
      const response = await open();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(SSE_CONTENT_TYPE);
      expect(response.headers.get("cache-control")).toContain("no-store");
      await (response.body as ReadableStream).cancel();
    });
  }
});

/**
 * Veri's gate: the session is checked **before anything is streamed**, and a caller without one
 * is sent zero events.
 *
 * "401" on its own is not the whole requirement. A route that refused with the right status
 * while still opening the walk, or that answered with a stream whose first frame happened to be
 * an error, would pass a status assertion and fail the rule — the point of the gate is that an
 * unauthenticated request learns nothing about the morning. So each refusal is asserted three
 * ways: the status, the body (one JSON sentence, with no SSE framing anywhere in it), and the
 * board walker left untouched.
 */
describe("the session is checked before anything is streamed", () => {
  /** Everything an SSE body is made of. None of it may appear in a refusal. */
  const SSE_FRAMING = [/^retry:/m, /^id:/m, /^event:/m, /^data:/m];

  /** The whole refusal body, read to completion — a refusal is never a connection that stays open. */
  async function refusalBody(response: Response): Promise<string> {
    return response.text();
  }

  async function expectZeroEvents(response: Response, expected: { status: number; error: string }) {
    expect(response.status).toBe(expected.status);
    // Not a stream: the content type is JSON, and `EventSource` would reject it as one.
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("content-type")).not.toContain(SSE_CONTENT_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await refusalBody(response);
    expect(JSON.parse(body)).toEqual({ ok: false, error: expected.error });
    // Zero events, by the only definition that matters: nothing in the body is a frame.
    for (const pattern of SSE_FRAMING) expect(body).not.toMatch(pattern);
    for (const event of Object.values(LIVE_EVENT)) expect(body).not.toContain(event);
    // And the walk was never opened, so there was no board to leak in the first place.
    expect(mocks.openStream).not.toHaveBeenCalled();
  }

  it("sends a signed-out caller 401 and not one event", async () => {
    signedIn(null);
    await expectZeroEvents(await open(), { status: 401, error: apiAccess.signIn });
  });

  it("refuses before it reads the clock speed or the resume point a caller crafted", async () => {
    // Everything this route would otherwise read off the request — a resume point, a speed, a
    // site id — handed over at once. None of it buys a frame, because none of it is read.
    signedIn(null);
    const response = await open(`?speed=60&since=${BOARD_SCENARIO_TICK}&site=00000000-0000-0000-0000-00000000beef`, {
      "last-event-id": String(BOARD_SCENARIO_TICK),
    });
    await expectZeroEvents(response, { status: 401, error: apiAccess.signIn });
  });

  it("sends a signed-in caller who is not on the board's row 403 and not one event", async () => {
    signedIn("FRONT_DESK");
    await expectZeroEvents(await open(), { status: 403, error: apiAccess.notYourRole });
  });

  /**
   * The other half of "before streaming anything": a refused request leaves no clock running.
   *
   * The walk is a `setInterval` opened inside the response body's `start`, so a route that
   * built the stream and *then* refused would leave a timer ticking over the morning for a
   * caller who was turned away. Counted rather than described, with an allowed caller beside it
   * so the count means something.
   */
  it("leaves no clock running for a request it refused", async () => {
    vi.useFakeTimers();
    try {
      signedIn(null);
      expect((await open()).status).toBe(401);
      expect(vi.getTimerCount()).toBe(0);

      signedIn("DIRECTOR");
      const allowed = await open();
      expect(allowed.status).toBe(200);
      expect(vi.getTimerCount()).toBe(1);
      await (allowed.body as ReadableStream).cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the first bytes", () => {
  it("are the reconnect delay and the whole board at the page's own instant", async () => {
    signedIn("COORDINATOR");
    const { raw, frames } = await read(await open(), 1);
    expect(raw.startsWith("retry: ")).toBe(true);
    expect(frames[0].event).toBe(LIVE_EVENT.snapshot);
    expect(frames[0].id).toBe(String(BOARD_SCENARIO_TICK));
    // The board **as this role may hold it**: the payload is filtered before it is written
    // (src/domain/board/live.ts `forViewer`), not after it reaches the browser.
    expect(frames[0].data).toEqual(
      JSON.parse(JSON.stringify(snapshotFor("COORDINATOR", BOARD_SCENARIO_TICK))),
    );
  });

  it("carry the demo's internals to a director and not to a coordinator", async () => {
    signedIn("DIRECTOR");
    const director = await read(await open(), 1);
    signedIn("COORDINATOR");
    const coordinator = await read(await open(), 1);

    const silentOf = (data: unknown) => (data as { silent: unknown[] }).silent;
    const countsOf = (data: unknown) =>
      (data as { vehicles: Array<{ counts?: unknown }> }).vehicles.map((v) => v.counts);

    expect(silentOf(director.frames[0].data).length).toBeGreaterThan(0);
    expect(silentOf(coordinator.frames[0].data)).toEqual([]);
    expect(countsOf(director.frames[0].data).every((c) => c !== undefined)).toBe(true);
    expect(countsOf(coordinator.frames[0].data).every((c) => c === undefined)).toBe(true);
  });

  it("carry no snapshot when the client says which tick it already holds", async () => {
    signedIn("COORDINATOR");
    // ×60, so the first delta arrives in well under a second of real time. An `idle` frame may
    // land first — a timer that fires a millisecond early is a tick that has not happened yet —
    // and that is the point of `idle`: it says "alive, nothing moved" without a resume point.
    const { frames } = await read(
      await open("?speed=60", { "last-event-id": String(BOARD_SCENARIO_TICK) }),
      3,
    );
    expect(frames.some((frame) => frame.event === LIVE_EVENT.snapshot)).toBe(false);
    const delta = frames.find((frame) => frame.event === LIVE_EVENT.delta);
    expect(delta?.data).toMatchObject({ fromTick: BOARD_SCENARIO_TICK });
  });

  it("accept the same resume point as a query, for a caller that reconnects by hand", async () => {
    signedIn("COORDINATOR");
    const { frames } = await read(await open(`?speed=60&since=${BOARD_SCENARIO_TICK + 6}`), 3);
    const delta = frames.find((frame) => frame.event === LIVE_EVENT.delta);
    expect(delta?.data).toMatchObject({ fromTick: BOARD_SCENARIO_TICK + 6 });
  });

  it("send the whole board when the resume point is not a tick", async () => {
    signedIn("COORDINATOR");
    const { frames } = await read(await open("", { "last-event-id": "later" }), 1);
    expect(frames[0].event).toBe(LIVE_EVENT.snapshot);
  });
});

describe("the stream keeps walking the morning", () => {
  it("sends monotone ids and no duplicate tick", async () => {
    signedIn("DIRECTOR");
    const { frames } = await read(await open("?speed=60"), 4);
    const ids = frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
    expect(ids.length).toBeGreaterThan(1);
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
  });

  it("chains its deltas, so a client can apply them one after another", async () => {
    signedIn("DIRECTOR");
    const { frames } = await read(await open("?speed=60"), 4);
    const deltas = frames.filter((f) => f.event === LIVE_EVENT.delta) as Array<{
      data: { fromTick: number; tick: number };
    }>;
    expect(deltas.length).toBeGreaterThan(1);
    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i].data.fromTick).toBe(deltas[i - 1].data.tick);
    }
    expect(deltas[0].data.fromTick).toBe(BOARD_SCENARIO_TICK);
  });
});

describe("a site id in the query buys nothing (BUILD-PLAN §4)", () => {
  it("streams the caller's own board, whatever site is asked for", async () => {
    signedIn("COORDINATOR");
    const mine = await read(await open(), 1);
    const theirs = await read(await open("?site=00000000-0000-0000-0000-00000000beef"), 1);
    expect(theirs.frames[0].data).toEqual(mine.frames[0].data);
  });
});
