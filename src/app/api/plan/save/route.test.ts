import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAccess } from "@/ui/copy";
import { VANS } from "@/config/vans";
import { childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { needsOfDemoChild } from "@/modules/demo/day-source";
import { childByKey } from "@/modules/demo/fixtures/standard";
import { clearMemoryPlanStore } from "@/modules/plan/memory";
import { serviceDateIso } from "@/ui/service-date";

/**
 * `POST /api/plan/save` and `GET /api/plan`, called as the server calls them.
 *
 * `getCaller` is the one session reader (src/auth/caller.ts) and the shared API guard is built on
 * it, so stubbing it is how a role is put on the request; the reader's own steps are tested
 * against a real database in caller.test.ts.
 *
 * These two routes run here on the **memory store**, because the test server has no
 * `DATABASE_URL` — which is the same position the browser check is in, and the reason that store
 * exists (src/modules/plan/memory.ts). What the SQL behind them does is asserted directly against
 * the migrations in src/modules/plan/sql.test.ts; what is asserted here is the half neither of
 * those can reach: the status codes, the guard in front of them, and that a refused plan leaves
 * nothing behind.
 */
const getCaller = vi.fn();
const getNeonDb = vi.fn(() => {
  throw new Error("stub: the route opened the database");
});
vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("@/db/exec", () => ({ getNeonDb }));

const CALLERS = {
  director: {
    kind: "STAFF" as const,
    role: "DIRECTOR" as const,
    userId: "01900000-0000-7000-8000-0000000000d1",
    memberships: [],
  },
  coordinator: {
    kind: "STAFF" as const,
    role: "COORDINATOR" as const,
    userId: "01900000-0000-7000-8000-0000000000c1",
    memberships: [],
  },
  frontDesk: {
    kind: "STAFF" as const,
    role: "FRONT_DESK" as const,
    userId: "01900000-0000-7000-8000-0000000000f1",
    memberships: [],
  },
  noRole: { kind: "NO_ROLE" as const, userId: "01900000-0000-7000-8000-0000000000e1", memberships: [] },
  signedOut: { kind: "ANONYMOUS" as const, memberships: [] },
};

const saved = { ...process.env };
const TODAY = serviceDateIso(new Date());
const VAN = (n: 0 | 1 | 2) => vehicleIdOf(VANS[n].vehicleKey);

beforeEach(() => {
  getCaller.mockReset();
  getCaller.mockResolvedValue(CALLERS.coordinator);
  getNeonDb.mockClear();
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

async function board(): Promise<{
  ok: boolean;
  version: number;
  savedAt: string | null;
  savedBy: string | null;
  plan: Record<string, { bucket: string; vanId: string | null }>;
  day: { riders: { token: string; name: string }[] };
}> {
  const { GET } = await import("../route");
  const res = await GET(new Request(`https://example.test/plan?date=${TODAY}&direction=PM`));
  return res.json();
}

/** Everybody in Unassigned: the board as a fresh day opens it. */
async function emptyPlacements(): Promise<Record<string, { bucket: string; vanId: null; pinned: boolean }>> {
  const { plan } = (await board()) as unknown as { plan: Record<string, { bucket: string; vanId: null; pinned: boolean }> };
  return plan;
}

/**
 * Save posts **moves**, not a board (Firia's option A, 2026-10-17 10:29 PM ET).
 *
 * These tests were written against the whole-plan body, and what they are each about is
 * unchanged, so the helper turns the plan they build into the moves that would produce it from
 * a fresh day: everything that is not Unassigned is a move somebody made.
 */
const movesFor = (placements: unknown) =>
  Object.entries((placements ?? {}) as Record<string, { bucket: string; vanId: string | null }>)
    .filter(([, placement]) => placement.bucket !== "UNASSIGNED")
    .map(([childToken, placement]) => ({
      childToken,
      bucket: placement.bucket,
      vanId: placement.vanId,
    }));

const body = (placements: unknown, over?: Partial<{ version: number; allowOver: boolean }>) => ({
  date: TODAY,
  direction: "PM" as const,
  version: 0,
  moves: movesFor(placements),
  ...over,
});

describe("the guard in front of it", () => {
  it("is the two console roles', exactly like the screen it saves from", async () => {
    for (const who of ["director", "coordinator"] as const) {
      clearMemoryPlanStore();
      getCaller.mockResolvedValue(CALLERS[who]);
      const res = await post(body(await emptyPlacements()));
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
  });

  it("refuses the front desk with a bare 403, and a signed-out caller with a 401 (§1.7 #5)", async () => {
    const expected = {
      frontDesk: { status: 403, error: apiAccess.notYourRole },
      noRole: { status: 403, error: apiAccess.notYourRole },
      signedOut: { status: 401, error: apiAccess.signIn },
    };
    const placements = await emptyPlacements();
    for (const [who, answer] of Object.entries(expected)) {
      getCaller.mockResolvedValue(CALLERS[who as keyof typeof CALLERS]);
      const res = await post(body(placements));
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
    const placements = await emptyPlacements();
    getCaller.mockResolvedValue(CALLERS.frontDesk);
    expect((await post(body(placements))).status).toBe(403);
    getCaller.mockResolvedValue(CALLERS.coordinator);
    expect((await board()).savedAt).toBeNull();
  });

  it("opens no database connection on this server: there is none to open", async () => {
    for (const who of Object.keys(CALLERS) as Array<keyof typeof CALLERS>) {
      getCaller.mockResolvedValue(CALLERS[who]);
      await post(body(await emptyPlacements()));
    }
    expect(getNeonDb).not.toHaveBeenCalled();
  });
});

describe("saving a board", () => {
  it("keeps it, says when, and reads the same board back (§1.7 #3)", async () => {
    const placements = await emptyPlacements();
    const res = await post(body(placements));
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer).toMatchObject({ ok: true, version: 1 });
    expect(answer.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const read = await board();
    expect(read.version).toBe(1);
    expect(read.savedAt).toBe(answer.savedAt);
    // Saved by the coordinator who asked, in the words a screen may print.
    expect(read.savedBy).toBe("Casey R.");
  });

  it("keeps where each child is, van by van", async () => {
    const placements = await emptyPlacements();
    const liam = childTokenOf("C3");
    const moved = { ...placements, [liam]: { bucket: "VAN", vanId: VAN(1), pinned: true } };
    expect((await post(body(moved))).status).toBe(200);
    const read = await board();
    expect(read.plan[liam]).toEqual({ bucket: "VAN", vanId: VAN(1), pinned: true });
  });

  it("refuses a second save against the version the first one moved on from (§1.3)", async () => {
    const placements = await emptyPlacements();
    expect((await post(body(placements))).status).toBe(200);
    const stale = await post(body(placements, { version: 0 }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, reason: "CHANGED", changedBy: "Casey R." });
    // And the plan is still the first one.
    expect((await board()).version).toBe(1);
  });
});

describe("a refused drop cannot be saved by posting it directly (§1.7 #1)", () => {
  /**
   * Van 3 has no wheelchair spot and no lift, so the board refuses that drag and never sends it.
   * This is the same plan arriving from something that is not the board: it is replayed through
   * the same fit rule and refused, with nothing kept.
   */
  async function forced() {
    const placements = await emptyPlacements();
    const noah = childTokenOf("C2");
    expect(needsOfDemoChild(childByKey("C2")).wheelchair).toBe(true);
    return {
      noah,
      body: body({ ...placements, [noah]: { bucket: "VAN", vanId: VAN(2), pinned: true } }),
    };
  }

  it("answers 422, naming the child, the van and the one thing that is missing", async () => {
    const { noah, body: forcedBody } = await forced();
    const res = await post(forcedBody);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "WHEELCHAIR",
      childToken: noah,
      vanId: VAN(2),
    });
  });

  it("keeps nothing: after the refusal there is still no saved plan", async () => {
    await post((await forced()).body);
    expect((await board()).savedAt).toBeNull();
  });

  it("does not keep the half of the plan that was fine either", async () => {
    const { noah } = await forced();
    // One move the fit rule is happy with, and one it is not: the whole save is refused, and
    // the good one does not land either (option A's all-or-nothing).
    const mixed = body({
      ...(await emptyPlacements()),
      [childTokenOf("C3")]: { bucket: "VAN", vanId: VAN(0), pinned: true },
      [noah]: { bucket: "VAN", vanId: VAN(2), pinned: true },
    });
    expect((await post(mixed)).status).toBe(422);
    expect((await board()).savedAt).toBeNull();
  });

  /**
   * Veri, 2026-10-17 8:35 PM ET: **a van can never be saved over its counts.** `allowOver` was a
   * flag that let a board post its way past the fit rule; it is gone, and the answer is the same
   * 422 a drag gets.
   */
  it("never saves a van over its own counts, with or without a flag", async () => {
    // Five children into Van 3, which has four seats: over, not impossible. Without the
    // confirm it is refused; with it, it is kept and the answer names the van that is over.
    const placements = await emptyPlacements();
    const five = ["C1", "C3", "C8", "C9", "C7"].map((key) => childTokenOf(key));
    const overloaded = { ...placements };
    for (const token of five) overloaded[token] = { bucket: "VAN", vanId: VAN(2), pinned: true } as never;
    expect((await post(body(overloaded))).status).toBe(422);
    // The flag is not in the schema at all, so asking for it is a 400 rather than a way round.
    const asked = await post(body(overloaded, { allowOver: true }));
    expect(asked.status).toBe(400);
    expect((await board()).savedAt).toBeNull();
  });
});

describe("an id swap over HTTP", () => {
  /**
   * The ids a saved board carries are ids from outside, so they get the rule every id in this app
   * gets: one uniform answer for a child who is not on this day, a van that is not on the board,
   * and an id that matches nothing at all — in the same words, with nothing echoed back.
   */
  // A move that **names** the strange id, because that is the only way one reaches the server
  // now: Save sends the moves a person made, not a map of every child.
  const swaps: Array<[string, Record<string, unknown>]> = [
    ["a child who is on no run today", { "01900000-0000-7000-8000-00110000beef": { bucket: "VAN", vanId: VAN(0), pinned: true } }],
    ["a child id that matches nothing", { "not-a-child": { bucket: "VAN", vanId: VAN(0), pinned: true } }],
  ];

  it.each(swaps)("%s is a uniform 404 that confirms nothing", async (_what, placements) => {
    const res = await post(body({ ...(await emptyPlacements()), ...placements }));
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({ ok: false, reason: "NOT_THIS_DAY" });
    for (const leak of ["beef", "not-a-child", "Mia", "Zoe"]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it("refuses a van that is not on the board, and keeps nothing", async () => {
    const placements = await emptyPlacements();
    const someone = childTokenOf("C3");
    const res = await post(
      body({ ...placements, [someone]: { bucket: "VAN", vanId: vehicleIdOf("V3"), pinned: true } }),
    );
    expect(res.status).toBe(404);
    expect((await board()).savedAt).toBeNull();
  });

  it("is a 400 before any of that when the body cannot be read at all", async () => {
    const bodies: unknown[] = [
      "not json",
      {},
      { ...body({}), direction: "EVENING" },
      { ...body({}), date: "yesterday" },
      { ...body({ "a-child": { bucket: "NOWHERE", vanId: null, pinned: false } }) },
      { ...body({}), extra: true },
    ];
    for (const bad of bodies) {
      const res = await post(bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect(await res.json()).toEqual({ ok: false, error: apiAccess.badRequest });
    }
  });
});
