/**
 * The demo day's late drop-off, as a projection (PRD §18.2 step 7, AT-03).
 *
 * Step 7 is "live drive + replayed stall → one damped 10-min window SMS to downstream families
 * only", and the board already replays the *morning* (src/domain/board: twelve minutes into the
 * runs, one van standing in the stall). This is the afternoon half of the same day, which is where
 * a late **drop-off** lives: a run that leaves the centre loaded, loses time on the road, and owes
 * the families still ahead of it a new window.
 *
 * Pure and deterministic, like everything else the demo screens read: the geometry is the
 * committed ADR-007 survey of the scenario's own run (src/fixtures/run-routes.ts), the lateness is
 * an injected stall, the decisions are the §8 notify gate's, and the words are the outbox's own
 * template. No clock, no database, no network and no sending — so the same facts reach
 *
 *  - the parent phone panel, which renders the text a family was sent, on any deployment,
 *    including one with no database at all;
 *  - `/api/cron/sweep`, which queues that same text through the outbox against the seeded rows
 *    (`sweepEtaNotices`), so the thread the panel shows is the thread the message log holds.
 *
 * Both read `demoLateDropoffs` / `dueEtaNotices` below, so the panel cannot show a text the sweep
 * would not have sent, and the sweep cannot send one the panel does not show.
 *
 * ## Which run, and why its afternoon
 *
 * R2 — the centre's own van V2, carrying Noah O., Liam D. and Theo V. Its afternoon sets down in
 * the reverse of the morning's pickup order, so Noah's stop (Okeeheelee Park) is the **last** drop
 * of the run and is downstream of anything that goes wrong on it. That is what makes it the run
 * worth replaying: the family furthest from the centre is the one a lost eleven minutes actually
 * reaches, and the family already set down — Theo V., home before the stall — is the one AT-03
 * says must not be texted at all.
 */
import { demoDay, type ServiceDay } from "@/domain/board/day";
import { measuredRunRoute, plannedStops } from "@/domain/board/scenario";
import { runReplay, type ReplayResult, type ReplaySpec } from "@/domain/eta/replay";
import type { NotificationDecision, NotifyThresholds } from "@/domain/eta/notify-gate";
import type { SimFault } from "@/domain/location/simulator";
import { runRoute } from "@/fixtures/run-routes";
import {
  childByKey,
  familyByKey,
  PROVIDERS,
  RUNS,
  stopByKey,
  VEHICLES,
  type Child,
} from "@/modules/demo/fixtures/standard";
import {
  etaNoticeTemplate,
  etaNoticeThresholds,
  etaNoticeVars,
  lateMinutesFor,
  type DueEtaNotice,
} from "@/modules/messaging/eta-notice";
import { renderTemplate } from "@/modules/messaging/templates";
import { providerDisplayName } from "@/ui/copy";

/** The run whose afternoon is replayed, and the direction. Noah's run; see the file header. */
export const LATE_RUN_KEY = "R2";
export const LATE_DIRECTION = "PM" as const;

/** Same seed ⇒ same run (AT-03 "deterministic replay"). */
export const LATE_RUN_SEED = 23;

/**
 * The injected fault: eleven minutes standing still, twenty minutes into the run — **after the
 * first family has been set down**.
 *
 * Both numbers are measured against the gate rather than chosen for roundness, because what makes
 * this the AT-03 case is where the stall sits relative to the stops:
 *  - stalling *before* the first drop leaves nobody served, so "downstream families only" has
 *    nothing to demonstrate — every family on the run is downstream of it;
 *  - stalling at twenty minutes puts Theo V.'s stop behind the van (served at 3:50 PM, its own
 *    planned window) and leaves Liam D.'s and Noah O.'s ahead of it, so the two families still to
 *    be reached are told once each and the family already at home is not texted at all;
 *  - stalling *later* than that brings Liam's stop inside ASM-14's ten-minute lead, where the gate
 *    suppresses "too-close" and only the last family is told — true to the rule, but it stops
 *    showing the rule.
 * Eleven minutes is then the shortest stall that clears ASM-14's ten-minute shift while the van
 * still arrives inside the window each family was given (`late-dropoff.test.ts` holds both ends).
 */
export const LATE_RUN_FAULT: SimFault = { kind: "stall", atSimSeconds: 1200, durationSec: 660 };

/**
 * The replay spec for one service day. A function and not a constant because the instant depends
 * on the day: the run leaves the centre early enough to make its first drop at the window that
 * family holds (`plannedStops`), which is the plan's own promise and not a number written here.
 */
export function lateDropoffSpec(
  day: ServiceDay,
  thresholds: NotifyThresholds = etaNoticeThresholds(),
): ReplaySpec {
  const run = runOf(LATE_RUN_KEY);
  const planned = plannedStops(run, LATE_DIRECTION, day);
  const departure = planned[0]?.etaMs;
  if (departure === undefined) throw new Error(`${LATE_RUN_KEY} ${LATE_DIRECTION}: no planned departure`);
  return {
    route: runRoute(LATE_RUN_KEY, LATE_DIRECTION),
    startAtMs: departure,
    seed: LATE_RUN_SEED,
    faults: [LATE_RUN_FAULT],
    // The §8 table's thresholds, handed in rather than read here (the replay stays pure).
    thresholds,
  };
}

const replayCache = new Map<string, ReplayResult>();

/**
 * The afternoon, replayed. Once per day per threshold per process: the engine is pure and
 * deterministic, so asking twice is waste — and the threshold is in the key because it is what the
 * gate's answers depend on (a deployment that raises it gets a different, equally cached run).
 */
export function lateDropoffReplay(
  day: ServiceDay = demoDay(),
  thresholds: NotifyThresholds = etaNoticeThresholds(),
): ReplayResult {
  const spec = lateDropoffSpec(day, thresholds);
  const key = `${day.iso}/${LATE_RUN_KEY}/${LATE_DIRECTION}/${spec.thresholds?.shiftSeconds ?? "default"}`;
  const cached = replayCache.get(key);
  if (cached) return cached;
  const result = runReplay(spec);
  replayCache.set(key, result);
  return result;
}

/**
 * One text a family was sent about one late drop-off — the thread's own unit.
 *
 * Two kinds of fact, and the panel reads them differently. The **people** are staff-facing: the
 * child and the adult are named, first name plus last initial (D-3), because that is what a
 * coordinator reading a thread is checking. The **body** is the family's: it is rendered from the
 * outbox's template through the one renderer, so what the panel shows is the text that goes out —
 * which says "your child", never a name (Veri #12).
 */
export type LateDropoff = {
  /** Fixture child key, for the panel's links and the sweep's leg lookup. */
  readonly childKey: string;
  /** "Noah O." — the label every staff screen uses. */
  readonly childLabel: string;
  /** "Noah" — enough for a thread heading, where the surname would be noise. */
  readonly childFirstName: string;
  /** "Dara O." and "parent": the adult on this phone, named and described. */
  readonly guardianName: string;
  readonly guardianFirstName: string;
  readonly relationship: string;
  /** The family's sim persona number (MOCKS §3), which is how the panel addresses the thread. */
  readonly phone: string;
  /** The public landmark this child is set down at (MOCKS §1), never a home. */
  readonly stopPlace: string;
  /** The van and the provider that runs it, by name. */
  readonly vanLabel: string;
  readonly providerName: string;
  /** When the text went out, epoch ms on the scenario clock. */
  readonly atMs: number;
  /** The 10-minute window the family now holds, e.g. "4:30–4:40 PM". */
  readonly windowText: string;
  /** How late the van is, in the 5-minute steps the body says it in. */
  readonly delayMinutes: number;
  /** The allow-listed template and the rendered body — the text itself. */
  readonly templateId: string;
  readonly body: string;
};

/**
 * Every text the afternoon's stall sends, in the order they went out.
 *
 * `notifications` is the gate's own list of decisions that opened — so "downstream families only",
 * the hysteresis and the one-per-stop rule are all the gate's answers and not this module's. A
 * decision about the centre, or about a stop the van has already served, never appears in it.
 */
export function demoLateDropoffs(
  day: ServiceDay = demoDay(),
  thresholds: NotifyThresholds = etaNoticeThresholds(),
): readonly LateDropoff[] {
  const run = runOf(LATE_RUN_KEY);
  const vehicle = VEHICLES.find((v) => v.key === run.vehicleKey);
  const provider = PROVIDERS.find((p) => p.key === vehicle?.providerKey);
  const replay = lateDropoffReplay(day, thresholds);

  return replay.notifications.flatMap((decision): LateDropoff[] => {
    const child = riderAt(decision.stopId);
    if (!child || !vehicle || !provider) return [];
    const { guardian } = familyByKey(child.familyKey);
    const vars = etaNoticeVars(decision, {
      // Only `stopToken` and `direction` decide the words; the row ids belong to the send path.
      siteId: "", legId: "", childToken: "", planVersion: 0,
      direction: LATE_DIRECTION,
      stopToken: stopByKey(decision.stopId).smsToken,
    });
    const templateId = etaNoticeTemplate(LATE_DIRECTION);
    return [{
      childKey: child.key,
      childLabel: child.label,
      childFirstName: child.firstName,
      guardianName: `${guardian.firstName} ${guardian.lastInitial}.`,
      guardianFirstName: guardian.firstName,
      relationship: guardian.relationship,
      phone: guardian.phone,
      stopPlace: stopByKey(decision.stopId).label,
      vanLabel: vehicle.label,
      providerName: providerDisplayName(provider.name),
      atMs: decision.atMs,
      windowText: decision.windowText ?? "",
      delayMinutes: lateMinutesFor(decision.shiftSeconds),
      templateId,
      /*
       * The words a staff screen shows: no STOP/HELP footer and no `[DEMO]` tag, which are the
       * send pipeline's and belong on a family's phone (Firia, 2026-10-17 10:51 PM ET). The
       * child is named from their own row, as the sent text names them.
       */
      body: renderTemplate(templateId, vars, { child: child.label }),
    }];
  });
}

/**
 * The same crossings in the shape the sweep queues from (`sweepEtaNotices`). One list, two
 * readers: the panel renders these decisions and the sweep sends them, so a text on screen and a
 * row in the message log are the same event rather than two things that have to be kept in step.
 */
export function dueEtaNotices(
  day: ServiceDay = demoDay(),
  thresholds: NotifyThresholds = etaNoticeThresholds(),
): readonly DueEtaNotice[] {
  const replay = lateDropoffReplay(day, thresholds);
  return replay.notifications.flatMap((decision): DueEtaNotice[] => {
    const child = riderAt(decision.stopId);
    if (!child) return [];
    return [{
      decision,
      childKey: child.key,
      direction: LATE_DIRECTION,
      stopToken: stopByKey(decision.stopId).smsToken,
    }];
  });
}

/** The one text this demo is built around: the last drop of the run, or none if the gate stayed shut. */
export function demoLateDropoffFor(
  childKey: string,
  day: ServiceDay = demoDay(),
  thresholds: NotifyThresholds = etaNoticeThresholds(),
): LateDropoff | undefined {
  return demoLateDropoffs(day, thresholds).find((d) => d.childKey === childKey);
}

/* ───────────────────────────── the run, as the scenario writes it ───────────────────────────── */

function runOf(key: string) {
  const run = RUNS.find((r) => r.key === key);
  if (!run) throw new Error(`unknown run ${key}`);
  return run;
}

/** The child this run sets down at a stop of its committed route. */
function riderAt(stopId: string): Child | undefined {
  return runOf(LATE_RUN_KEY).childKeys.map(childByKey).find((c) => c.stopKey === stopId);
}

/** Measured once, so a caller that wants the geometry does not re-measure it. */
export function lateRunRoute() {
  return measuredRunRoute(runOf(LATE_RUN_KEY), LATE_DIRECTION);
}
