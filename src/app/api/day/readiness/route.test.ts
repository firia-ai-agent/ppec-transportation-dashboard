import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess } from "@/ui/copy";
import { VANS } from "@/config/vans";
import { clearMemoryPlanStore } from "@/modules/plan/memory";
import { serviceDateIso } from "@/ui/service-date";

/**
 * `GET /api/day/readiness` — the three steps of the day, for a screen catching up with the server
 * after a save or a Confirm (redesign spec §9.4).
 *
 * The strip and the banners are server-rendered from the same `getDayReadiness`, so nothing is
 * forced to call this to be correct; what it must be is **the same answer**, available to all
 * three roles and naming no child. That is what is asserted here.
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

async function get(query: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new Request(`https://example.test/called-by-the-test${query}`));
}

describe("the three steps of the day, over HTTP", () => {
  it("answers every role that has a surface at all", async () => {
    for (const who of ["director", "coordinator", "frontDesk"] as const) {
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await get(`?date=${TODAY}&leg=pm`);
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
  });

  it("refuses a signed-out caller with a 401", async () => {
    getCaller.mockResolvedValue(CALLERS.signedOut);
    const res = await get(`?date=${TODAY}&leg=pm`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.signIn });
  });

  it("says where the three steps are, on a day nothing has been done to", async () => {
    const body = await (await get(`?date=${TODAY}&leg=pm`)).json();
    expect(body.ok).toBe(true);
    expect(body.readiness).toMatchObject({
      date: TODAY,
      leg: "PM",
      started: true,
      setup: { state: "NEEDED", checked: 0, total: VANS.length, source: "YESTERDAY" },
      plan: { state: "NEEDED" },
      live: { state: "LOCKED", blockedBy: "PLAN" },
    });
  });

  it("names no child and no van: it is a count of steps", async () => {
    const text = await (await get(`?date=${TODAY}&leg=pm`)).text();
    for (const leak of ["Mia", "Zoe", "Noah", "Van 1"]) expect(text, leak).not.toContain(leak);
  });

  it("falls back to today and to the leg the clock is in when the address says neither", async () => {
    const body = await (await get("")).json();
    expect(body.readiness.date).toBe(TODAY);
    expect(["AM", "PM"]).toContain(body.readiness.leg);
    // A date nobody could mean is today as well, rather than an error (§9.3).
    const bad = await (await get("?date=yesterday&leg=sideways")).json();
    expect(bad.readiness.date).toBe(TODAY);
  });
});
