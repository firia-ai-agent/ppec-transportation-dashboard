/**
 * ASK BEFORE A RESET THROWS A PLAN AWAY — the decision behind both restart controls.
 *
 * SOURCE: Vera's copy of 2026-10-18 (`demoDay.confirm`, verbatim), founder-approved: a reset
 * clears the saved plan for all three vans and there is no undo for it, so the two controls that
 * call `POST /api/demo/reset` — "Restart demo day" in the DEMO bar (src/ui/DemoRestart.tsx) and
 * "Start demo day" on the board's own strip (src/app/plan-routes/board/PlanBoard.tsx) — ask
 * first. With no plan saved for today there is nothing to lose and the press goes straight
 * through, exactly as it did before.
 *
 * Why this is a module and not two `useState`s: the two controls are in different trees — one is
 * chrome in the root layout, one is a screen — so "when do we ask, and what does each answer
 * do" is written once here, the dialog is one component (src/ui/ConfirmRestart.tsx), and the
 * decision is a unit test rather than a browser walk. There is no DOM in this file and no React:
 * the one thing that must be provable is that **Keep plan sends nothing**, and that is `send:
 * false` with no other path to the request.
 *
 * Pure except for {@link sendDemoReset} and {@link savedPlanToday}, which take their `fetch`.
 */
import { API } from "@/auth/access";

/** Where a restart control is: nothing happening, asking, or sending. */
export type RestartStep = "IDLE" | "ASKING" | "SENDING";

/** What a person just did to a restart control. */
export type RestartEvent =
  /** They pressed "Restart demo day" / "Start demo day". */
  | "PRESS"
  /** They answered "Keep plan" — or pressed Escape, which is the same answer. */
  | "KEEP"
  /** They answered "Restart". */
  | "RESTART";

/**
 * The whole decision: the step to go to, and whether the reset is sent.
 *
 * `send` is the only way to the request. A `KEEP` can never produce one, which is the property
 * the test holds and the reason this is a function rather than two handlers.
 */
export function restartStep(
  event: RestartEvent,
  hasSavedPlan: boolean,
): { step: RestartStep; send: boolean } {
  switch (event) {
    case "PRESS":
      // Nothing saved for today is nothing to warn about: the old behaviour, unchanged.
      return hasSavedPlan ? { step: "ASKING", send: false } : { step: "SENDING", send: true };
    case "KEEP":
      return { step: "IDLE", send: false };
    case "RESTART":
      return { step: "SENDING", send: true };
  }
}

/**
 * The reset itself — the endpoint the app already has, from the one table that holds its paths
 * (src/auth/access.ts), with the same three gates in front of it as before. This decides nothing
 * about who may reset.
 */
export async function sendDemoReset(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchImpl(API.demoReset, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return response.ok;
}

/**
 * Is there a plan saved for today, on either leg?
 *
 * Read through the board route the screens already read (`GET /api/plan`, which is `loadBoard`
 * behind a guard) rather than a store or a query of its own: a saved plan is `version > 0`,
 * which is the same fact the board's own toolbar chip stands on. Both legs, because the morning
 * and the afternoon are two plans and the reset clears both.
 *
 * A read that could not be made answers **true**: the honest reading of "nobody knows" in front
 * of something irreversible is to ask the question, not to skip it.
 */
export async function savedPlanToday(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const legs = await Promise.all(
      (["am", "pm"] as const).map(async (leg) => {
        const response = await fetchImpl(`${API.planBoard}?leg=${leg}`, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { version?: number } | null;
        return typeof body?.version === "number" ? body.version : null;
      }),
    );
    if (legs.some((version) => version === null)) return true;
    return legs.some((version) => (version ?? 0) > 0);
  } catch {
    return true;
  }
}
