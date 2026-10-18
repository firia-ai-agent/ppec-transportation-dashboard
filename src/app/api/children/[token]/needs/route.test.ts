import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess } from "@/ui/copy";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { clearDemoNeedsOverride, demoNeedsOverride } from "@/modules/demo/needs-store";
import { serviceDateIso } from "@/ui/service-date";

/**
 * `POST /api/children/:token/needs` — the child panel's Save (founder 2026-10-17 7:17 PM ET).
 *
 * The two console roles write; **the front desk is refused**, which is the other half of the
 * read-only panel they see (hiding the button is the courtesy, this is the guard).
 *
 * This server has no database, so the needs land in the demo override
 * (src/modules/demo/needs-store.ts) — the same path the browser check walks. The rows the same
 * request writes on a real database, and the re-plan that follows, are asserted against the
 * migrations in src/modules/plan/place.db.test.ts.
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
/** Theo V. rides the afternoon and needs nothing, so every flag here is a change. */
const THEO = childTokenOf("C8");

const answers = (over: Record<string, unknown> = {}) => ({
  date: TODAY,
  direction: "PM",
  wheelchair: false,
  carSeat: true,
  oxygen: false,
  version: 0,
  ...over,
});

beforeEach(() => {
  getCaller.mockReset();
  getCaller.mockResolvedValue(CALLERS.coordinator);
  clearMemoryPlanStore();
  clearDemoNeedsOverride();
  process.env = { ...saved, DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL: undefined };
});
afterEach(() => {
  process.env = { ...saved };
  clearMemoryPlanStore();
  clearDemoNeedsOverride();
});

async function post(token: string, body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("https://example.test/called-by-the-test", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
}

describe("who may answer a child's three questions", () => {
  it("lets the two console roles save", async () => {
    for (const who of ["director", "coordinator"] as const) {
      clearDemoNeedsOverride();
      clearMemoryPlanStore();
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await post(THEO, answers());
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
  });

  it("refuses the front desk with a bare 403, and writes nothing", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    const res = await post(THEO, answers());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.notYourRole });
    expect(demoNeedsOverride(THEO)).toBeNull();
  });

  it("refuses a signed-out caller with a 401", async () => {
    getCaller.mockResolvedValue(CALLERS.signedOut);
    const res = await post(THEO, answers());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.signIn });
  });

  it("is a 400 for a body it cannot read, and a 404 for a child this day does not have", async () => {
    expect((await post(THEO, "not json")).status).toBe(400);
    expect((await post(THEO, answers({ wheelchair: "yes" }))).status).toBe(400);
    expect((await post("01900000-0000-7000-8000-00000000beef", answers())).status).toBe(404);
  });
});

describe("what a Save does", () => {
  it("keeps the three answers and re-plans the leg on them", async () => {
    const res = await post(THEO, answers({ carSeat: true, oxygen: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      needs: { carSeat: boolean; oxygen: boolean; wheelchair: boolean };
      version: number;
      view: { plan: Record<string, { bucket: string; vanId: string | null }> };
    };
    expect(body.needs).toMatchObject({ wheelchair: false, carSeat: true, oxygen: true });
    expect(demoNeedsOverride(THEO)).toEqual({ wheelchair: false, carSeat: true, oxygen: true });

    // The plan was re-run and saved: a version exists, and the child is on a van that can
    // carry what they now need.
    expect(body.version).toBe(1);
    const placement = body.view.plan[THEO];
    expect(placement.bucket).toBe("VAN");
    const saved = await memoryPlanStore().loadPlan("site", TODAY, "PM");
    expect(saved?.placements[THEO]).toMatchObject({ bucket: "VAN" });
  });

  it("answers a conflict rather than overwriting a plan somebody else has moved on", async () => {
    expect((await post(THEO, answers())).status).toBe(200);
    const stale = await post(THEO, answers({ version: 0 }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, reason: "CHANGED" });
  });
});
