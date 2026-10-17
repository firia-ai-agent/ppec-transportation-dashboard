import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess } from "@/ui/copy";
import { VANS } from "@/config/vans";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { resolveSetup } from "@/domain/plan/setup";
import { serviceDateIso } from "@/ui/service-date";

/**
 * `POST /api/vans/:id/setup` — the write behind "Confirm Van 1" on the ramp iPad (redesign spec
 * §2) and behind Apply in the board's setup popover (§1.3).
 *
 * It is the one endpoint on this screen open to **all three roles**, because counting what is on a
 * van is the front desk's own job — so the interesting assertions are about what each role may
 * write, not only about who may call it: the front desk may confirm what arrived and may not plan
 * a van they are not looking at.
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

  it("lets the front desk confirm what arrived and not plan a van", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    expect((await post(VAN_ONE, counted({ state: "CHECKED" }))).status).toBe(200);
    const planned = await post(VAN_ONE, counted({ state: "PLANNED" }));
    expect(planned.status).toBe(403);
    expect(await planned.json()).toEqual({ ok: false, reason: "NOT_YOUR_WRITE" });
  });

  it("lets a coordinator plan a van they are not looking at", async () => {
    getCaller.mockResolvedValue(CALLERS.coordinator);
    expect((await post(VAN_ONE, counted({ state: "PLANNED" }))).status).toBe(200);
  });

  it("refuses the state the ladder returns rather than a person setting it", async () => {
    getCaller.mockResolvedValue(CALLERS.coordinator);
    const res = await post(VAN_ONE, counted({ state: "DEFAULT" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, reason: "NOT_A_STATE" });
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
    expect(body.readiness.setup).toMatchObject({ state: "NEEDED", checked: 1, total: VANS.length });

    const rows = await memoryPlanStore().setupRows("site", TODAY, [VAN_ONE]);
    const today = rows.find((row) => row.serviceDate === TODAY);
    expect(today).toMatchObject({ state: "CHECKED", setBy: "Frankie P." });
    expect(today?.setup.seats).toBe(6);
  });

  it("is what tomorrow starts from: the ladder carries a confirmed day forward", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    await post(VAN_ONE, counted({ seats: 4, wheelchairSpots: 2, carSeats: 1, oxygenMounts: 0, hasLift: true }));
    const next = new Date(`${TODAY}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrowDate = next.toISOString().slice(0, 10);
    const rows = await memoryPlanStore().setupRows("site", tomorrowDate, [VAN_ONE]);
    const tomorrow = resolveSetup(VANS[0].vehicleKey, tomorrowDate, rows);
    expect(tomorrow.source).toBe("YESTERDAY");
    expect(tomorrow.setup).toEqual({ seats: 4, wheelchairSpots: 2, carSeats: 1, oxygenMounts: 0, hasLift: true });
    expect(tomorrow.fromDate).toBe(TODAY);
    // And it is not read as checked *today*, which is what the van's chip says (conflict C5).
    expect(tomorrow.state).toBe("DEFAULT");
  });

  it("says every van is checked once all three have been", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    let body: { readiness: { setup: { state: string; checked: number } } } | null = null;
    for (const van of VANS) {
      const res = await post(vehicleIdOf(van.vehicleKey), counted());
      body = await res.json();
    }
    expect(body?.readiness.setup).toMatchObject({ state: "DONE", checked: VANS.length });
  });
});
