/**
 * What the board's four endpoints actually do, with the HTTP left in the routes.
 *
 * The routes are the guard and the shape of the answer; this is the decision. Keeping it here
 * means the decisions are unit-testable without a request (src/modules/plan/api.test.ts) and that
 * the two writes — a plan and a van's setup — run the same checks whoever asks for them.
 *
 * The one rule that matters most: **the plan is re-checked on the server**. The board asks the fit
 * rule before every drop, and a request did not come from the board, so the posted plan is
 * replayed van by van through the same `src/domain/plan/fit.ts` the browser used (#58 established
 * this for `tryMove`; §1.4 asks for it in as many words). A move the screen refused cannot be
 * saved by posting round it.
 */
import { z } from "zod";
import { NO_NEEDS, type NeedFlags } from "@/config/equipment";
import { demoReset } from "@/ui/copy";
import { COUNTER_MAX } from "@/config/vans";
import { getNeonDb, type Db, type Exec } from "@/db/exec";
import { autoPlan, BUCKETS, checkPlan, namesOnlyThisDay, ridersInVan, type BoardPlan, type Placement } from "@/domain/plan/board";
import { isReadOnlyDbEnv } from "@/db/read-only";
import { setChildNeeds } from "@/modules/roster/needs-write";
import { setDemoNeedsOverride } from "@/modules/demo/needs-store";
import { setChildPlacement, writePlan, type SetChildPlacementOutcome } from "./place";
import { sqlDaySource } from "@/modules/roster/sql";
import { sqlPlanStore } from "./sql";
import { isOver } from "@/domain/plan/fit";
import { CONFIRMED_STATE } from "@/domain/plan/setup";
import type { DayReadiness } from "@/domain/day/readiness";
import type { Direction } from "@/domain/solver";
import type { StaffCaller } from "@/auth/api-guard";
import { DEMO_SITE_ID } from "@/modules/demo/fixtures/standard";
import type { DayDataSource } from "@/domain/day/source";
import { dayDataSource, loadBoard, placementsToSave, planStore, type BoardView, type PlanStore } from "./store";

/* ───────────────────────────── which site ───────────────────────────── */

/**
 * The site this caller's board belongs to: their own membership, or the demo site when the
 * session has no membership at all.
 *
 * The demo is one centre (PRD §18.1), and the board is not a multi-site surface yet: a caller who
 * is a member of several sites gets the first, which is the same resolution the demo reset uses
 * when a request does not name one. The membership-less case is the browser check's synthetic
 * session (src/auth/caller.ts), which has a role and no identity.
 */
export function siteOf(caller: { memberships?: readonly { siteId: string }[] }): string {
  return caller.memberships?.[0]?.siteId ?? DEMO_SITE_ID;
}

/* ───────────────────────────── reading the board ───────────────────────────── */

export type BoardBody = BoardView;

/** The board for one date and leg, as every reader of it gets it. */
export async function boardResponse(
  siteId: string,
  date: string,
  direction: Direction,
  store: PlanStore = planStore(),
): Promise<BoardBody> {
  return loadBoard(store, siteId, date, direction);
}

/** The three steps of the day (§9.4). */
export async function readinessResponse(
  siteId: string,
  date: string,
  leg: Direction,
  store: PlanStore = planStore(),
): Promise<DayReadiness> {
  return (await loadBoard(store, siteId, date, leg)).readiness;
}

/* ───────────────────────────── saving the board ───────────────────────────── */

const placement = z.strictObject({
  bucket: z.enum(BUCKETS),
  vanId: z.string().min(1).max(64).nullable(),
  pinned: z.boolean(),
});

export const savePlanBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["AM", "PM"]),
  /** The version the board was showing; 0 when it started from no saved plan. */
  version: z.number().int().min(0).max(1_000_000),
  placements: z.record(z.string().min(1).max(64), placement),
});

export type SavePlanAnswer =
  | { status: 200; body: { ok: true; version: number; savedAt: string } }
  | { status: 404 | 409 | 422 | 503; body: { ok: false; error?: string; reason?: string; changedBy?: string | null; childToken?: string; vanId?: string } };

/**
 * The board's Save (§1.6's `POST /api/plan/save`) — which is Auto-plan's answer being accepted,
 * and nothing else.
 *
 * It is the **same writer** every drag uses (`writePlan`, src/modules/plan/place.ts), so it has
 * the same refusals and no others: the fit rule always decides (there is no `allowOver` any
 * more — a van can never be saved over its counts), and a whole-board save may not move anybody
 * into or out of Absent or Family drives, because those are one-child moves through
 * `setChildPlacement` (Veri F1, 2026-10-17).
 */
export async function savePlanRequest(
  siteId: string,
  caller: Pick<StaffCaller, "userId">,
  input: z.infer<typeof savePlanBody>,
  now: Date = new Date(),
  store: PlanStore = planStore(),
  source: DayDataSource = dayDataSource(siteId),
): Promise<SavePlanAnswer> {
  const written = await writePlan(
    {
      siteId,
      serviceDate: input.date,
      direction: input.direction,
      expectedVersion: input.version,
      actor: caller.userId ?? null,
      now,
      change: () => input.placements as BoardPlan,
    },
    store,
    source,
  );
  if (written.ok) {
    return { status: 200, body: { ok: true, version: written.version, savedAt: written.savedAt } };
  }
  if (written.status === 422) {
    return {
      status: 422,
      body: {
        ok: false,
        reason: written.reason,
        childToken: written.childToken,
        ...("vanId" in written ? { vanId: written.vanId } : {}),
      },
    };
  }
  if (written.status === 409 && written.reason === "CHANGED") {
    return { status: 409, body: { ok: false, reason: written.reason, changedBy: written.changedBy } };
  }
  return { status: written.status, body: { ok: false, reason: written.reason } };
}

/* ───────────────────────────── one van's setup ───────────────────────────── */

/**
 * The three values migration 0009's check constraint allows, which is what this endpoint will
 * *parse*. Only one of them is a write it will *accept* — see `putVanSetupRequest`.
 *
 * `PLANNED` is parsed rather than rejected by the schema on purpose: a caller who asks for it
 * gets the honest 403 that says nothing writes planned counts any more, instead of a generic
 * "that request couldn't be read" that would leave them guessing which field was wrong.
 */
const WRITABLE_STATES = ["DEFAULT", "PLANNED", "CHECKED"] as const;

export const vanSetupBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seats: z.number().int().min(0).max(COUNTER_MAX),
  wheelchairSpots: z.number().int().min(0).max(COUNTER_MAX),
  carSeats: z.number().int().min(0).max(COUNTER_MAX),
  oxygenMounts: z.number().int().min(0).max(COUNTER_MAX),
  hasLift: z.boolean(),
  state: z.enum(WRITABLE_STATES),
});

export type VanSetupAnswer =
  | { status: 200; body: { ok: true; readiness: DayReadiness } }
  | { status: 403 | 404; body: { ok: false; reason: string } };

/**
 * One van's setup for one day (§1.6's `PUT /api/vans/:id/setup`, a POST here).
 *
 * Two checks beyond the role the access table already took:
 *
 *  - **`CHECKED` is the only state anything can write** (Firia's rule 1, 2026-10-17 5:48 PM ET).
 *    `PLANNED` stays in migration 0009's frozen check constraint and nothing produces it: the
 *    board has no planned counts, there is no popover to apply them from, and a request asking
 *    for one is refused here whoever sends it — so the state cannot arrive by posting round the
 *    screen either. `DEFAULT` is nobody's to write at all: it is what the *absence* of a row
 *    means (src/domain/plan/setup.ts), not a state a person sets.
 *  - the van has to be one this board runs, answered as a uniform 404 like every other id this
 *    app does not have.
 *
 * All three roles may confirm: counting what arrived is the front desk's own job (§2).
 */
export async function putVanSetupRequest(
  siteId: string,
  caller: Pick<StaffCaller, "userId" | "role">,
  vanId: string,
  input: z.infer<typeof vanSetupBody>,
  now: Date = new Date(),
  store: PlanStore = planStore(),
): Promise<VanSetupAnswer> {
  if (input.state !== CONFIRMED_STATE) {
    return { status: 403, body: { ok: false, reason: "NOT_A_STATE" } };
  }

  const view = await loadBoard(store, siteId, input.date, "PM");
  if (!view.day.vans.some((van) => van.id === vanId)) {
    return { status: 404, body: { ok: false, reason: "NO_SUCH_VAN" } };
  }

  await store.putSetup(siteId, {
    vehicleId: vanId,
    date: input.date,
    setup: {
      seats: input.seats,
      wheelchairSpots: input.wheelchairSpots,
      carSeats: input.carSeats,
      oxygenMounts: input.oxygenMounts,
      hasLift: input.hasLift,
    },
    state: CONFIRMED_STATE,
    setBy: caller.userId ?? null,
    now,
  });

  // The answer carries the day's steps back, so the screen that just confirmed a van can say
  // "1/3 checked" without asking a second endpoint for it (§9.4).
  const after = await loadBoard(store, siteId, input.date, view.day.direction);
  return { status: 200, body: { ok: true, readiness: after.readiness } };
}

/** Every placement a caller may post, for the one type the board and the endpoint share. */
export type PostedPlacement = Placement;

/* ───────────────────────── one child's place, and one child's needs ───────────────────────── */

/**
 * A preview shares the one Neon database with production and every transaction on it is
 * `BEGIN READ ONLY` (src/db/read-only.ts, DECISION-LEDGER #43). A write there cannot land, so it
 * is **refused in words** rather than attempted and reported as a 503: the same 403 and the same
 * sentence the demo reset gives (`demoReset.previewRefusal`, read from copy.ts rather than from
 * the reset module, which may not be imported outside its two entry points).
 */
export function previewRefusal(
  env: Record<string, string | undefined> = process.env,
): { status: 403; body: { ok: false; reason: string } } | null {
  return isReadOnlyDbEnv(env)
    ? { status: 403, body: { ok: false, reason: demoReset.previewRefusal } }
    : null;
}

export const placeChildBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["AM", "PM"]),
  childToken: z.string().min(1).max(64),
  bucket: z.enum(BUCKETS),
  vanId: z.string().min(1).max(64).nullable().optional(),
  version: z.number().int().min(0).max(1_000_000),
  /** Away for the whole day: the same move on both legs (founder 7:17 PM ET). */
  allDay: z.boolean().optional(),
  /** The version the caller holds for the *other* leg, when `allDay` is set. */
  otherVersion: z.number().int().min(0).max(1_000_000).optional(),
});

export type PlaceChildAnswer =
  | { status: 200; body: { ok: true; version: number; savedAt: string; view: BoardBody; alsoAM?: boolean } }
  | {
      status: 403 | 404 | 409 | 422;
      body: { ok: false; reason: string; changedBy?: string | null; childToken?: string; vanId?: string };
    };

/**
 * One drag, one drop on Absent or Family drives, one `Move to…` — all of them land here, and
 * all of them go through the one placement writer (src/modules/plan/place.ts).
 *
 * Every move is a **new plan version**, which is what makes "it survives a reload" true and what
 * turns two coordinators dragging at once into a 409 rather than a silent overwrite.
 */
export async function placeChildRequest(
  siteId: string,
  caller: Pick<StaffCaller, "userId">,
  input: z.infer<typeof placeChildBody>,
  now: Date = new Date(),
  store: PlanStore = planStore(),
  env: Record<string, string | undefined> = process.env,
): Promise<PlaceChildAnswer> {
  const refused = previewRefusal(env);
  if (refused) return refused;

  const outcome = await setChildPlacement(
    {
      siteId,
      serviceDate: input.date,
      direction: input.direction,
      childToken: input.childToken,
      bucket: input.bucket,
      vehicleId: input.vanId ?? null,
      expectedVersion: input.version,
      actor: caller.userId ?? null,
      now,
    },
    store,
  );
  if (!outcome.ok) return refusal(outcome);

  // "Absent all day" is the same move on the other leg, with the version the caller holds for
  // it. A conflict there is reported as a conflict; the leg that did save stays saved.
  let alsoAM: boolean | undefined;
  if (input.allDay && input.bucket === "ABSENT") {
    const other = await setChildPlacement(
      {
        siteId,
        serviceDate: input.date,
        direction: input.direction === "AM" ? "PM" : "AM",
        childToken: input.childToken,
        bucket: "ABSENT",
        expectedVersion: input.otherVersion ?? 0,
        actor: caller.userId ?? null,
        now,
      },
      store,
    );
    alsoAM = other.ok;
  }

  return {
    status: 200,
    body: {
      ok: true,
      version: outcome.version,
      savedAt: outcome.savedAt,
      view: outcome.view,
      ...(alsoAM === undefined ? {} : { alsoAM }),
    },
  };
}

function refusal(outcome: Exclude<SetChildPlacementOutcome, { ok: true }>): PlaceChildAnswer {
  if (outcome.status === 422) {
    return {
      status: 422,
      body: {
        ok: false,
        reason: outcome.reason,
        childToken: outcome.childToken,
        ...("vanId" in outcome ? { vanId: outcome.vanId } : {}),
      },
    };
  }
  if (outcome.status === 409 && outcome.reason === "CHANGED") {
    return { status: 409, body: { ok: false, reason: outcome.reason, changedBy: outcome.changedBy } };
  }
  return { status: outcome.status, body: { ok: false, reason: outcome.reason } };
}

export const childNeedsBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["AM", "PM"]),
  wheelchair: z.boolean(),
  carSeat: z.boolean(),
  oxygen: z.boolean(),
  /** The version the board was showing, so the re-plan it triggers is not a silent overwrite. */
  version: z.number().int().min(0).max(1_000_000),
});

export type ChildNeedsAnswer =
  | { status: 200; body: { ok: true; needs: NeedFlags; version: number; savedAt: string; view: BoardBody } }
  | { status: 403 | 404 | 409 | 503; body: { ok: false; reason: string; changedBy?: string | null } };

/**
 * The child panel's Save (founder 7:17 PM ET): three Yes/No answers, written to the child's
 * approved profile, and then **the plan re-run on the new needs**.
 *
 * The re-plan is the half that makes the Save mean anything: a child who now needs a car seat
 * has to end up on a van that has one, and a van that has just lost a rider has to show it. It
 * is the same single placement function the board drags against (`autoPlan` over
 * `src/domain/plan/fit.ts`), so the answer a coordinator gets here is the answer they would have
 * got by dragging — children a person pinned stay where they were put, and anybody who no longer
 * fits their pin comes out of it with a shortfall rather than quietly over-filling the van.
 */
/** Thrown to roll a needs transaction back; carries the refusal the caller should see. */
class NeedsSaveRefused extends Error {
  constructor(public readonly outcome: Awaited<ReturnType<typeof writePlan>> | null) {
    super("needs save refused");
    this.name = "NeedsSaveRefused";
  }
}

/**
 * The same database, seen as a `Db`, inside a transaction that is already open.
 *
 * `sqlPlanStore` and `sqlDaySource` take a `Db`; inside `db.tx` what exists is an `Exec`. A
 * nested `tx` runs inline on the same connection, so everything the callback does is part of the
 * one transaction — which is the whole point: the needs and the re-plan commit together.
 */
function asDb(tx: Exec): Db {
  return {
    query: tx.query,
    async tx(fn) {
      return fn(tx, () => undefined);
    },
  };
}

export async function setChildNeedsRequest(
  siteId: string,
  caller: Pick<StaffCaller, "userId">,
  childToken: string,
  input: z.infer<typeof childNeedsBody>,
  now: Date = new Date(),
  store: PlanStore = planStore(),
  env: Record<string, string | undefined> = process.env,
  /** The database the needs are written to. Taken as an argument so a test can hand it one. */
  db: Db | null = null,
  /** The roster this board reads. Injected by the DB tests; the default is the request's own. */
  source: DayDataSource = dayDataSource(siteId),
): Promise<ChildNeedsAnswer> {
  const refused = previewRefusal(env);
  if (refused) return refused;

  const panel = { wheelchair: input.wheelchair, carSeat: input.carSeat, oxygen: input.oxygen };

  const before = await loadBoard(store, siteId, input.date, input.direction, source);
  const known =
    before.day.riders.some((rider) => rider.token === childToken) ||
    before.day.others.some((other) => other.token === childToken);
  if (!known) return { status: 404, body: { ok: false, reason: "NOT_THIS_DAY" } };

  /*
   * **One transaction, or neither change.** (Veri F3, 2026-10-17.)
   *
   * The need rows and the re-planned plan are one decision: a coordinator who is told "somebody
   * else saved first" must not find, on reload, that the child's needs changed anyway and a
   * pinned rider is now in a van that cannot carry them. So on a database both writes run inside
   * the same transaction, and a 409 from the version check rolls the item rows back with it.
   *
   * With no database at all (the browser check) there is nothing to roll back: the override is
   * one `Map.set`, and it is applied after the re-plan has been accepted for the same reason.
   */
  const runWrite = async (
    writeNeeds: () => Promise<{ ok: boolean; reason?: string }>,
    place: PlanStore,
    read: DayDataSource,
  ) => {
    const needsWritten = await writeNeeds();
    if (!needsWritten.ok) return { kind: "NO_PROFILE" as const };
    const replanned = await writePlan(
      {
        siteId,
        serviceDate: input.date,
        direction: input.direction,
        expectedVersion: input.version,
        actor: caller.userId ?? null,
        now,
        change: (view) => autoPlan(view.day, view.plan),
      },
      place,
      read,
    );
    return { kind: "WRITTEN" as const, replanned };
  };

  let written: Awaited<ReturnType<typeof writePlan>>;
  if (env.DATABASE_URL) {
    const database = db ?? getNeonDb();
    const outcome = await database.tx(async (tx) => {
      const inTx = asDb(tx);
      const result = await runWrite(
        () => setChildNeeds(inTx, { siteId, childToken, panel, actor: caller.userId ?? null, now }),
        sqlPlanStore(inTx),
        sqlDaySource(inTx, siteId),
      );
      // A refusal rolls the whole transaction back, needs included.
      if (result.kind === "NO_PROFILE" || !result.replanned.ok) {
        throw new NeedsSaveRefused(result.kind === "NO_PROFILE" ? null : result.replanned);
      }
      return result.replanned;
    }).catch((error: unknown) => {
      if (error instanceof NeedsSaveRefused) return error.outcome;
      throw error;
    });
    if (outcome === null) return { status: 404, body: { ok: false, reason: "NO_PROFILE" } };
    written = outcome;
  } else {
    // No database at all: the browser check's server (src/modules/demo/needs-store.ts).
    const result = await runWrite(
      async () => {
        setDemoNeedsOverride(childToken, panel, env);
        return { ok: true };
      },
      store,
      source,
    );
    if (result.kind === "NO_PROFILE") return { status: 404, body: { ok: false, reason: "NO_PROFILE" } };
    written = result.replanned;
  }
  if (!written.ok) {
    if (written.status === 409 && written.reason === "CHANGED") {
      return { status: 409, body: { ok: false, reason: written.reason, changedBy: written.changedBy } };
    }
    return { status: written.status === 404 ? 404 : 409, body: { ok: false, reason: written.reason } };
  }

  const rider = written.view.day.riders.find((candidate) => candidate.token === childToken);
  return {
    status: 200,
    body: {
      ok: true,
      needs: rider?.needs ?? { ...NO_NEEDS, ...panel },
      version: written.version,
      savedAt: written.savedAt,
      view: written.view,
    },
  };
}
