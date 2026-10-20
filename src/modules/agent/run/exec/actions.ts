/**
 * THE AGENT ACTS AS THE PERSON WHO ASKED (ledger #74).
 *
 * The executors behind the action tools (`agent/action-tools.ts`) and the staff read tools. An
 * action runs through the one action layer (`modules/actions/registry.ts`): the same function the
 * screen's button runs, as the staff member whose ask started this run, with that person's role
 * checked against the action's own access row and their membership read from the database now
 * (`authorize`). A run nobody asked for — a family's text, an alert — has no person to act as and
 * acts as nobody: the executor refuses by name (`NO_PERSON_TO_ACT_FOR`), and such runs are never
 * offered these tools anyway (assembler.ts).
 *
 * An action the screen would refuse — a plan that moved under it, a van that does not fit — is not a
 * broken step: it is an answer, and it goes back to the model as one (`ok=false reason=…`), so the
 * agent can say what happened or try another way. Only a refusal of the *person* (no role, not a
 * member) is a failure.
 */
import { ALL_STAFF } from "@/auth/access";
import type { Exec } from "@/db/exec";
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import { ridersInVan, shortfallsOfDay, usedInVan } from "@/domain/plan/board";
import { fits } from "@/domain/plan/fit";
import { minutesOutside, outsideSlots } from "@/domain/plan/slots";
import type { TimeSlot } from "@/domain/day/source";
import { hhmmOf, madeLate, minuteOfDay, minutesLate, plannedStopTimes } from "@/domain/plan/arrivals";
import type { Placement } from "@/domain/plan/board";
import { notifyGateConfig } from "@/config/live";
import { staffLabel } from "@/modules/plan/staff";
import { tokenizeNames } from "@/modules/identity/names";
import { activityWords, fill } from "@/ui/copy";
import { clockLabel, serviceDateIso, siteTimeLabel } from "@/ui/service-date";
import { VANS, vanNameOf } from "@/config/vans";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { pendingApprovals } from "@/modules/approvals/decide";
import { ACTIONS, authorize, runAction, type ActionCtx, type ActionName } from "@/modules/actions/registry";
import { actionDepsFor } from "@/modules/actions/deps";
import { dayDataSource, loadBoard, planStore } from "@/modules/plan/store";
import { actionTool, type ActionTool } from "../../action-tools";
import { STAFF_ALERT_TASK_CATEGORY, STAFF_ASK_TASK_CATEGORY } from "../../ask/ask-text";
import { STAFF_ACTION_TASK_CATEGORY } from "@/modules/actions/draft";
import { STAFF_ASK_CARDS_IN_CONTEXT, STAFF_ASK_TASKS_IN_CONTEXT } from "../staff-ask-context";
import { openTaskRows, pendingCardRows } from "../waiting";
import { legOf, teamPlanChange, todayOf } from "./team";
import { wrapUntrusted } from "../../policy";
import type { ToolExecutor, ToolExecutors } from "../executors";
import type { ExecutorDeps } from "./effects";
import { failed, isUuid } from "./effects";
import { askerOf } from "./asker";

export { askerOf } from "./asker";

/** A plan board read for the version a write must name (never the model's). */
const versionAt = (ctx: ActionCtx) => async (date: string, leg: "AM" | "PM") =>
  (await loadBoard(ctx.deps?.store ?? planStore(), ctx.siteId, date, leg, ctx.deps?.source ?? dayDataSource(ctx.siteId))).version;

function actionExecutor(deps: ExecutorDeps, tool: ActionTool): ToolExecutor {
  return async (call) => {
    const caller = await askerOf(deps, call);
    if (!caller) return failed("NO_PERSON_TO_ACT_FOR");
    // On the run's own connection: the same SQL board the screens read on a deployment.
    const ctx: ActionCtx = { siteId: call.siteId, caller, now: call.now, deps: actionDepsFor(deps.db, call.siteId) };
    const action = ACTIONS[tool.action as ActionName];
    try {
      await authorize(deps.db, ctx, action);
    } catch (e) {
      if (e instanceof Forbidden) return failed("NOT_YOUR_ROLE");
      if (e instanceof SiteNotFound || e instanceof Unauthenticated) return failed("NOT_A_MEMBER");
      throw e;
    }
    const answer = await runAction(tool.action as ActionName, ctx, await tool.toInput(call.args, versionAt(ctx)));
    const body = (answer.body ?? {}) as Record<string, unknown>;
    const ok = answer.status === 200 && body.ok !== false;
    return {
      status: "executed",
      data: { action: tool.action, http_status: answer.status, acted_for: `staff:${caller.userId}` },
      // What happened, as codes and counts: the model reports it to the person in its own words.
      promptFacts: {
        action: tool.action,
        ok,
        ...(ok ? {} : { reason: String(body.reason ?? body.error ?? answer.status) }),
        ...(typeof body.version === "number" ? { plan_version: body.version } : {}),
      },
    };
  };
}

/** "15:15" → "3:15 PM": times as the board and the cards write them. */
const at = (minute: number | undefined) => (minute === undefined ? "" : clockLabel(hhmmOf(Math.round(minute))));
const yes = (b: boolean) => (b ? "yes" : "no");

/**
 * THE PLAN BOARD AS THE PERSON SEES IT (ledger #74, #77): when each van leaves, its counts, its
 * riders with their ≈ times, and who does not fit — people by name, which `inTokens` turns into the
 * prompt's tokens. No ids and no version: the model has nothing to copy wrongly into a card.
 */
function getPlanExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const leg = legOf(call.args.leg);
    if (!leg) return failed("NO_SUCH_LEG");
    const board = actionDepsFor(deps.db, call.siteId);
    const view = await loadBoard(board.store!, call.siteId, todayOf(call.now), leg, board.source);
    const facts: Record<string, string | number | boolean> = { leg, saved: view.version > 0 };
    const times = plannedStopTimes(view.day, view.plan, view.departs);
    for (const van of view.day.vans) {
      const riders = ridersInVan(view.day, view.plan, van.id);
      const used = usedInVan(view.day, view.plan, van.id);
      facts[van.name] =
        `leaves ${at(view.departs[van.id])}, seats ${used.seats}/${van.setup.seats}, wheelchair ${used.wheelchairSpots}/${van.setup.wheelchairSpots}, ` +
        `car seats ${used.carSeats}/${van.setup.carSeats}, oxygen ${used.oxygenMounts}/${van.setup.oxygenMounts}, lift ${yes(van.setup.hasLift)}, ` +
        `fits ${yes(fits(van.setup, riders))}, riders: ${riders.map((r) => `${r.name} ≈${at(times.get(r.token)?.arrivesAtMinute)}`).join(", ") || "none"}`;
    }
    // Who the plan already has outside a time their family agreed (ledger #84), by name.
    const outside = [...outsideSlots(view.day, view.plan, view.departs)].filter(([, off]) => off > 0);
    if (outside.length > 0) {
      facts.outside_agreed = outside.map(([token, off]) => `${view.day.riders.find((r) => r.token === token)?.name ?? token} ${off} min`).join(", ");
    }
    for (const bucket of ["UNASSIGNED", "FAMILY_DRIVES", "ABSENT"] as const) {
      const here = view.day.riders.concat(view.day.others).filter((r) => view.plan[r.token]?.bucket === bucket);
      if (here.length > 0) facts[bucket.toLowerCase()] = here.map((r) => r.name).join(", ");
    }
    const short = shortfallsOfDay(view.day, view.plan);
    facts.does_not_fit = short.map((s) => `${view.day.riders.find((r) => r.token === s.token)?.name ?? s.token} (${s.shortfall.reason})`).join(", ") || "none";
    const preview = call.args.preview as { moves?: unknown; departures?: unknown } | undefined;
    if (preview && (Array.isArray(preview.moves) || Array.isArray(preview.departures))) Object.assign(facts, previewFacts(view, preview));
    return { status: "executed", data: { plan_version: view.version }, promptFacts: facts };
  };
}

/**
 * WHAT A CHANGE WOULD DO, BEFORE ANYBODY MAKES IT (ledger #75, #77): moves and departures applied
 * to the board in memory, then each van's fit, the moved children's new times, and who would get
 * home late by the rule the late texts are sent by (`madeLate`). Nothing is saved.
 */
function previewFacts(view: Awaited<ReturnType<typeof loadBoard>>, preview: { moves?: unknown; departures?: unknown }): Record<string, string> {
  const { change, unknownVans } = teamPlanChange(view, preview);
  const plan: Record<string, Placement> = { ...view.plan };
  for (const m of change.moves ?? []) {
    if (plan[m.token]) plan[m.token] = { ...plan[m.token], bucket: m.bucket, vanId: m.vanId };
  }
  const departs: Record<string, number> = { ...view.departs };
  for (const [vanId, hhmm] of Object.entries(change.departures ?? {})) departs[vanId] = minuteOfDay(hhmm) ?? departs[vanId];
  const times = plannedStopTimes(view.day, plan, departs);
  const name = (token: string) => view.day.riders.find((r) => r.token === token)?.name ?? token;
  const facts: Record<string, string> = {
    preview_fits: view.day.vans.map((v) => `${v.name} ${yes(fits(v.setup, ridersInVan(view.day, plan, v.id)))}`).join(", "),
    preview_times: (change.moves ?? []).map((m) => `${name(m.token)} ≈${at(times.get(m.token)?.arrivesAtMinute)}`).join(", ") || "unchanged",
    preview_home_late:
      madeLate(view.day, view.plan, plan, notifyGateConfig.shiftSeconds / 60, { before: view.departs, after: departs })
        .map((l) => `${name(l.token)} +${Math.round(l.late)} min, home ≈${at(l.arrival.arrivesAtMinute)}`)
        .join(", ") || "none",
  };
  if (unknownVans.length > 0) facts.not_running_today = unknownVans.join(", ");
  return facts;
}

/**
 * ONE CHILD'S DAY (ledger #77), both legs, as their card on the board shows it: where they are,
 * their stop and ≈ time against their family's window, and their approved needs.
 */
function getChildExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const token = String(call.args.child ?? "");
    const board = actionDepsFor(deps.db, call.siteId);
    const facts: Record<string, string> = {};
    for (const leg of ["AM", "PM"] as const) {
      const view = await loadBoard(board.store!, call.siteId, todayOf(call.now), leg, board.source);
      const rider = view.day.riders.concat(view.day.others).find((r) => r.token === token);
      if (!rider) continue;
      facts.name ??= rider.name;
      facts.needs ??= Object.entries(rider.needs).filter(([, on]) => on).map(([need]) => need).join(", ") || "none";
      const p = view.plan[token];
      const where = p?.bucket === "VAN" ? (view.day.vans.find((v) => v.id === p.vanId)?.name ?? "a van") : (p?.bucket ?? "UNASSIGNED").toLowerCase();
      const time = plannedStopTimes(view.day, view.plan, view.departs).get(token)?.arrivesAtMinute;
      const late = minutesLate(rider.window, time);
      facts[leg === "AM" ? "morning" : "afternoon"] =
        `${where}${rider.stopLabel ? `, stop ${rider.stopLabel}` : ""}${time === undefined ? "" : `, ≈${at(time)}`}` +
        `${rider.window ? `, family window ${clockLabel(rider.window)}` : ""}${late !== null && late > 0 ? `, ${Math.round(late)} min past it` : ""}` +
        // The ranges a person approved with the family (ledger #84), and how far outside one the plan is.
        slotWords(rider.slots, time);
    }
    if (!facts.name) return failed("NO_SUCH_CHILD");
    return { status: "executed", data: { child: token }, promptFacts: facts };
  };
}

/** ", agreed 16:50–17:20" (and ", 20 min outside it" when the plan misses it): the child's approved slots. */
export function slotWords(slots: readonly TimeSlot[] | undefined, time: number | undefined): string {
  if (!slots || slots.length === 0) return "";
  const ranges = slots.map((slot) => `${clockLabel(slot.start)}–${clockLabel(slot.end)}`).join(" or ");
  const off = time === undefined ? null : minutesOutside(time, slots);
  return `, agreed ${ranges}${off !== null && off > 0 ? `, ${off} min outside it` : ""}`;
}

/**
 * WHAT IS WAITING FOR A PERSON (ledger #77): the undecided cards and the open alerts, under the
 * labels the prompt gave them (`run/waiting.ts`), so the model can name one in a card or in Take.
 */
function getWaitingExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const tasks = await openTaskRows(deps.db, call.siteId, call.trigger.id, STAFF_ASK_TASKS_IN_CONTEXT);
    const cards = await pendingCardRows(deps.db, call.siteId, STAFF_ASK_CARDS_IN_CONTEXT);
    const replies = new Map((await pendingApprovals(deps.db, [call.siteId])).map((r) => [r.id, r]));
    const facts: Record<string, string | number> = { cards: cards.length };
    cards.forEach((c, i) => {
      const reply = replies.get(c.id);
      facts[`CARD-${i + 1}`] = reply ? `reply to ${reply.childLabel}'s family: ${reply.text.slice(0, 200)}` : c.summary.slice(0, 200);
    });
    const alerts = tasks
      .map((t, i) => ({ t, label: `TK-${i + 1}` }))
      .filter(({ t }) => t.category !== STAFF_ASK_TASK_CATEGORY && t.category !== STAFF_ALERT_TASK_CATEGORY && t.category !== STAFF_ACTION_TASK_CATEGORY && !t.category.startsWith("AGENT_"));
    facts.alerts = alerts.length;
    for (const { t, label } of alerts) facts[label] = `${t.severity} ${t.summary.slice(0, 160)}`;
    return { status: "executed", data: { cards: cards.length, alerts: alerts.length }, promptFacts: facts };
  };
}

/** A FAMILY'S RECENT TEXTS (ledger #77), oldest first and wrapped as evidence, never instructions. */
function readFamilyTextsExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const rows = (
      await deps.db.query<{ direction: string; body_tokenized: string }>(
        `SELECT m.direction::text AS direction, m.body_tokenized FROM ops.message m
           JOIN ops.conversation_thread t ON t.id = m.thread_id AND t.site_id = m.site_id
           JOIN ops.child_profile c ON c.family_group_id = t.family_group_id AND c.site_id = t.site_id
          WHERE c.child_token = $1 AND m.site_id = $2 AND m.is_own_echo = false
          ORDER BY m.received_at DESC, m.id DESC LIMIT $3`,
        [isUuid(String(call.args.child ?? "")) ? call.args.child : null, call.siteId, FAMILY_TEXTS_TO_READ],
      )
    ).rows.reverse();
    const facts: Record<string, string | number> = { texts: rows.length };
    rows.forEach((m, i) => (facts[`text_${i + 1}`] = `${m.direction === "INBOUND" ? "family" : "us"}: ${wrapUntrusted(tokenizeNames(m.body_tokenized))}`));
    return { status: "executed", data: { texts: rows.length }, promptFacts: facts };
  };
}

/** How many of a family's texts one read hands the model. */
const FAMILY_TEXTS_TO_READ = 8;

/**
 * WHAT HAPPENED TODAY (ledger #76), read-only, in time order — so asked "what was just done?" the
 * agent can look before it answers instead of guessing from leg states. Read from the records the
 * day already keeps: plans saved, vans checked at the ramp, van alerts, cards decided or drafted,
 * and late texts sent. Nothing is written.
 */
function getActivityExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const today = serviceDateIso(call.now);
    const who = (by: string | null) => staffLabel(by?.replace(/^staff:/, "") ?? null) ?? activityWords.someone;
    const events: { at: Date; line: string }[] = [];
    const q = <T,>(sql: string, params: unknown[]) => deps.db.query<T & { at: Date }>(sql, params).then((r) => r.rows);

    for (const r of await q<{ direction: string; saved_by: string | null }>(
      `SELECT direction::text AS direction, saved_by::text AS saved_by, saved_at AS at FROM ops.plan_run
        WHERE site_id = $1 AND service_date = $2::date`, [call.siteId, today])) {
      events.push({ at: r.at, line: fill(activityWords.planSaved, { who: who(r.saved_by), leg: legWord(r.direction) }) });
    }
    for (const r of await q<{ van: string; set_by: string | null; seats: number; wc: number; cs: number; ox: number }>(
      `SELECT v.vehicle_id::text AS van, v.set_by::text AS set_by, v.set_at AS at, v.seats, v.wheelchair_spots AS wc,
              v.car_seats AS cs, v.oxygen_mounts AS ox
         FROM ops.vehicle_setup_day v WHERE v.site_id = $1 AND v.service_date = $2::date AND v.state = 'CHECKED' AND v.set_at IS NOT NULL`,
      [call.siteId, today])) {
      events.push({ at: r.at, line: fill(activityWords.vanChecked, { who: who(r.set_by), van: vanNameOfId(r.van), seats: r.seats, wc: r.wc, cs: r.cs, ox: r.ox }) });
    }
    for (const r of await q<{ summary: string; state: string }>(
      `SELECT summary, state::text AS state, created_at AS at FROM ops.task
        WHERE site_id = $1 AND category = 'VAN_SHORT' AND created_at::date = $2::date`, [call.siteId, today])) {
      events.push({ at: r.at, line: fill(activityWords.alert, { what: r.summary, state: r.state.startsWith("RESOLVED") ? activityWords.resolved : activityWords.open }) });
    }
    for (const r of await q<{ summary: string | null; decision: string | null; decided_by: string | null; outcome: string | null; impact: string[] | null; created_by: string }>(
      `SELECT proposal->>'summary' AS summary, decision, decided_by::text AS decided_by, proposal->>'outcome' AS outcome,
              proposal->'impact' AS impact, created_by, coalesce(decided_at, created_at) AS at
         FROM ops.approval_request
        WHERE site_id = $1 AND proposal->>'kind' = 'STAFF_ACTION' AND coalesce(decided_at, created_at)::date = $2::date`,
      [call.siteId, today])) {
      const impact = Array.isArray(r.impact) ? ` (${r.impact.join("; ")})` : "";
      const line = r.decision === "APPROVED"
        ? fill(activityWords.approved, { who: who(r.decided_by), what: r.summary ?? "", impact, outcome: r.outcome ?? "" })
        : r.decision
          ? fill(activityWords.declined, { who: who(r.decided_by), what: r.summary ?? "" })
          : fill(activityWords.drafted, { who: r.created_by.startsWith("agent:") ? activityWords.agent : who(r.created_by), what: r.summary ?? "", impact });
      events.push({ at: r.at, line });
    }
    const texted = (await q<{ n: number }>(
      `SELECT count(DISTINCT child_token)::int AS n, max(created_at) AS at FROM ops.outbound_message
        WHERE site_id = $1 AND template_id = 'dropoff.late_eta' AND created_at::date = $2::date`, [call.siteId, today]))[0];
    if (texted && texted.n > 0) events.push({ at: texted.at, line: fill(activityWords.texted, { count: texted.n }) });

    const recent = events.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-20);
    const facts: Record<string, string | number> = { events: recent.length };
    recent.forEach((e, i) => (facts[`event_${i + 1}`] = `${siteTimeLabel(new Date(e.at))} ${e.line}`.slice(0, 300)));
    return { status: "executed", data: { events: recent.length }, promptFacts: facts };
  };
}

const legWord = (direction: string) => (direction === "AM" ? "morning" : "afternoon");
/** "Van 2" for a vehicle id, from the one van config. */
const vanNameOfId = (id: string) => {
  const van = VANS.find((v) => vehicleIdOf(v.vehicleKey) === id);
  return van ? vanNameOf(van.slot) : "a van";
};

/** Every teammate executor: the reads, and Take. The cards are proposals (run/exec/proposals.ts). */
export function staffExecutors(deps: ExecutorDeps): ToolExecutors {
  return {
    get_plan: inTokens(getPlanExecutor(deps)),
    get_child: inTokens(getChildExecutor(deps)),
    get_waiting: inTokens(getWaitingExecutor(deps)),
    get_activity: inTokens(getActivityExecutor(deps)),
    read_family_texts: readFamilyTextsExecutor(deps),
    take_alert: actionExecutor(deps, actionTool("take_alert")!),
  };
}

/**
 * THE MODEL READS PEOPLE AS TOKENS (PRD: agent context gets tokens; the gateway refuses untokenized
 * names). A read hands back what screens show — "Zoe B." — so every fact is tokenized on its way to
 * the model. It then writes "C6", which the bubble turns back into a name, instead of writing the
 * name and having the reply's own redaction wipe it to "[REDACTED:NAME]".
 */
function inTokens(executor: ToolExecutor): ToolExecutor {
  return async (call) => {
    const out = await executor(call);
    if (out.status !== "executed" || !out.promptFacts) return out;
    const facts = Object.fromEntries(
      Object.entries(out.promptFacts).map(([k, v]) => [k, typeof v === "string" ? tokenizeNames(v) : v]),
    );
    return { ...out, promptFacts: facts };
  };
}

