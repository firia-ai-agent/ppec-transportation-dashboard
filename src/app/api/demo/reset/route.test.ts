import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEMO_RESET_REFUSAL } from "@/modules/demo/refusal";
import { PREVIEW_REFUSAL } from "@/modules/demo/reset";

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
const DB_OPENED = "stub: the route opened the database";
const getCaller = vi.fn(async () => ({
  kind: "STAFF" as const, role: "DIRECTOR" as const,
  userId: "00000000-0000-7000-8000-0000000000d1", memberships: [],
}));
const getNeonDb = vi.fn(() => { throw new Error(DB_OPENED); });
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
  /*
   * The sentence an operator reads, and beside it the code a *surface* reads: this refusal is
   * expected rather than wrong, so the header starts the scenario clock anyway and says the
   * reset is the live site's (src/modules/demo/refusal.ts, src/ui/demo-day.ts, ledger row 72).
   * A failure carries no code, which is how the two are told apart without matching on words.
   */
  expect(await res.json()).toEqual({ ok: false, error: PREVIEW_REFUSAL, refusal: DEMO_RESET_REFUSAL.readOnlyDb });
  expect(PREVIEW_REFUSAL).toMatch(/preview/i);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

it("the code names no flag, environment variable or connection, and no other refusal carries one", async () => {
  expect(DEMO_RESET_REFUSAL.readOnlyDb).toBe("read-only-db");
  // The flags-off 404 and the real-data 403 are not "by design" to a caller: no code on them.
  for (const env of [{ DEMO_MODE: "0" }, { APP_DATA_CLASS: "REAL" }]) {
    const body = await (await post(env)).json();
    expect(Object.keys(body).sort()).toEqual(["error", "ok"]);
  }
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

it("a coordinator reaches the work, the same as a director (ledger row 72)", async () => {
  // Founder's final ruling, 2026-10-17 14:44 ET: both console roles may reset the demo. The DB
  // stub throwing is the proof it got past both guards — there is nothing after them but work.
  for (const role of ["DIRECTOR", "COORDINATOR"] as const) {
    getCaller.mockResolvedValue({ kind: "STAFF", role, userId: "00000000-0000-7000-8000-0000000000d1", memberships: [] } as never);
    await expect(post({})).rejects.toThrow(DB_OPENED);
  }
});

it("a signed-out caller is 401 and a wrong role is 403, before the DB is opened", async () => {
  getCaller.mockResolvedValue({ kind: "ANONYMOUS" } as never);
  const anon = await post({});
  expect(anon.status).toBe(401);

  // The front desk is refused by the server, not merely offered no button (ledger row 72).
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
