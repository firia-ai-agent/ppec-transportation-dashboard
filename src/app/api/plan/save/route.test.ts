import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess, planRoutes, vanName } from "@/ui/copy";
import { initialStages, planInputOf } from "@/domain/plan/stages";
import { planAssignment, type Assignment } from "@/domain/solver";

/**
 * POST and GET /api/plan/save, called as the server calls them.
 *
 * `getCaller` is the one session reader (src/auth/caller.ts) and the shared API guard is built on
 * it, so stubbing it is how a role is put on the request; the reader's own steps are tested
 * against a real database in caller.test.ts. `@/db/exec` throws a sentinel, so "this route
 * reached the database" is observable — and the point of this endpoint is that it never does: the
 * plan is checked by the pure solver and kept in the demo's own state.
 *
 * What is asserted here is the half a unit test of `checkPlan` cannot reach: the status codes, the
 * guard in front of them, and that a refused plan leaves nothing behind.
 */
const DB_OPENED = "stub: the route opened the database";
const getCaller = vi.fn();
const getNeonDb = vi.fn(() => {
  throw new Error(DB_OPENED);
});
vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("@/db/exec", () => ({ getNeonDb }));

const CALLERS = {
  director: {
    kind: "STAFF" as const,
    role: "DIRECTOR" as const,
    userId: "00000000-0000-7000-8000-0000000000d1",
    memberships: [],
  },
  coordinator: {
    kind: "STAFF" as const,
    role: "COORDINATOR" as const,
    userId: "00000000-0000-7000-8000-0000000000c1",
    memberships: [],
  },
  frontDesk: {
    kind: "STAFF" as const,
    role: "FRONT_DESK" as const,
    userId: "00000000-0000-7000-8000-0000000000f1",
    memberships: [],
  },
  noRole: { kind: "NO_ROLE" as const, userId: "00000000-0000-7000-8000-0000000000e1", memberships: [] },
  signedOut: { kind: "ANONYMOUS" as const, memberships: [] },
};

const saved = { ...process.env };

beforeEach(() => {
  getCaller.mockReset();
  getCaller.mockResolvedValue(CALLERS.coordinator);
  getNeonDb.mockClear();
  process.env = { ...saved, DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL: undefined };
});
afterEach(async () => {
  process.env = { ...saved };
  const { clearSavedPlans } = await import("@/modules/demo/plan-store");
  clearSavedPlans();
});

/** The lanes as the endpoint takes them: ids only, with no person's name on the wire. */
function asked(scenario: "EVERY_RIDER_FITS" | "ONE_RIDER_HAS_NO_VAN") {
  return Object.fromEntries(
    Object.entries(initialStages(scenario)).map(([laneId, stage]) => [
      laneId,
      { vehicleKey: stage.vehicleKey, arrival: stage.arrival },
    ]),
  );
}

const DAY = {
  scenario: "EVERY_RIDER_FITS" as const,
  direction: "AM" as const,
  stages: asked("EVERY_RIDER_FITS"),
  measured: [] as string[],
};

/** The day as the solver sees it, which is what the endpoint rebuilds from the body above. */
const INPUT = planInputOf({ ...DAY, stages: initialStages("EVERY_RIDER_FITS") });

/** The plan the screen would send after pressing Plan routes once. */
function plannedAssignment(): Assignment {
  return planAssignment(INPUT);
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("https://example.test/called-by-the-test", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function get(query: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new Request(`https://example.test/called-by-the-test${query}`));
}

describe("the guard in front of it", () => {
  it("is the two console roles', exactly like the screen it saves from", async () => {
    for (const who of ["director", "coordinator"] as const) {
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await post({ ...DAY, assignment: plannedAssignment() });
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
  });

  it("refuses the front desk with a bare 403, and a signed-out caller with a 401", async () => {
    const expected = {
      frontDesk: { status: 403, error: apiAccess.notYourRole },
      noRole: { status: 403, error: apiAccess.notYourRole },
      signedOut: { status: 401, error: apiAccess.signIn },
    };
    for (const [who, answer] of Object.entries(expected)) {
      getCaller.mockResolvedValue(CALLERS[who as keyof typeof CALLERS]);
      const res = await post({ ...DAY, assignment: plannedAssignment() });
      const text = await res.text();
      expect({ who, status: res.status }).toEqual({ who, status: answer.status });
      expect({ who, body: JSON.parse(text) }).toEqual({ who, body: { ok: false, error: answer.error } });
      expect(res.headers.get("cache-control")).toBe("no-store");
      // Not a page, no role key, no status code in the words, and no child or van named.
      expect(text).not.toMatch(/[<>]|DIRECTOR|COORDINATOR|FRONT_DESK|\b(400|401|403|404|422)\b/);
      expect(text).not.toMatch(/Mia|Zoe|\bV\d\b|\bC\d\b/);
    }
  });

  it("refuses before it reads the plan, so a refused caller cannot save one", async () => {
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    expect((await post({ ...DAY, assignment: plannedAssignment() })).status).toBe(403);
    getCaller.mockResolvedValue(CALLERS.coordinator);
    const read = await get("?scenario=EVERY_RIDER_FITS&direction=AM");
    expect((await read.json()).saved).toBeNull();
  });

  it("opens no database connection on any path, refused or kept", async () => {
    for (const who of Object.keys(CALLERS) as Array<keyof typeof CALLERS>) {
      getCaller.mockResolvedValue(CALLERS[who]);
      await post({ ...DAY, assignment: plannedAssignment() });
      await get("?scenario=EVERY_RIDER_FITS&direction=AM");
    }
    expect(getNeonDb).not.toHaveBeenCalled();
  });
});

describe("saving a plan", () => {
  it("keeps the plan and says how much of the day is in a van", async () => {
    const res = await post({ ...DAY, assignment: plannedAssignment() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.placed).toBe(INPUT.riders.length);
    expect(body.riders).toBe(INPUT.riders.length);
    expect(res.headers.get("cache-control")).toBe("no-store");
    /*
     * And when it kept it, which is the half the screen prints (Vera's review, 2026-10-17): the
     * saved line reads a real minute, and the only clock that knows it is this one. It is the
     * same instant the run reads back, in UTC, for the screen to put on the centre's clock.
     */
    expect(body.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const read = await (await get("?scenario=EVERY_RIDER_FITS&direction=AM")).json();
    expect(read.saved.savedAt).toBe(body.savedAt);
  });

  it("reads back the plan it kept, for that run and no other", async () => {
    await post({ ...DAY, assignment: plannedAssignment() });
    const mine = await (await get("?scenario=EVERY_RIDER_FITS&direction=AM")).json();
    expect(mine.saved.assignment).toEqual(plannedAssignment());
    expect(mine.saved.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The afternoon is a different run, and nothing has been saved for it.
    const afternoon = await (await get("?scenario=EVERY_RIDER_FITS&direction=PM")).json();
    expect(afternoon.saved).toBeNull();
  });

  it("replaces the run's last plan rather than keeping two", async () => {
    await post({ ...DAY, assignment: plannedAssignment() });
    const emptied = Object.fromEntries(INPUT.lanes.map((lane) => [lane.id, []]));
    await post({ ...DAY, assignment: emptied });
    const read = await (await get("?scenario=EVERY_RIDER_FITS&direction=AM")).json();
    expect(read.saved.assignment).toEqual(emptied);
  });
});

describe("a refused move cannot be saved by posting it directly", () => {
  /**
   * The request that skips the screen. In the scenario where one child cannot be placed, no van
   * has four-point straps: the screen refuses that drag and never sends it, so this is the same
   * plan arriving from something that is not the screen. It is re-asked of the solver and refused
   * in the same words, with nothing kept.
   */
  const scenario = "ONE_RIDER_HAS_NO_VAN" as const;
  const stages = asked(scenario);
  const laneId = Object.keys(stages)[0];
  const forced = {
    scenario,
    direction: "AM" as const,
    stages,
    measured: [],
    assignment: Object.fromEntries(
      Object.keys(stages).map((id) => [id, id === laneId ? ["C6"] : []]),
    ),
  };

  it("answers 422 with the refusal a coordinator would have read", async () => {
    const res = await post(forced);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    const input = planInputOf({
      scenario,
      direction: "AM",
      stages: initialStages(scenario),
      measured: [],
    });
    const lane = input.lanes.find((l) => l.id === laneId);
    expect(body.error).toContain("Zoe B.");
    expect(body.error).toContain(vanName(lane?.vehicle.description ?? ""));
    // No code and no deficit type in the sentence.
    expect(body.error).not.toMatch(/\bV\d\b|\bC\d\b|WC_|_SEAT/);
  });

  it("keeps nothing: after the refusal there is still no saved plan for that run", async () => {
    await post(forced);
    const read = await (await get(`?scenario=${scenario}&direction=AM`)).json();
    expect(read.saved).toBeNull();
  });

  it("does not keep the half of the plan that was fine either", async () => {
    // One good lane and one refused one, in the same request: all or nothing.
    const mixed = {
      ...forced,
      assignment: Object.fromEntries(
        Object.keys(stages).map((id, i) => [id, id === laneId ? ["C6"] : i === 1 ? ["C7"] : []]),
      ),
    };
    expect((await post(mixed)).status).toBe(422);
    const read = await (await get(`?scenario=${scenario}&direction=AM`)).json();
    expect(read.saved).toBeNull();
  });
});

describe("an id swap over HTTP", () => {
  /**
   * The ids a saved plan carries are the only ids this app takes from a request besides a site
   * id, so they get the same rule: one uniform answer for an id that is another run's, another
   * fleet's, or nobody's, in the same words, with nothing echoed back.
   */
  const swaps: Array<[string, unknown]> = [
    ["a child who is on no run today", { ...DAY, assignment: { V1: ["C12"], V2: [], V4: [] } }],
    ["a child id that matches nothing", { ...DAY, assignment: { V1: ["C999"], V2: [], V4: [] } }],
    ["a van that is on no lane today", { ...DAY, assignment: { V1: [], V2: [], V4: [], V3: ["C7"] } }],
    ["a lane id that matches nothing", { ...DAY, assignment: { V1: [], V2: [], V4: [], "lane-x": ["C7"] } }],
    [
      "a van that is not in the fleet",
      {
        ...DAY,
        stages: { ...DAY.stages, V1: { ...DAY.stages.V1, vehicleKey: "V99" } },
        assignment: { V1: [], V2: [], V4: [] },
      },
    ],
    [
      "a configuration that van is not built with",
      {
        ...DAY,
        stages: {
          ...DAY.stages,
          V1: { ...DAY.stages.V1, arrival: "RAMP_CHECKED", rampLayoutId: "L-nope" },
        },
        assignment: { V1: [], V2: [], V4: [] },
      },
    ],
    ["a chair measured for a child on no run", { ...DAY, measured: ["C12"], assignment: { V1: [], V2: [], V4: [] } }],
  ];

  it.each(swaps)("%s is a uniform 404 that confirms nothing", async (_what, body) => {
    const res = await post(body);
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({ ok: false, error: planRoutes.saveNotThisRun });
    for (const leak of ["C12", "C999", "V99", "V3", "lane-x", "L-nope", "Mallory"]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(getNeonDb).not.toHaveBeenCalled();
  });

  it("saves nothing on any of them", async () => {
    for (const [, body] of swaps) await post(body);
    const read = await (await get("?scenario=EVERY_RIDER_FITS&direction=AM")).json();
    expect(read.saved).toBeNull();
  });

  it("is a 400 before any of that when the body or the query cannot be read at all", async () => {
    const bodies: unknown[] = [
      "not json",
      {},
      { ...DAY, assignment: "mine" },
      { ...DAY, scenario: "OTHER_DAY" },
      // A field this endpoint does not take. It is strict on purpose: the one that used to be
      // here was a driver's name, and a name it ignored is a name that still travelled.
      {
        ...DAY,
        stages: { ...DAY.stages, V1: { ...DAY.stages.V1, driverName: "Mallory X." } },
        assignment: { V1: [], V2: [], V4: [] },
      },
    ];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: apiAccess.badRequest });
    }
    for (const query of ["", "?scenario=EVERY_RIDER_FITS", "?scenario=nope&direction=AM"]) {
      expect((await get(query)).status).toBe(400);
    }
  });
});
