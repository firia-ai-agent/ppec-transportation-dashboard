"use client";
/**
 * One press, two things, in this order: the demo day's **data** back to the start, then the
 * **clock** running from the instant the page was rendered at.
 *
 * SOURCE: the founder's final ruling, 2026-10-17 14:44 ET (DECISION-LEDGER row 88) — "Start demo
 * day puts the demo back to the start of the day with all demo data, then starts the scenario
 * clock". It overrides the earlier clock-only button, which started a clock over whatever the
 * last demo had left on the board.
 *
 * The order is the whole point and it is asserted (demo-day.test.ts): the clock may only start
 * over data that has been put back, so a failed reset leaves the clock alone rather than running
 * a day across a half-reset database. What each answer does:
 *
 *  - **200** — the data is back. Start the clock, then refresh the screens, because every row on
 *    them was rendered from the rows that have just been replaced.
 *  - **403 with `refusal: read-only-db`** — a preview deployment, where the database is
 *    production's and read-only (DECISION-LEDGER #43). Expected, not broken: start the clock
 *    anyway and hand back one line saying the reset is the live site's. No refresh — nothing on
 *    the server changed, and the clock is what the surfaces read.
 *  - **anything else** — a failure. The clock does **not** start, and the line says so in the
 *    one sentence src/ui/copy.ts holds for it. No status code and no endpoint in it.
 *
 * It takes its three effects as arguments so the order can be measured without a browser or a
 * database; `postDemoReset` and the clock's own functions are what the header passes in.
 */

import { API } from "@/auth/access";
import { DEMO_RESET_REFUSAL } from "@/modules/demo/refusal";
import { scenarioClock } from "./copy";

/** What the endpoint answered, reduced to the two things the decision turns on. */
export type DemoResetAnswer = { status: number; refusal?: string };

export type DemoDayDeps = {
  /** The reset call. Resolves with the answer; rejects only if the request itself could not be made. */
  reset: () => Promise<DemoResetAnswer>;
  /** Puts the clock back to the page's instant and runs it (`restartDemoClock`). */
  startClock: () => void;
  /** Re-renders the server components over the new rows (`router.refresh`). */
  refresh: () => void;
};

/**
 * The outcome, as the header shows it: whether the clock is now running, and the one line to put
 * next to the button — `null` when there is nothing to say, which is the ordinary success.
 */
export type DemoDayOutcome =
  | { started: true; note: string | null }
  | { started: false; error: string };

export async function startDemoDay(deps: DemoDayDeps): Promise<DemoDayOutcome> {
  let answer: DemoResetAnswer;
  try {
    answer = await deps.reset();
  } catch {
    // A request that never arrived: the same answer as a refusal we cannot act on, and the
    // clock stays where it is. Nothing of the error reaches the screen.
    return { started: false, error: scenarioClock.failed };
  }

  if (answer.status === 200) {
    deps.startClock();
    deps.refresh();
    return { started: true, note: null };
  }

  if (answer.refusal === DEMO_RESET_REFUSAL.readOnlyDb) {
    deps.startClock();
    return { started: true, note: scenarioClock.previewOnly };
  }

  return { started: false, error: scenarioClock.failed };
}

/**
 * The reset over HTTP. The path is the endpoint's own key in the access table, so no `/api/...`
 * literal is written on a UI file (src/auth/access.ts names that rule).
 *
 * No site id in the body: the endpoint resolves the site from the caller's own membership, which
 * is the only site a demo control may touch — naming one from the browser is what the ID-swap
 * matrix is about (src/auth/idswap.test.ts). A body that is not JSON, or a 500 with an HTML page
 * in it, lands as "no refusal code", which is a failure.
 */
export async function postDemoReset(): Promise<DemoResetAnswer> {
  const res = await fetch(API.demoReset, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body: unknown = await res.json().catch(() => null);
  const refusal =
    body && typeof body === "object" && typeof (body as { refusal?: unknown }).refusal === "string"
      ? (body as { refusal: string }).refusal
      : undefined;
  return { status: res.status, refusal };
}
