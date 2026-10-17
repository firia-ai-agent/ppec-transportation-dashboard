import { z } from "zod";
import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { DEMO_SCENARIOS } from "@/domain/plan/day";
import { LANE_STAGES, planInputOf, readPlanDay } from "@/domain/plan/stages";
import { checkPlan, placedCount, saveRefusalLine } from "@/domain/plan/save";
import { getSavedPlan, putSavedPlan } from "@/modules/demo/plan-store";
import { apiAccess, planRoutes } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/** The run a plan is a plan of. Both methods name one. */
const run = z.strictObject({
  scenario: z.enum(DEMO_SCENARIOS),
  direction: z.enum(["AM", "PM"]),
});

/**
 * What the day knows about one lane's van: the van, what has been said about it, and the
 * configuration whoever saw it reported. Ids only — no person's name is accepted here, and the
 * day's own records supply the driver (src/domain/plan/stages.ts `AskedLane`).
 *
 * Strict, and bounded: an unexpected field is a 400 rather than something quietly ignored, and
 * the lengths are so a huge or wrongly-typed body is refused before any id is looked up. What
 * each value *means* is still checked against the day in `readPlanDay`.
 */
const stage = z.strictObject({
  vehicleKey: z.string().min(1).max(16),
  arrival: z.enum(LANE_STAGES),
  rampLayoutId: z.string().min(1).max(64).optional(),
});

const body = run.extend({
  stages: z.record(z.string().min(1).max(16), stage),
  /** Child tokens whose chair the ramp has measured (AT-04). */
  measured: z.array(z.string().min(1).max(16)).max(64),
  /** Lane id → the child tokens in it, which is what is being saved. */
  assignment: z.record(z.string().min(1).max(16), z.array(z.string().min(1).max(16)).max(64)),
});

/**
 * POST — save a plan for one run of the demo day. GET — read back the plan last saved for it.
 *
 * The guard is the shared session guard with this route's own row (DIRECTOR and COORDINATOR, the
 * two roles whose row opens the screen), so a signed-out caller is a 401 and the front desk is a
 * 403, in the same JSON shape every endpoint uses and before any id in the body is read.
 *
 * Then the thing this endpoint exists for: **the plan is re-asked of the solver**. The screen
 * checks every move as it is made, but a request is not the screen — so the body's own
 * description of the day is rebuilt into the solver's question (`readPlanDay` → `planInputOf`)
 * and the assignment is replayed child by child through the same `tryMove` a drag goes through
 * (`checkPlan`). A move the screen refused cannot be saved by posting round it, a pinned child
 * is re-checked like any other, and the refusal that comes back is the sentence the screen would
 * have shown for that same verdict.
 *
 * Five answers, and four of them are 4xx:
 *  - 400, a body this endpoint cannot read at all;
 *  - 404, a plan naming a child, a van or a configuration this run does not have — one uniform
 *    refusal, so the answer cannot be used to find out which of them existed somewhere else;
 *  - 409, nobody in any van and this run already has a saved plan: an empty screen does not
 *    overwrite a plan somebody made;
 *  - 422, every id is this run's own and the solver says no, with the van and the child named;
 *  - 200, the plan as the solver re-checked it, kept in the demo's own state.
 *
 * The GET is the other half of that state: the screen asks for the run's saved plan when it
 * opens one, so a reload shows the plan rather than an empty day (Veri's S1, 2026-10-17).
 */
export async function POST(req: Request) {
  const guard = await requireApiSession(API.planSave);
  if (!guard.ok) return guard.response;

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }

  const day = readPlanDay(parsed.data);
  if (!day) {
    return Response.json(
      { ok: false, error: planRoutes.saveNotThisRun },
      { status: 404, headers: noStore },
    );
  }

  /*
   * An empty screen is not a plan, and it may not be saved over one that is.
   *
   * The button cannot be pressed with nobody in a van, so this request did not come from the
   * screen a coordinator is looking at — a second tab opened before the read-back arrived, or
   * something that is not the screen at all. Either way the run already has a plan somebody
   * made, and replacing it with nothing is the one overwrite nobody asked for (Veri's S1).
   * Checked before the solver is asked, because there is nothing in an empty plan to ask about.
   */
  if (
    placedCount(parsed.data.assignment) === 0 &&
    getSavedPlan(day.scenario, day.direction) !== null
  ) {
    return Response.json(
      { ok: false, error: planRoutes.saveNothingPlaced },
      { status: 409, headers: noStore },
    );
  }

  const input = planInputOf(day);
  const checked = checkPlan(input, parsed.data.assignment);
  if (!checked.ok) {
    return Response.json(
      { ok: false, error: saveRefusalLine(input, checked) },
      // Read, understood, and refused by the solver: not a malformed request, and not a missing
      // thing. 404 stays the answer for an id this run does not have.
      { status: checked.reason === "NOT_THIS_RUN" ? 404 : 422, headers: noStore },
    );
  }

  const saved = putSavedPlan({
    scenario: day.scenario,
    direction: day.direction,
    // The lanes and the measurements exactly as this request described them and the day
    // accepted them, because the plan is only a plan of the day it was made against: a screen
    // handed the assignment alone would redraw it against the morning's defaults.
    stages: parsed.data.stages,
    measured: parsed.data.measured,
    assignment: checked.assignment,
    savedAt: new Date().toISOString(),
  });
  return Response.json(
    {
      ok: true,
      placed: placedCount(saved.assignment),
      riders: input.riders.length,
      // When it was kept, so the screen can say it rather than date the save by its own clock:
      // the server is the one that knows, and a browser's clock is nobody's record.
      savedAt: saved.savedAt,
    },
    { status: 200, headers: noStore },
  );
}

/** The plan last saved for a run, or `null`. Nothing about who saved it: nobody is stored. */
export async function GET(req: Request) {
  const guard = await requireApiSession(API.planSave);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const parsed = run.safeParse({
    scenario: url.searchParams.get("scenario"),
    direction: url.searchParams.get("direction"),
  });
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }

  const saved = getSavedPlan(parsed.data.scenario, parsed.data.direction);
  return Response.json({ ok: true, saved }, { status: 200, headers: noStore });
}
