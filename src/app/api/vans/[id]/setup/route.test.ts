import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess } from "@/ui/copy";
import { VANS } from "@/config/vans";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { demoDaySource } from "@/modules/demo/day-source";
import { resolveSetup } from "@/domain/plan/setup";
import { serviceDateIso } from "@/ui/service-date";

/**
 * `POST /api/vans/:id/setup` — the write behind "Confirm Van 1" on the ramp iPad (redesign spec
 * §2) and behind Apply in the board's setup popover (§1.3).
 *
 * It is the one endpoint on this screen open to **all three roles**, because counting what is on
 * a van is the front desk's own job. The interesting assertions are about *what* may be written:
 * `CHECKED` and nothing else. Firia's rule 1 (2026-10-17 5:48 PM ET) is that `PLANNED` stays in
 * migration 0009's frozen check constraint and **no write path can produce it** — the board has
 * no planned counts, and a request that asks for one is refused here whoever sends it.
 *
 * Runs on the memory store (this server has no `DATABASE_URL`), with the SQL the same calls make
 * asserted against the migrations in src/modules/plan/sql.test.ts.
 */
const getCaller = vi.fn();
vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("@/db/exec", () => ({
  getNeonDb: () => {
    throw new Error("stub: the route opened the database");
  },
}));

const CALLERS = {
  director: { kind: "STAFF" as const, role: "DIRECTOR" as const, userId: "01900000-0000-7000-8000-0000000000d1", memberships: [] },
  coordinator: { kind: "STAFF" as const, role: "COORDINATOR" as const, userId: "01900000-0000-7000-8000-0000000000c1", memberships: [] },
  frontDesk: { kind: "STAFF" as const, role: "FRONT_DESK" as const, userId: "01900000-0000-7000-8000-0000000000f1", memberships: [] },
  signedOut: { kind: "ANONYMOUS" as const, memberships: [] },
};

const saved = { ...process.env };
const TODAY = serviceDateIso(new Date());
const VAN_ONE = vehicleIdOf(VANS[0].vehicleKey);
/** The vans on the road today. The config also holds the reserve, which is on no run. */
const DAY_VANS = demoDaySource().vans(TODAY);

const counted = (over: Record<string, unknown> = {}) => ({
  date: TODAY,
  seats: 5,
  wheelchairSpots: 1,
  carSeats: 2,
  oxygenMounts: 1,
  hasLift: true,
  state: "CHECKED",
  ...over,
});

beforeEach(() => {
  getCaller.mockReset();
  getCaller.mockResolvedValue(CALLERS.frontDesk);
  clearMemoryPlanStore();
  process.env = { ...saved, DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL: undefined };
});
afterEach(() => {
  process.env = { ...saved };
  clearMemoryPlanStore();
});

async function post(vanId: string, body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("https://example.test/called-by-the-test", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: vanId }) },
  );
}

describe("who may count a van", () => {
  it("lets all three roles write, because the ramp is the front desk's surface (§2)", async () => {
    for (const who of ["director", "coordinator", "frontDesk"] as const) {
      clearMemoryPlanStore();
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await post(VAN_ONE, counted());
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
  });

  it("refuses a signed-out caller with a 401 and nothing else", async () => {
    getCaller.mockResolvedValue(CALLERS.signedOut);
    const res = await post(VAN_ONE, counted());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.signIn });
  });

  /**
   * Firia's rule 1: nothing writes `PLANNED`. Asserted per role, because "the front desk may
   * not" was the old rule and a coordinator could still do it — now nobody can, and the row the
   * refusal protects is checked for afterwards rather than assumed.
   */
  it("refuses a planned count from every role, and writes nothing", async () => {
    for (const who of ["director", "coordinator", "frontDesk"] as const) {
      clearMemoryPlanStore();
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await post(VAN_ONE, counted({ state: "PLANNED" }));
      expect({ who, status: res.status }).toEqual({ who, status: 403 });
      expect(await res.json()).toEqual({ ok: false, reason: "NOT_A_STATE" });
      expect(await memoryPlanStore().setupRows("site", TODAY, [VAN_ONE])).toEqual([]);
    }
  });

  it("refuses the state the absence of a row means, rather than a person setting it", async () => {
    getCaller.mockResolvedValue(CALLERS.coordinator);
    const res = await post(VAN_ONE, counted({ state: "DEFAULT" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, reason: "NOT_A_STATE" });
    expect(await memoryPlanStore().setupRows("site", TODAY, [VAN_ONE])).toEqual([]);
  });

  it("confirms for all three roles, which is the one write there is", async () => {
    for (const who of ["director", "coordinator", "frontDesk"] as const) {
      clearMemoryPlanStore();
      getCaller.mockResolvedValue(CALLERS[who]);
      expect((await post(VAN_ONE, counted({ state: "CHECKED" }))).status).toBe(200);
      const rows = await memoryPlanStore().setupRows("site", TODAY, [VAN_ONE]);
      expect(rows.map((row) => row.state)).toEqual(["CHECKED"]);
    }
  });

  it("answers a uniform 404 for a van this board does not run", async () => {
    getCaller.mockResolvedValue(CALLERS.coordinator);
    const res = await post(vehicleIdOf("V3"), counted());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, reason: "NO_SUCH_VAN" });
    const text = JSON.stringify(await (await post("not-a-van", counted())).json());
    expect(text).not.toContain("V3");
  });

  it("is a 400 when the body cannot be read, or asks for a count nobody has", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    for (const bad of [
      "not json",
      {},
      counted({ seats: -1 }),
      counted({ seats: 99 }),
      counted({ state: "MAYBE" }),
      counted({ date: "tomorrow" }),
      counted({ extra: true }),
    ]) {
      const res = await post(VAN_ONE, bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect(await res.json()).toEqual({ ok: false, error: apiAccess.badRequest });
    }
  });
});

describe("what a Confirm leaves behind (§2)", () => {
  it("writes the counts, names who counted them, and says how many vans are checked", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    const res = await post(VAN_ONE, counted({ seats: 6, carSeats: 2 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The answer carries the day's steps back, so the screen can say "1/3 checked".
    expect(body.readiness.setup).toMatchObject({ state: "NEEDED", checked: 1, total: DAY_VANS.length });

    const rows = await memoryPlanStore().setupRows("site", TODAY, [VAN_ONE]);
    const today = rows.find((row) => row.serviceDate === TODAY);
    expect(today).toMatchObject({ state: "CHECKED", setBy: "Frankie P." });
    expect(today?.setup.seats).toBe(6);
  });

  /**
   * Firia/Veri, 2026-10-17 6:00 PM ET: a Confirm is about **today** and nothing else. Tomorrow
   * does not start from it — tomorrow starts from the shared config's defaults until somebody
   * confirms the van again.
   */
  it("changes today and not tomorrow: there is no carry-over", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    const counts = { seats: 4, wheelchairSpots: 2, carSeats: 1, oxygenMounts: 0, hasLift: true };
    await post(VAN_ONE, counted(counts));
    const next = new Date(`${TODAY}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrowDate = next.toISOString().slice(0, 10);
    const rows = await memoryPlanStore().setupRows("site", tomorrowDate, [VAN_ONE]);
    const tomorrow = resolveSetup(VANS[0].vehicleKey, tomorrowDate, rows);
    expect(tomorrow.source).toBe("DEFAULT");
    expect(tomorrow.state).toBe("DEFAULT");
    expect(tomorrow.setup).toEqual(VANS[0].defaultSetup);
    // Today, meanwhile, is exactly what was counted.
    const today = resolveSetup(VANS[0].vehicleKey, TODAY, await memoryPlanStore().setupRows("site", TODAY, [VAN_ONE]));
    expect(today).toMatchObject({ source: "CHECKED", state: "CHECKED" });
    expect(today.setup).toEqual(counts);
  });

  it("says every van is checked once all three have been", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    let body: { readiness: { setup: { state: string; checked: number } } } | null = null;
    for (const van of DAY_VANS) {
      const res = await post(van.id, counted());
      body = await res.json();
    }
    expect(body?.readiness.setup).toMatchObject({ state: "DONE", checked: DAY_VANS.length });
  });
});
