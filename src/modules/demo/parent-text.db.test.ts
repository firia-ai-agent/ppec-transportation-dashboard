import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { parentTextConfig } from "@/config/live";
import { hhmmOf, plannedStopTimes } from "@/domain/plan/arrivals";
import { actionDepsFor } from "@/modules/actions/deps";
import { ACTIONS } from "@/modules/actions/registry";
import { demoTokenForId } from "@/modules/agent/run/scope-tokens";
import type { AgentWake, AgentWakeTransport } from "@/modules/agent/run/wake";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { loadBoard } from "@/modules/plan/store";
import { saveAutoPlan } from "@/test/save-plan";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { clockLabel } from "@/ui/service-date";
import { childByKey } from "./fixtures/standard";
import { simulateParentText } from "./parent-text";
import { seedStandardScenario } from "./seed";

/**
 * "SIMULATE PARENT TEXT" (ledger #78): every word of the parent's text comes from the day — which
 * child, their estimated drop-off, the later time — and it arrives the way a real text does.
 */
let db: Db;
let close: () => Promise<void>;
let coordinator = "";
const saved = { ...process.env };
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "syn-pepper-0123456789", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z"); // 1:45 PM ET: the whole afternoon is ahead
const DATE = "2026-10-16";
const woken: AgentWake[] = [];
const wake: AgentWakeTransport = { publish: async (m) => void woken.push(m) };

const deps = () => ({ ...actionDepsFor(db, SITE), env: ENV, agentTransport: wake, outboxTransport: new FakeOutboxTransport() });
const press = (childKey: string | null, now = NOW) => {
  const d = deps();
  return simulateParentText(db, { ...d, now, store: d.store!, source: d.source! }, { siteId: SITE, childKey });
};
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source!);
const ctx = () => ({ siteId: SITE, caller: { userId: coordinator, role: "COORDINATOR" as const }, now: NOW, deps: actionDepsFor(db, SITE) });

/** The words the day says this child's family would send, computed here from the board. */
async function expected(childKey: string) {
  const view = await board();
  const token = view.day.riders.find((r) => demoTokenForId(r.token) === childKey)!.token;
  const eta = Math.round(plannedStopTimes(view.day, view.plan, view.departs).get(token)!.arrivesAtMinute);
  const later = Math.ceil((eta + parentTextConfig.laterByMinutes) / parentTextConfig.roundToMinutes) * parentTextConfig.roundToMinutes;
  return `Hi, I won't be home at ${clockLabel(hhmmOf(eta))} for ${childByKey(childKey).firstName}. Can you bring them at ${clockLabel(hhmmOf(later))} instead?`;
}

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("Simulate parent text builds the text from the day (ledger #78)", () => {
  it("sends nothing before the afternoon is planned: there is no estimate to be away for", async () => {
    expect(await press(null)).toEqual({ sent: false, reason: "NO_PLAN" });
  });

  it("with no child named, the next drop-off's family texts their real estimate and a later time (P1)", async () => {
    expect((await saveAutoPlan(ctx(), DATE, "PM")).status).toBe(200);
    const view = await board();
    const times = plannedStopTimes(view.day, view.plan, view.departs);
    const next = view.day.riders
      .filter((r) => times.has(r.token) && demoTokenForId(r.token))
      .sort((a, b) => times.get(a.token)!.arrivesAtMinute - times.get(b.token)!.arrivesAtMinute)[0];
    const r = await press(null);
    expect(r).toEqual({ sent: true, childKey: demoTokenForId(next.token), text: await expected(demoTokenForId(next.token)!) });

    // Through the real inbound path: a message from that family's guardian, and a run for the agent.
    const msg = await db.query<{ body_tokenized: string }>("SELECT body_tokenized FROM ops.message WHERE direction = 'IN'", []);
    expect(msg.rows).toHaveLength(1);
    const runs = await db.query<{ id: string }>("SELECT id FROM ops.agent_run WHERE trigger_type = 'msg.inbound'", []);
    expect(runs.rows).toHaveLength(1);
    expect(woken.at(-1)).toMatchObject({ runId: runs.rows[0].id });
  });

  it("another child is another family and another time; a later departure changes the words (P2)", async () => {
    const view = await board();
    const keys = view.day.riders.map((r) => demoTokenForId(r.token)).filter((k): k is string => k !== null);
    const other = keys.find((k) => k !== keys[0])!;
    const a = await press(other);
    expect(a).toEqual({ sent: true, childKey: other, text: await expected(other) });

    const later = Object.fromEntries(view.day.vans.map((v) => [v.id, "16:10"]));
    expect((await ACTIONS.save_plan.run(ctx(), { date: DATE, direction: "PM", version: view.version, moves: [], departures: later })).status).toBe(200);
    const b = await press(other, new Date(NOW.getTime() + 60_000));
    expect(b).toEqual({ sent: true, childKey: other, text: await expected(other) });
    expect(b.sent && a.sent && b.text).not.toBe(a.sent && a.text);
    // Each press is its own text: no webhook duplicate swallows the second.
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.message WHERE direction = 'IN'", [])).rows[0].n).toBe(3);
  });

  it("once every drop-off has passed it is the earliest, rather than nobody", async () => {
    const evening = new Date("2026-10-16T23:30:00.000Z");
    const r = await press(null, evening);
    expect(r.sent).toBe(true);
  });
});
