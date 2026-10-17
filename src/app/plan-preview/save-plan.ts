/**
 * The screen's one request: saving the plan.
 *
 * Everything else on Plan routes is computed in the browser from the synthetic day, so this is
 * the only place the screen talks to the server at all — and it is deliberately thin. The
 * decision is not here: the endpoint re-asks the solver about every child in the plan
 * (src/domain/plan/save.ts), so what comes back is either "kept" or the refusal in the words the
 * screen would have used for the same verdict, and this module's whole job is to put that
 * sentence in the notice line.
 *
 * The endpoint's path is read from the access table (`API`), which is where every `/api/...`
 * string in this app lives — a screen may not write one (src/ui/no-internals.test.ts).
 *
 * Nothing is interpreted beyond the shape: a status this module does not know about, a body that
 * is not JSON, and a request that never arrived are one outcome — not saved, with the one
 * sentence that says what to do — because a screen that guessed at a failure it cannot read
 * would be claiming to know something it does not.
 */
import { API } from "@/auth/access";
import type { Assignment } from "@/domain/solver";
import type { PlanDay } from "@/domain/plan/stages";
import { planRoutes } from "@/ui/copy";

export type SaveOutcome = { ok: true } | { ok: false; reason: string };

/** Send one run's plan to be checked and kept. */
export async function savePlan(day: PlanDay, assignment: Assignment): Promise<SaveOutcome> {
  let payload: unknown;
  try {
    const response = await fetch(API.planSave, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: day.scenario,
        direction: day.direction,
        stages: day.stages,
        measured: day.measured,
        assignment,
      }),
    });
    payload = await response.json().catch(() => null);
    if (response.ok && isSaved(payload)) return { ok: true };
  } catch {
    return { ok: false, reason: planRoutes.saveFailed };
  }
  const refusal = refusalIn(payload);
  return { ok: false, reason: refusal ?? planRoutes.saveFailed };
}

function isSaved(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === true;
}

/** The plain sentence a refusal carries, when the body has one to show. */
function refusalIn(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}
