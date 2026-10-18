import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess, demoReset } from "@/ui/copy";
import { VANS } from "@/config/vans";
import { demoDaySource } from "@/modules/demo/day-source";
import { childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { serviceDateIso } from "@/ui/service-date";

/**
 * `POST /api/plan/place` — one child moved (founder 2026-10-17 7:17 PM ET, gate (b)).
 *
 * Two things are asserted here and nowhere else: **who** may move somebody (the two console
 * roles; the front desk gets a flat 403 even though they can read the same board on Today), and
 * that a move is a **new plan version** with the fit rule re-asked on the server.
 *
 * Runs on the memory store, like the other route tests: the rows the same calls write are
 * asserted against the real migrations in src/modules/plan/place.db.test.ts.
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
const VAN_THREE = vehicleIdOf(VANS[2].vehicleKey);
/** Theo V. needs nothing and rides the afternoon; Noah B. and Zoe B. ride in their own chairs. */
const THEO = childTokenOf("C8");
const NOAH = childTokenOf("C2");
const ZOE = childTokenOf("C6");
/** A well-formed vehicle id that is not one of the centre's three (Firia 8:02 PM seed ruling). */
const NOT_A_VAN = "01900000-0000-7000-8000-001c0000beef";

const move = (over: Record<string, unknown> = {}) => ({
  date: TODAY,
  direction: "PM",
  childToken: THEO,
  bucket: "VAN",
  vanId: VAN_ONE,
  version: 0,
  ...over,
});

beforeEach(() => {
  getCaller.mockReset();
  getCaller.mockResolvedValue(CALLERS.coordinator);
  clearMemoryPlanStore();
  process.env = { ...saved, DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL: undefined };
});
afterEach(() => {
  process.env = { ...saved };
  clearMemoryPlanStore();
});

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("https://example.test/called-by-the-test", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const planOf = () => memoryPlanStore().loadPlan("site", TODAY, "PM");

describe("who may move a child", () => {
  it("lets the two console roles move one", async () => {
    for (const who of ["director", "coordinator"] as const) {
      clearMemoryPlanStore();
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await post(move());
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
  });

  it("refuses the front desk with a bare 403, and a signed-out caller with a 401", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    const refused = await post(move());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ ok: false, error: apiAccess.notYourRole });
    // Nothing was written: the refusal is before the body is even read.
    expect(await planOf()).toBeNull();

    getCaller.mockResolvedValue(CALLERS.signedOut);
    const out = await post(move());
    expect(out.status).toBe(401);
    expect(await out.json()).toEqual({ ok: false, error: apiAccess.signIn });
  });

  /**
   * A preview shares the one Neon database with production and runs every transaction
   * `BEGIN READ ONLY` (DECISION-LEDGER #43), so a move there cannot land. It is refused in
   * words — the same 403 the demo reset gives — rather than attempted and reported as a 503
   * (Veri F7).
   */
  it("refuses a preview outright, and writes nothing", async () => {
    process.env = { ...process.env, VERCEL_ENV: "preview" };
    const res = await post(move());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe(demoReset.previewRefusal);
    // Nothing was written — and the store a preview would have used refuses to exist at all,
    // which is the other half of "fails closed in prod and previews".
    delete process.env.VERCEL_ENV;
    expect(await planOf()).toBeNull();
  });

  it("is a 400 when the body cannot be read, or names a bucket nobody has", async () => {
    for (const bad of ["not json", {}, move({ bucket: "SOMEWHERE" }), move({ date: "tomorrow" }), move({ extra: 1 })]) {
      const res = await post(bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
  });
});

describe("what a move leaves behind", () => {
  it("writes a new version every time, and never overwrites the one before it", async () => {
    const first = await post(move());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { version: number };
    expect(firstBody.version).toBe(1);

    const second = await post(move({ vanId: vehicleIdOf(VANS[1].vehicleKey), version: 1 }));
    expect(((await second.json()) as { version: number }).version).toBe(2);

    // A stale version is a conflict naming nobody rather than a silent overwrite.
    const stale = await post(move({ version: 1 }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, reason: "CHANGED" });
  });

  it("puts a child in the Absent bucket of this leg, with no van, and not in the other leg", async () => {
    const res = await post(move({ bucket: "ABSENT", vanId: null }));
    expect(res.status).toBe(200);
    const plan = await planOf();
    expect(plan?.placements[THEO]).toMatchObject({ bucket: "ABSENT", vanId: null });
    expect((await memoryPlanStore().loadPlan("site", TODAY, "AM"))).toBeNull();
  });

  it("marks a child away all day by writing both legs", async () => {
    const res = await post(move({ bucket: "ABSENT", vanId: null, allDay: true, otherVersion: 0 }));
    expect(res.status).toBe(200);
    expect((await memoryPlanStore().loadPlan("site", TODAY, "AM"))?.placements[THEO]).toMatchObject({
      bucket: "ABSENT",
    });
    expect((await planOf())?.placements[THEO]).toMatchObject({ bucket: "ABSENT" });
  });

  /**
   * Every van is the same generic kind with one wheelchair spot (Vera/Athena/Veri with Firia's
   * sign-off, 2026-10-18 12:13 AM ET), so the van that cannot take this chair is the van whose
   * spot is already used — a count the ramp can change, re-asked on the server.
   */
  it("re-asks the fit rule on the server: a chair onto a van with no spot left is a 422", async () => {
    expect((await post(move({ childToken: ZOE, vanId: VAN_THREE }))).status).toBe(200);
    const res = await post(move({ childToken: NOAH, vanId: VAN_THREE, version: 1 }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, reason: "WHEELCHAIR" });
    // Zoe's move is the only one kept: the refusal wrote nothing of Noah's.
    const plan = await planOf();
    expect(plan?.placements[ZOE]).toMatchObject({ bucket: "VAN", vanId: VAN_THREE });
    expect(plan?.placements[NOAH]?.bucket).not.toBe("VAN");
  });

  it("answers a uniform 404 for a child or a van this day does not have", async () => {
    expect((await post(move({ childToken: "01900000-0000-7000-8000-00000000beef" }))).status).toBe(404);
    expect((await post(move({ vanId: NOT_A_VAN }))).status).toBe(404);
  });

  it("names only children the day has, which is what the uniform 404 protects", async () => {
    const vans = await demoDaySource().vans(TODAY);
    expect(vans.map((van) => van.id)).toContain(VAN_ONE);
  });
});
