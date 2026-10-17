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
import type { AskedLane, PlanDay } from "@/domain/plan/stages";
import { planRoutes } from "@/ui/copy";

/**
 * What came back. A kept plan carries the instant the server wrote it down, which is the one
 * thing on this screen only the server can know — the saved line reads that minute out
 * (`savedLine`), so a coordinator who saves twice can tell the two apart.
 */
export type SaveOutcome = { ok: true; savedAt: string } | { ok: false; reason: string };

/**
 * The lanes as the endpoint takes them: the van, what has been said about it, and the
 * configuration the ramp pinned — and **not** the driver.
 *
 * Who is at the wheel changes nothing the solver decides and nothing that is saved, so the name
 * stays on the screen rather than travelling in a request body. TEST-SEC-02 is the rule and
 * e2e/plan-routes.spec.ts is where it is read off the wire: no person, place or family reaches
 * a payload from this screen.
 */
function laneFacts(day: PlanDay): Record<string, AskedLane> {
  return Object.fromEntries(
    Object.entries(day.stages).map(([laneId, stage]) => [
      laneId,
      stage.rampLayoutId === undefined
        ? { vehicleKey: stage.vehicleKey, arrival: stage.arrival }
        : {
            vehicleKey: stage.vehicleKey,
            arrival: stage.arrival,
            rampLayoutId: stage.rampLayoutId,
          },
    ]),
  );
}

/**
 * The request body, which is also the definition of "the plan on screen" for
 * {@link planFingerprint}: one shape, so what is compared is exactly what would be sent.
 */
function requestBody(day: PlanDay, assignment: Assignment) {
  return {
    scenario: day.scenario,
    direction: day.direction,
    stages: laneFacts(day),
    measured: day.measured,
    assignment,
  };
}

/**
 * The plan on screen as one string, so it can be compared with the one last saved.
 *
 * Vera's review, 2026-10-17: the screen must say when it holds something the server has not been
 * told about. "Something changed" is not a flag a handler can set honestly — a child dragged out
 * and back is two changes and no difference — so the screen compares instead, and this is the
 * comparison: every fact the request carries, written down in an order that does not depend on
 * which one a coordinator touched first.
 *
 * What it deliberately leaves out is what the request leaves out: who is driving. A relief
 * driver changes nothing that is saved (see {@link laneFacts}), so taking one does not make a
 * saved plan unsaved. Each lane's riders are sorted for the same reason: a plan is who is in
 * which van, not the order they were put there.
 */
export function planFingerprint(day: PlanDay, assignment: Assignment): string {
  const body = requestBody(day, assignment);
  const lanes = Object.entries(body.stages)
    .map(([id, lane]) => `${id}:${lane.vehicleKey}:${lane.arrival}:${lane.rampLayoutId ?? ""}`)
    .sort();
  const vans = Object.entries(body.assignment)
    .map(([id, tokens]) => `${id}:${[...tokens].sort().join(",")}`)
    .sort();
  return [
    body.scenario,
    body.direction,
    [...body.measured].sort().join(","),
    lanes.join(";"),
    vans.join(";"),
  ].join("|");
}

/** Send one run's plan to be checked and kept. */
export async function savePlan(day: PlanDay, assignment: Assignment): Promise<SaveOutcome> {
  let payload: unknown;
  try {
    const response = await fetch(API.planSave, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(day, assignment)),
    });
    payload = await response.json().catch(() => null);
    const savedAt = response.ok ? savedAtIn(payload) : null;
    if (savedAt) return { ok: true, savedAt };
  } catch {
    return { ok: false, reason: planRoutes.saveFailed };
  }
  const refusal = refusalIn(payload);
  return { ok: false, reason: refusal ?? planRoutes.saveFailed };
}

/**
 * The instant a kept plan was kept, or `null` for a body that does not say it was kept — which
 * includes a body that says it was but cannot say when.
 *
 * An answer with no readable time is not a saved answer this screen can report: the one line it
 * would print is "Plan saved at …", and filling that from the browser's own clock would be the
 * screen inventing the record. So it falls through to the one sentence that claims nothing.
 */
function savedAtIn(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { ok, savedAt } = payload as { ok?: unknown; savedAt?: unknown };
  if (ok !== true || typeof savedAt !== "string") return null;
  return Number.isNaN(new Date(savedAt).getTime()) ? null : savedAt;
}

/** The plain sentence a refusal carries, when the body has one to show. */
function refusalIn(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}
