import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API, endpointRow } from "@/auth/access";
import { signSimWebhook, SIM_SIGNATURE_HEADER } from "@/modules/messaging/inbound";
import { SIM_CENTER_NUMBER } from "@/modules/messaging/sim-numbers";
import { F1_NUMBER } from "@/test/messaging";
import { POST } from "./route";

/**
 * THE INBOUND WEBHOOK'S ONLY DOOR (access table row `signature-webhook`, ADR-006, MSG-01).
 *
 * This route is the one surface in the app that is reachable from the public internet and still
 * writes: ingest inserts a message row, a thread, a consent event, a suppression and a staff task.
 * There is no session to check — a provider has none to offer — so the HMAC over the request's own
 * raw body is the whole authorization, and the only thing worth testing is that a request without a
 * valid one produces **no side effect of any kind**.
 *
 * So the three things a side effect would have to go through are mocked and asserted *not called*:
 *  - `ingestInbound` — every write;
 *  - `getNeonDb` — the database handle, so not even a connection is opened;
 *  - `vercelQueueOutboxTransport` — the outbox publish (the HELP auto-reply's path).
 *
 * The signing and verifying functions are the real ones (`importOriginal`): a test that mocked the
 * compare would prove nothing. src/modules/messaging/inbound.test.ts covers `verifySimWebhook` on
 * its own and the happy path against a real database.
 */
const mocks = vi.hoisted(() => ({
  ingestInbound: vi.fn(),
  getNeonDb: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/modules/messaging/inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/messaging/inbound")>()),
  ingestInbound: mocks.ingestInbound,
}));
vi.mock("@/db/exec", () => ({ getNeonDb: mocks.getNeonDb, runAfterCommit: vi.fn() }));
vi.mock("@/modules/outbox/transport", () => ({ vercelQueueOutboxTransport: { publish: mocks.publish } }));

const PEPPER = "z".repeat(32);
const SECRET = "x".repeat(32);
const OTHER_SECRET = "y".repeat(32);
const saved = { ...process.env };

/** The form a persona phone posts, as the raw bytes the signature is computed over. */
const raw = new URLSearchParams({
  MessageSid: "SM-guard", From: F1_NUMBER, To: SIM_CENTER_NUMBER, Body: "the van has not arrived",
}).toString();
/** A different body, for the replayed-signature case. */
const otherRaw = new URLSearchParams({
  MessageSid: "SM-other", From: F1_NUMBER, To: SIM_CENTER_NUMBER, Body: "we are running late",
}).toString();

const post = (headers: Record<string, string>, body = raw) =>
  POST(new Request("https://example.test/inbound", {
    method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  }));

const sign = (header: string) => ({ [SIM_SIGNATURE_HEADER]: header });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingestInbound.mockResolvedValue({ status: 200, body: { ok: true, duplicate: false } });
  mocks.getNeonDb.mockReturnValue({ query: vi.fn(), tx: vi.fn() });
  process.env = { ...saved, SIM_WEBHOOK_SECRET: SECRET, VERCEL_ENV: undefined, HMAC_PEPPER: PEPPER };
});
afterEach(() => { process.env = { ...saved }; });

/** Nothing was read, nothing was written, nothing was published. The whole point of the row. */
function expectNoSideEffects(cell: string) {
  expect({ cell, ingest: mocks.ingestInbound.mock.calls.length }).toEqual({ cell, ingest: 0 });
  expect({ cell, db: mocks.getNeonDb.mock.calls.length }).toEqual({ cell, db: 0 });
  expect({ cell, outbox: mocks.publish.mock.calls.length }).toEqual({ cell, outbox: 0 });
}

describe("an unverified inbound post is a 401 with no side effect", () => {
  it.each([
    ["no signature header at all", () => ({})],
    ["a signature that is not one", () => sign("not-a-signature")],
    ["a hex digest of the right shape, signed with the wrong key", () => sign(signSimWebhook(raw, OTHER_SECRET))],
    ["a valid signature over a different body", () => sign(signSimWebhook(otherRaw, SECRET))],
    ["an empty signature header", () => sign("")],
  ])("%s", async (cell, headers) => {
    const res = await post(headers());
    expect({ cell, status: res.status }).toEqual({ cell, status: 401 });
    expect(await res.json()).toEqual({ ok: false, error: "SIGNATURE_INVALID" });
    expectNoSideEffects(cell);
  });

  it.each([
    ["SIM_WEBHOOK_SECRET is unset", undefined],
    ["SIM_WEBHOOK_SECRET is empty", ""],
    ["SIM_WEBHOOK_SECRET is too short to be a key", "short"],
  ])("fails closed when %s, even for a correctly signed body", async (cell, secret) => {
    process.env.SIM_WEBHOOK_SECRET = secret;
    // Signed with what the deployment *would* have used, and with whatever it actually has.
    for (const header of [signSimWebhook(raw, SECRET), signSimWebhook(raw, secret || "x")]) {
      const res = await post(sign(header));
      expect({ cell, status: res.status }).toEqual({ cell, status: 401 });
      expect(await res.json()).toEqual({ ok: false, error: "SIGNATURE_INVALID" });
    }
    expectNoSideEffects(cell);
  });

  /**
   * The row says a session grants nothing here, and this is where that is measured rather than
   * asserted: the handler imports no session reader at all, so a director's cookies are simply not
   * part of the request. A staff session with no signature is the same 401 as a stranger's.
   */
  it("a staff session is not a way in: no signature, still 401", async () => {
    const res = await post({ cookie: "authjs.session-token=a-real-directors-session" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "SIGNATURE_INVALID" });
    expectNoSideEffects("staff session, unsigned");
    // ...and the handler has no session reader to be fooled by one.
    const row = endpointRow(API.smsWebhook);
    expect(row?.auth.kind).toBe("signature-webhook");
  });

  it("refuses before the preview skip, so a preview cannot answer an unsigned post differently", async () => {
    process.env.VERCEL_ENV = "preview";
    const res = await post(sign("not-a-signature"));
    expect(res.status).toBe(401);
    expectNoSideEffects("preview, unsigned");
  });

  it("the refusal names no number, no body and no secret", async () => {
    const res = await post(sign(signSimWebhook(raw, OTHER_SECRET)));
    const text = JSON.stringify(await res.json());
    for (const leak of [SECRET, OTHER_SECRET, F1_NUMBER, SIM_CENTER_NUMBER, "the van has not arrived"]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("a correctly signed post is the only one that gets through", () => {
  it("verifies, then ingests, with the raw bytes it verified", async () => {
    const res = await post(sign(signSimWebhook(raw, SECRET)));
    expect(res.status).toBe(200);
    expect(mocks.ingestInbound).toHaveBeenCalledTimes(1);
    const [, deps, body, form] = mocks.ingestInbound.mock.calls[0];
    expect(body).toBe(raw); // the bytes under the signature, not a re-serialized form
    expect(form).toMatchObject({ MessageSid: "SM-guard", From: F1_NUMBER });
    expect(deps).toMatchObject({ pepper: PEPPER });
    expect(mocks.getNeonDb).toHaveBeenCalledTimes(1);
  });

  it("still refuses a signed body it cannot read, and a preview before it writes", async () => {
    const malformed = "Body=no-message-sid";
    expect((await post(sign(signSimWebhook(malformed, SECRET)), malformed)).status).toBe(400);
    expect(mocks.ingestInbound).not.toHaveBeenCalled();

    process.env.VERCEL_ENV = "preview";
    expect((await post(sign(signSimWebhook(raw, SECRET)))).status).toBe(503);
    expect(mocks.ingestInbound).not.toHaveBeenCalled();
    expect(mocks.getNeonDb).not.toHaveBeenCalled();
  });

  it("refuses a signed post with no pepper configured, before the database", async () => {
    delete process.env.HMAC_PEPPER;
    expect((await post(sign(signSimWebhook(raw, SECRET)))).status).toBe(503);
    expect(mocks.ingestInbound).not.toHaveBeenCalled();
    expect(mocks.getNeonDb).not.toHaveBeenCalled();
  });
});
