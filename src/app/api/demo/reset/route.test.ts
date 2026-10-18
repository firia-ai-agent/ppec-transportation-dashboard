import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_REFUSAL, RESET_ROLES } from "@/modules/demo/reset";

/**
 * A preview deployment is served production's DATABASE_URL (single-DB directive, DECISION-LEDGER #43),
 * so POST /api/demo/reset — which truncates and reseeds — must refuse there before it reads the session
 * or opens a connection. Both are stubbed to prove it: the caller says DIRECTOR, so neither the session
 * guard nor the role check can be what refuses, and getNeonDb() throws, so any DB access shows up as a
 * rejected promise.
 *
 * `getCaller` is the one session reader (src/auth/caller.ts) and the shared API guard is built on it,
 * so stubbing it stands in for the whole session half: no token is decoded and no auth DB is opened.
 * guard-matrix.test.ts is where the guard's own answers are checked, role by role.
 */
/*
 * `vi.hoisted`, because both factories below are hoisted above every other statement in this file:
 * a `const` declared here in source order does not exist yet when they run, and vitest refuses the
 * mock rather than closing over an undefined. The sentinel string is in here too — the stub that
 * throws it is built in the same block.
 */
const { DB_OPENED, getCaller, getNeonDb } = vi.hoisted(() => {
  const DB_OPENED = "stub: the route opened the database";
  return {
    DB_OPENED,
    getCaller: vi.fn(async () => ({
      kind: "STAFF" as const, role: "DIRECTOR" as const,
      userId: "00000000-0000-7000-8000-0000000000d1", memberships: [],
    })),
    getNeonDb: vi.fn(() => { throw new Error(DB_OPENED); }),
  };
});
vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("@/db/exec", () => ({ getNeonDb }));

const saved = { ...process.env };
beforeEach(() => { getCaller.mockClear(); getNeonDb.mockClear(); });
afterEach(() => { process.env = { ...saved }; });

/** DATABASE_URL is cleared too, so even an unstubbed DB path could not reach a server. */
async function post(env: Record<string, string | undefined>, body: unknown = {}) {
  process.env = { ...saved, DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL: undefined, ...env };
  const { POST } = await import("./route");
  return POST(new Request("https://example.test/api/demo/reset", { method: "POST", body: JSON.stringify(body) }));
}

it("refuses on a preview with 403 and a clear JSON error, even for a DIRECTOR", async () => {
  const res = await post({ VERCEL_ENV: "preview" });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ ok: false, error: PREVIEW_REFUSAL });
  expect(PREVIEW_REFUSAL).toMatch(/preview/i);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

it("reads neither the session nor the DB when it refuses on a preview", async () => {
  // Naming a site in the body changes nothing: there is no input that gets past the deployment gate.
  const res = await post({ VERCEL_ENV: "preview" }, { siteId: "00000000-0000-7000-8000-000000000001" });
  expect(res.status).toBe(403);
  expect(getCaller).not.toHaveBeenCalled();
  expect(getNeonDb).not.toHaveBeenCalled();
});

it("the refusal says nothing about flags, tickets, connections or secrets", async () => {
  const text = JSON.stringify(await (await post({ VERCEL_ENV: "preview" })).json());
  expect(text).not.toMatch(/PPE-|\bticket\b|DEMO_MODE|VERCEL_ENV|DATABASE_URL|postgres/i);
});

it("off a preview the existing guards still decide: flags off is an invisible 404, real data a 403", async () => {
  for (const vercelEnv of [undefined, "production", "development"]) {
    expect((await post({ VERCEL_ENV: vercelEnv, DEMO_MODE: "0" })).status).toBe(404);
    expect((await post({ VERCEL_ENV: vercelEnv, APP_DATA_CLASS: "REAL" })).status).toBe(403);
    expect(getNeonDb).not.toHaveBeenCalled();
  }
});

it("off a preview a flagged deployment still runs: the route reaches the session and the DB", async () => {
  for (const vercelEnv of [undefined, "production"]) {
    await expect(post({ VERCEL_ENV: vercelEnv })).rejects.toThrow(DB_OPENED); // the stub, i.e. not gated
    expect(getCaller).toHaveBeenCalled();
  }
});

it("a signed-out caller is 401 and a wrong role is 403, before the DB is opened", async () => {
  getCaller.mockResolvedValue({ kind: "ANONYMOUS" } as never);
  const anon = await post({});
  expect(anon.status).toBe(401);

  getCaller.mockResolvedValue({ kind: "STAFF", role: "FRONT_DESK", userId: "u1", memberships: [] } as never);
  const frontDesk = await post({});
  expect(frontDesk.status).toBe(403);

  // Neither refusal reached the database, and neither says which role would have worked.
  expect(getNeonDb).not.toHaveBeenCalled();
  for (const res of [anon, frontDesk]) {
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|demo\/reset/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
});

/**
 * WHO MAY RESET THE DEMO — the front desk may not, and the check is the route's own.
 *
 * REDESIGN-SPEC §0 hides "Restart demo day" from the front desk, and §9.3 is explicit that
 * hiding is not the answer: "APIs keep returning 403, including POST /api/demo/reset for front
 * desk". So this asks the real route handler, with a real `Request`, for both ends of that
 * sentence — a front-desk caller is refused and a director gets the reset — rather than asking
 * the access table what it says about itself.
 *
 * The DB write is the only thing stubbed: `handleDemoReset` is what truncates and reseeds, so
 * it is replaced by a spy that records whether it was reached. That is what makes the two
 * assertions a pair — the refusal must not reach it, and the success must.
 *
 * Deleting the guard fails this: with `requireApiSession(API.demoReset)` taken out of the
 * handler, the front-desk request falls through to the reset and this reads 200 with the spy
 * called, not 403 with it untouched.
 */
describe("the reset is the director's, and the front desk is refused there too", () => {
  const RESET = { status: 200 as const, body: { ok: true as const, seeded: true } };
  const handleDemoReset = vi.fn(async () => RESET);

  /** The one side effect, stubbed. The gate beside it is the real module's. */
  beforeEach(() => {
    handleDemoReset.mockClear();
    vi.doMock("@/modules/demo/reset", async () => ({
      ...(await vi.importActual<typeof import("@/modules/demo/reset")>("@/modules/demo/reset")),
      handleDemoReset,
    }));
    // The reset's own DB handle: never opened on the refusal, harmless on the success because
    // the handler above it is the stub.
    getNeonDb.mockReturnValue({} as never);
  });

  afterEach(() => {
    vi.doUnmock("@/modules/demo/reset");
    vi.resetModules();
    getNeonDb.mockReset();
    getNeonDb.mockImplementation(() => { throw new Error(DB_OPENED); });
  });

  it("answers 403 to a FRONT_DESK caller and never runs the reset", async () => {
    getCaller.mockResolvedValue({
      kind: "STAFF", role: "FRONT_DESK", userId: "00000000-0000-7000-8000-0000000000f1", memberships: [],
    } as never);
    const res = await post({});
    expect(res.status).toBe(403);
    expect(handleDemoReset).not.toHaveBeenCalled();
    // And the refusal names no role and no route (COPY-GUIDE §2, the ID-swap rules).
    expect(JSON.stringify(await res.json())).not.toMatch(/DIRECTOR|FRONT_DESK|demo\/reset/);
  });

  it("answers 403 to a COORDINATOR too: the row is one role, not 'a console role'", async () => {
    getCaller.mockResolvedValue({
      kind: "STAFF", role: "COORDINATOR", userId: "00000000-0000-7000-8000-0000000000c1", memberships: [],
    } as never);
    expect((await post({})).status).toBe(403);
    expect(handleDemoReset).not.toHaveBeenCalled();
  });

  it("runs the reset for a DIRECTOR", async () => {
    getCaller.mockResolvedValue({
      kind: "STAFF", role: "DIRECTOR", userId: "00000000-0000-7000-8000-0000000000d1", memberships: [],
    } as never);
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESET.body);
    expect(handleDemoReset).toHaveBeenCalledTimes(1);
    // The caller the handler is given is the one the guard resolved, not the one in the body.
    const args = handleDemoReset.mock.calls[0] as unknown as [unknown, unknown, { userId?: string }];
    expect(args[2]).toMatchObject({ userId: "00000000-0000-7000-8000-0000000000d1" });
  });

  it("is the set of roles the access table names, so the button in the bar matches it", () => {
    expect(RESET_ROLES).toEqual(["DIRECTOR"]);
  });
});
