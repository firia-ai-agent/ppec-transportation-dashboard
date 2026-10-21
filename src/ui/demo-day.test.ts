import { describe, expect, it, vi } from "vitest";
import { DEMO_RESET_REFUSAL } from "@/modules/demo/refusal";
import { scenarioClock } from "./copy";
import { startDemoDay, type DemoResetAnswer } from "./demo-day";

/**
 * One press of "Start demo day", and what it is allowed to do in which order.
 *
 * The founder's final ruling (2026-10-17 14:44 ET, DECISION-LEDGER row 88) is two acts in a
 * fixed order — the demo's **data** back to the start of the day, then the **clock** — and the
 * order is the safety property: a clock that starts over a reset that failed is a demo day
 * running across a database nobody put back. So every case below records the calls in the order
 * they happened and asserts the whole sequence, not merely that each one was called.
 *
 * The three answers it has to tell apart:
 *  - the reset ran (200): clock, then the screens re-render over the new rows;
 *  - the reset refused **by design** — a preview, where the database is production's served
 *    read-only (DECISION-LEDGER #43): the clock starts anyway, with one line saying so;
 *  - anything else: a failure, the clock does not start, and the words say to try again.
 */

/** The press, with every effect recorded in the order it was called. */
function press(answer: DemoResetAnswer | Error) {
  const calls: string[] = [];
  const deps = {
    reset: vi.fn(async () => {
      calls.push("reset");
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    startClock: vi.fn(() => calls.push("clock")),
    refresh: vi.fn(() => calls.push("refresh")),
  };
  return { calls, deps, run: () => startDemoDay(deps) };
}

describe("the reset runs, then the clock", () => {
  it("is that order, and the screens are re-rendered after both", async () => {
    const { calls, run } = press({ status: 200 });

    const outcome = await run();

    expect(calls).toEqual(["reset", "clock", "refresh"]);
    expect(outcome).toEqual({ started: true, note: null });
  });

  it("says nothing on screen when nothing went wrong", async () => {
    const outcome = await press({ status: 200 }).run();
    // The readout is the feedback (ScenarioClock.tsx): a line as well would be noise.
    expect(outcome.started && outcome.note).toBe(null);
  });
});

describe("a preview refuses by design: the clock still starts", () => {
  it("starts the clock and hands back the one line about the live site", async () => {
    const { calls, run } = press({ status: 403, refusal: DEMO_RESET_REFUSAL.readOnlyDb });

    const outcome = await run();

    expect(calls).toEqual(["reset", "clock"]);
    expect(outcome).toEqual({ started: true, note: scenarioClock.previewOnly });
    expect(outcome.started && outcome.note).toBe("Restart works on the live site only. The clock has started.");
  });

  it("does not refresh the screens: nothing on the server changed", async () => {
    const { deps, run } = press({ status: 403, refusal: DEMO_RESET_REFUSAL.readOnlyDb });
    await run();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("is told apart from a failure by the code, not by the sentence", async () => {
    // The same status, the same shape, no refusal code: a failure, and the clock stays put.
    const { calls, run } = press({ status: 403 });

    const outcome = await run();

    expect(calls).toEqual(["reset"]);
    expect(outcome).toEqual({ started: false, error: scenarioClock.failed });
  });
});

describe("a real failure starts nothing", () => {
  it.each([
    ["signed out", { status: 401 }],
    ["not this role", { status: 403 }],
    ["the demo flags are off", { status: 404 }],
    ["the reset threw", { status: 500 }],
    ["a refusal code from somewhere else", { status: 403, refusal: "something-else" }],
  ] as const)("%s: no clock, no refresh, and one sentence", async (_who, answer) => {
    const { calls, deps, run } = press(answer);

    const outcome = await run();

    expect(calls).toEqual(["reset"]);
    expect(deps.startClock).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(outcome).toEqual({ started: false, error: scenarioClock.failed });
    expect(outcome.started === false && outcome.error).toBe("Couldn't reset the demo. Try again.");
  });

  it("a request that never arrived is the same answer, with nothing of the error on screen", async () => {
    const { calls, run } = press(new Error("getaddrinfo ENOTFOUND db.internal"));

    const outcome = await run();

    expect(calls).toEqual(["reset"]);
    expect(outcome).toEqual({ started: false, error: scenarioClock.failed });
    // No host, no stack, no status: the sentence is the whole answer (COPY-GUIDE §1, §2).
    expect(outcome.started === false && outcome.error).not.toMatch(/ENOTFOUND|internal|Error/);
  });
});
