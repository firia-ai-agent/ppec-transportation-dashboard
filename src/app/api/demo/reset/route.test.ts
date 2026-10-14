import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PREVIEW_REFUSAL } from "@/modules/demo/reset";

/**
 * A preview deployment is served production's DATABASE_URL (single-DB directive, DECISION-LEDGER #43),
 * so POST /api/demo/reset — which truncates and reseeds — must refuse there before it reads the session
 * or opens a connection. Both are stubbed to prove it: the session says DIRECTOR, so the role check
 * cannot be what refuses, and getNeonDb() throws, so any DB access shows up as a rejected promise.
 */
const DB_OPENED = "stub: the route opened the database";
const auth = vi.fn(async () => ({ user: { id: "00000000-0000-7000-8000-0000000000d1" } }));
const getNeonDb = vi.fn(() => { throw new Error(DB_OPENED); });
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/db/exec", () => ({ getNeonDb }));

const saved = { ...process.env };
beforeEach(() => { auth.mockClear(); getNeonDb.mockClear(); });
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
  expect(auth).not.toHaveBeenCalled();
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
    expect(auth).toHaveBeenCalled();
  }
});
