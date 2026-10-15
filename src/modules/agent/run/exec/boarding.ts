/**
 * §11.2 `report_boarding(leg, source)` — "guardian reply or stationary tap → BOARDED_REPORTED
 * only", and PRD §4.4 l.266: "BOARDED_REPORTED (guardian reply or stationary driver tap) ≠
 * BOARDED_VERIFIED (center staff / center-employed escort). Provider drivers report, never verify."
 *
 * The whole tool is that distinction, and it is held in three places at once, so no single mistake
 * can turn a report into a verification:
 *
 *  - **the schema**: `tools.ts` types the state argument as the literal `BOARDED_REPORTED`, so a
 *    call claiming the verified state cannot even be expressed;
 *  - **the policy engine**: `BOARDED_VERIFIED` anywhere in the arguments is blocked
 *    (`mark_boarded_verified`), prose included;
 *  - **the machine**: `machines.ts` LEG gives `ARRIVED_PICKUP → BOARDED_REPORTED` to `G` and `P`
 *    only, and `BOARDED_REPORTED → BOARDED_VERIFIED` to `S` alone. This executor passes `G` or `P`
 *    and therefore *cannot* reach the staff edge.
 *
 * The two sources are different evidence, and each is checked rather than taken at face value:
 *
 *  - `GUARDIAN_REPLY` — the same bar a cancel has to clear: this run's committed `resolve_sender`
 *    must have resolved the sender to exactly **one** authorized child, and that child must be this
 *    leg's (`exec/cancel.guardianRefusal`). A shared number with two siblings on it reports nothing.
 *    The actor is `G`: the guardian said it, the agent wrote it down.
 *  - `STATIONARY_TAP` — "stationary **driver** tap" (PRD l.266; §19 "stationary-only, REPORTED-only
 *    taps"), so the tap is the provider's and the actor is `P`. "Stationary" is a fact about the
 *    vehicle, not a claim in the argument: the newest **bound** telemetry point for the vehicle on
 *    this leg's manifest has to be no older than the GPS stale band (`GPS_STALE_SECONDS`) and
 *    slower than the ASM-18 geofence speed (`GEOFENCE_MAX_SPEED_MPS`). A vehicle that is moving, or
 *    one we have no fresh position for, is refused by name — the same two constants the geofence
 *    uses, so "stationary" means one thing in this system.
 *
 * Nothing here writes a row of its own: the transition is version-guarded, so a re-driven call
 * finds the leg already BOARDED_REPORTED and answers with the state it left.
 */
import type { Exec } from "@/db/exec";
import { LEG } from "@/domain/machines";
import { GEOFENCE_MAX_SPEED_MPS } from "@/domain/location/geofence";
import { GPS_STALE_SECONDS } from "@/domain/location/freshness";
import { IllegalTransition, StaleOrConflict, transition } from "@/domain/transition";
import type { ToolExecution, ToolExecutor } from "../executors";
import { guardianRefusal } from "./cancel";
import { type ExecutorDeps, actor, failed, legRow, notFound, versionConflict } from "./effects";

/** §6.3: the only state a boarding may be reported from. */
export const BOARDING_FROM_STATE = "ARRIVED_PICKUP";
/** §11.2: "BOARDED_REPORTED only". */
export const BOARDING_STATE = "BOARDED_REPORTED";

type LegState = (typeof LEG)["states"][number];

export function reportBoardingExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const legId = String(call.args.leg_id ?? "");
    const source = String(call.args.source ?? "");
    const expectedVersion = Number(call.args.expected_version);
    const by = actor(call.runId);

    const leg = await legRow(deps.db, { siteId: call.siteId, legId });
    if (!leg) return notFound("trip_leg");
    // Already reported: a re-driven step, a second tap, or the driver and the guardian both said so.
    if (leg.state === BOARDING_STATE) {
      return boarded({ leg: { id: leg.id, childToken: leg.child_token, version: leg.version }, source, idempotent: true });
    }
    if (leg.state !== BOARDING_FROM_STATE) {
      // The machine would refuse it anyway; naming the state is what makes the refusal readable.
      return failed("LEG_NOT_AT_PICKUP", { leg_state: leg.state });
    }

    // Who may say a child is on board, and on what evidence.
    const witness = source === "GUARDIAN_REPLY"
      ? guardianWitness(call.committed, leg.child_token)
      : await tapWitness(deps.db, { siteId: call.siteId, legId: leg.id, now: call.now });
    if ("error" in witness) return witness.error;

    try {
      const moved = await transition(deps.db, LEG, "ops.trip_leg", {
        id: leg.id,
        // The model's `expected_version`, not the one just read: a staff edit in between has to be
        // visible (AT-08), and a version the model never saw would make the argument decorative.
        version: expectedVersion,
        from: BOARDING_FROM_STATE as LegState,
        to: BOARDING_STATE as LegState,
        actor: witness.actor,
        by,
      });
      return boarded({
        leg: { id: leg.id, childToken: leg.child_token, version: moved.version },
        source,
        witnessActor: witness.actor,
        evidence: witness.evidence,
      });
    } catch (e) {
      if (e instanceof StaleOrConflict) return versionConflict({ expected_version: expectedVersion });
      if (e instanceof IllegalTransition) return failed("ILLEGAL_TRANSITION", { reason: e.message.slice(0, 200) });
      throw e;
    }
  };
}

/* ───────────────────────────── the two witnesses ───────────────────────────── */

type Witness =
  | { readonly actor: "G" | "P"; readonly evidence: Record<string, unknown> }
  | { readonly error: ToolExecution };

/** A guardian's reply, on the same terms a cancel is allowed on (`exec/cancel.guardianRefusal`). */
function guardianWitness(committed: Parameters<ToolExecutor>[0]["committed"], childToken: string): Witness {
  const refusal = guardianRefusal(committed, childToken);
  return refusal ? { error: refusal } : { actor: "G", evidence: { source: "GUARDIAN_REPLY" } };
}

/**
 * A driver's tap, which is only evidence while the vehicle is standing still. The position comes
 * from the vehicle on this leg's manifest; a leg with no manifest has no vehicle to have tapped.
 */
async function tapWitness(
  db: Exec,
  a: { siteId: string; legId: string; now: Date },
): Promise<Witness> {
  const vehicle = await db.query<{ vehicle_id: string | null }>(
    `SELECT m.vehicle_id FROM ops.trip_leg l JOIN ops.manifest m ON m.id = l.manifest_id
     WHERE l.id = $1 AND l.site_id = $2`,
    [a.legId, a.siteId],
  );
  const vehicleId = vehicle.rows[0]?.vehicle_id ?? null;
  if (!vehicleId) return { error: failed("NO_VEHICLE_ON_LEG") };

  const point = await db.query<{ speed_mps: number | null; age_seconds: number }>(
    `SELECT speed_mps, extract(epoch FROM ($3::timestamptz - recorded_at)) AS age_seconds
     FROM ops.telemetry_point
     WHERE site_id = $1 AND vehicle_id = $2 AND bound = true AND recorded_at <= $3::timestamptz
     ORDER BY recorded_at DESC LIMIT 1`,
    [a.siteId, vehicleId, a.now.toISOString()],
  );
  const row = point.rows[0];
  if (!row || Number(row.age_seconds) > GPS_STALE_SECONDS) {
    return {
      error: failed("NO_LOCATION_EVIDENCE", {
        vehicle_token: vehicleId,
        stale_after_seconds: GPS_STALE_SECONDS,
        ...(row ? { age_seconds: Math.round(Number(row.age_seconds)) } : {}),
      }),
    };
  }
  const speed = row.speed_mps === null ? null : Number(row.speed_mps);
  if (speed === null || speed >= GEOFENCE_MAX_SPEED_MPS) {
    return {
      error: failed("VEHICLE_NOT_STATIONARY", {
        vehicle_token: vehicleId,
        max_speed_mps: GEOFENCE_MAX_SPEED_MPS,
        ...(speed === null ? {} : { speed_mps: speed }),
      }),
    };
  }
  return {
    actor: "P",
    evidence: {
      source: "STATIONARY_TAP",
      vehicle_token: vehicleId,
      speed_mps: speed,
      age_seconds: Math.round(Number(row.age_seconds)),
    },
  };
}

/** What the tool reports: the state it set, and never the one above it. */
function boarded(a: {
  leg: { id: string; childToken: string; version: number };
  source: string;
  witnessActor?: "G" | "P";
  evidence?: Record<string, unknown>;
  idempotent?: boolean;
}): ToolExecution {
  return {
    status: "executed",
    data: {
      leg_id: a.leg.id,
      leg_state: BOARDING_STATE,
      leg_version: a.leg.version,
      child_token: a.leg.childToken,
      source: a.source,
      ...(a.witnessActor ? { reported_by_actor: a.witnessActor } : {}),
      ...(a.evidence ? { evidence: a.evidence } : {}),
      ...(a.idempotent ? { idempotent: true } : {}),
    },
    promptFacts: {
      leg_id: a.leg.id,
      leg_state: BOARDING_STATE,
      leg_version: a.leg.version,
      source: a.source,
      ...(a.idempotent ? { idempotent: true } : {}),
    },
  };
}
