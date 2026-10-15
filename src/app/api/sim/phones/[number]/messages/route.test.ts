import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import type { StaffRole } from "@/auth/core";
import { apiAccess } from "@/ui/copy";
import { freshDb, SITE } from "@/test/pglite";
import {
  F1_NUMBER, F3_NUMBER, PEPPER, SITE_B, UNKNOWN_NUMBER, seedPersona, seedSecondSite, seedStaff,
} from "@/test/messaging";
import { MAX_LIMIT } from "@/modules/messaging/mailbox";

/**
 * THE SAME RULES, SENT STRAIGHT TO THE ENDPOINT.
 *
 * src/modules/messaging/mailbox.test.ts holds the decision; this file holds the HTTP answer a `curl`
 * would get, because a direct API call bypassing the UI is how an access hole is actually found
 * (src/auth/idswap.test.ts says the same about the one write). The session reader is mocked — there
 * is no cookie jar here — and the database is the real seeded one, so what runs is the handler chain:
 * the shared session guard from the access table, then the site check against the phone's own site.
 *
 * The two halves answer differently on purpose, and both are measured here:
 *  - the role half is the shared guard, so a front desk caller is refused before any phone is read
 *    and the body is the one sentence every endpoint's refusal uses (src/ui/copy.ts);
 *  - the site half is the module, so a phone at another site is a 404 `UNKNOWN_PHONE` identical to
 *    the answer for a number nobody holds.
 */
const mocks = vi.hoisted(() => ({ getCaller: vi.fn(), getNeonDb: vi.fn() }));
vi.mock("@/auth/caller", () => ({ getCaller: mocks.getCaller }));
vi.mock("@/db/exec", () => ({ getNeonDb: mocks.getNeonDb, runAfterCommit: vi.fn() }));

let pg: PGlite; let db: Db;
let directorA: string; let coordinatorA: string; let frontDeskA: string; let directorB: string; let outsider: string;
const saved = { ...process.env };

/** A session for a seeded user, as `getCaller` would resolve it, or no session at all. */
function signedIn(userId: string | undefined, role: StaffRole | null) {
  mocks.getCaller.mockResolvedValue(
    userId && role ? { kind: "STAFF", role, userId, memberships: [] } : { kind: "ANONYMOUS", memberships: [] },
  );
}

async function get(number: string, query = "") {
  const { GET } = await import("./route");
  const url = `https://example.test/phones/${encodeURIComponent(number)}/messages${query}`;
  return GET(new Request(url), { params: Promise.resolve({ number: encodeURIComponent(number) }) });
}

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  vi.clearAllMocks();
  mocks.getNeonDb.mockImplementation(() => db);
  process.env = { ...saved, HMAC_PEPPER: PEPPER, DATABASE_URL: undefined };

  await seedPersona(db, F1_NUMBER);
  await seedSecondSite(db);
  await seedPersona(db, F3_NUMBER, { siteId: SITE_B });
  directorA = await seedStaff(db, "DIRECTOR");
  coordinatorA = await seedStaff(db, "COORDINATOR");
  frontDeskA = await seedStaff(db, "FRONT_DESK");
  directorB = await seedStaff(db, "DIRECTOR", SITE_B);
  outsider = await seedStaff(db, "DIRECTOR", null);
}, 60_000);

afterEach(async () => { await pg.close(); process.env = { ...saved }; });

describe("GET the persona phone's messages, over HTTP", () => {
  it("answers a director and a coordinator at the phone's own site", async () => {
    for (const [who, role] of [[directorA, "DIRECTOR"], [coordinatorA, "COORDINATOR"]] as const) {
      signedIn(who, role);
      const res = await get(F1_NUMBER);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ number: F1_NUMBER, label: "F1", messages: [] });
    }
  });

  it("refuses the front desk at that same site, in the shared refusal shape", async () => {
    signedIn(frontDeskA, "FRONT_DESK");
    const res = await get(F1_NUMBER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.notYourRole });
    // Refused by the table before the phone was looked up: no database handle was even asked for.
    expect(mocks.getNeonDb).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller with 401 and never touches the database", async () => {
    signedIn(undefined, null);
    const res = await get(F1_NUMBER);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.signIn });
    expect(mocks.getNeonDb).not.toHaveBeenCalled();
  });

  it("refuses a signed-in caller who holds no role anywhere", async () => {
    mocks.getCaller.mockResolvedValue({ kind: "NO_ROLE", userId: outsider, memberships: [] });
    const res = await get(F1_NUMBER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: apiAccess.notYourRole });
  });

  it("gives the other site's director the same 404 for this phone as for a number nobody holds", async () => {
    signedIn(directorB, "DIRECTOR");
    const otherSite = await get(F1_NUMBER);
    const nobodys = await get(UNKNOWN_NUMBER);
    const nonsense = await get("+15615550199");

    const bodies = await Promise.all([otherSite.json(), nobodys.json(), nonsense.json()]);
    for (const [i, res] of [otherSite, nobodys, nonsense].entries()) {
      expect(res.status).toBe(404);
      expect(bodies[i]).toEqual({ error: "UNKNOWN_PHONE" });
    }
    // Their own site's phone still reads, so the 404 above is scoping and not a broken route.
    expect((await get(F3_NUMBER)).status).toBe(200);

    // And nothing in the refusal names a site or the number it refused.
    const text = JSON.stringify(bodies[0]);
    for (const leak of [SITE, SITE_B, F1_NUMBER]) expect(text).not.toContain(leak);
  });

  it("clamps ?limit=, however it is abused", async () => {
    signedIn(directorA, "DIRECTOR");
    for (const q of ["?limit=-1", "?limit=0", "?limit=NaN", "?limit=abc", "?limit=99999999", "?limit=1e400", "?limit=", "?limit=2.9", `?limit=${MAX_LIMIT + 1}`]) {
      const res = await get(F1_NUMBER, q);
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
      const body = (await res.json()) as { messages: unknown[] };
      expect({ q, messages: body.messages }).toEqual({ q, messages: [] });
    }
  });

  it("answers 503 rather than guessing when the pepper is not configured", async () => {
    delete process.env.HMAC_PEPPER;
    signedIn(directorA, "DIRECTOR");
    const res = await get(F1_NUMBER);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "NOT_CONFIGURED" });
    expect(mocks.getNeonDb).not.toHaveBeenCalled();
  });
});
