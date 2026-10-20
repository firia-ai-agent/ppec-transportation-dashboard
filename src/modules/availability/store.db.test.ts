import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { freshPlanDb, SITE } from "@/test/pglite";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlDaySource } from "@/modules/roster/sql";
import {
  approvedSlots, mayConfirmAvailability, recordApprovedSlot, recordAvailabilityRequest, settleAvailabilityRequest,
} from "./store";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const NOAH = () => childTokenOf("C2");
const BY = "test";

/** A guardian on Noah's file who may say when he can be received (§6.4). */
async function noahsGuardian(): Promise<string> {
  const r = await db.query<{ contact_token: string }>(
    `SELECT contact_token::text AS contact_token FROM ops.contact_authorization
      WHERE child_token = $1::uuid AND scope = 'CONFIRM_AVAILABILITY_TO_RECEIVE' LIMIT 1`,
    [NOAH()],
  );
  return r.rows[0].contact_token;
}

const requestRow = async (id: string) =>
  (await db.query<{ status: string; kind: string; payload: Record<string, unknown> }>(
    "SELECT status, kind, payload FROM ops.change_request WHERE id = $1", [id],
  )).rows[0];

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW, siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
}, 180_000);

afterAll(async () => {
  await close();
});

describe("a family's request is evidence, never authority (ledger #83, RES-02)", () => {
  it("is PROPOSED from a guardian who may confirm when the child can be received", async () => {
    const guardian = await noahsGuardian();
    expect(await mayConfirmAvailability(db, { siteId: SITE, contactToken: guardian, childToken: NOAH(), at: NOW })).toBe(true);
    const id = "01900000-0000-7000-8000-0000000a7001";
    const r = await recordAvailabilityRequest(db, {
      id, siteId: SITE, childToken: NOAH(), contactToken: guardian, serviceDate: DATE, direction: "PM",
      time: "16:50", basisMessageId: null, now: NOW, by: BY,
    });
    expect(r.status).toBe("PROPOSED");
    expect(await requestRow(id)).toMatchObject({
      kind: "AVAILABILITY", status: "PROPOSED",
      payload: { leg: "PM", date: DATE, start: "16:50", end: "17:20", kind: "CAN" },
    });
  });

  it("needs a person when the sender is not on file for that child — a phone match is not permission", async () => {
    const stranger = "01900000-0000-7000-8000-0000000a7fff";
    const id = "01900000-0000-7000-8000-0000000a7002";
    const r = await recordAvailabilityRequest(db, {
      id, siteId: SITE, childToken: NOAH(), contactToken: stranger, serviceDate: DATE, direction: "PM",
      time: "16:50", basisMessageId: null, now: NOW, by: BY,
    });
    expect(r.status).toBe("NEEDS_HUMAN");
    expect((await requestRow(id)).status).toBe("NEEDS_HUMAN");
  });

  it("is settled once: REJECTED stays rejected", async () => {
    const id = "01900000-0000-7000-8000-0000000a7003";
    await recordAvailabilityRequest(db, {
      id, siteId: SITE, childToken: NOAH(), contactToken: await noahsGuardian(), serviceDate: DATE,
      direction: "PM", time: "17:00", basisMessageId: null, now: NOW, by: BY,
    });
    await settleAvailabilityRequest(db, { id, siteId: SITE, status: "REJECTED", now: NOW, by: BY });
    await settleAvailabilityRequest(db, { id, siteId: SITE, status: "APPLIED", now: NOW, by: BY });
    expect((await requestRow(id)).status).toBe("REJECTED");
  });
});

describe("an approved slot is the family's agreed range, one per ride (ledger #83)", () => {
  it("is the time plus the configured width, and a later approval supersedes the earlier one", async () => {
    const guardian = await noahsGuardian();
    const first = await recordApprovedSlot(db, {
      siteId: SITE, childToken: NOAH(), contactToken: guardian, serviceDate: DATE, direction: "PM",
      time: "16:50", changeRequestId: null, approvalId: null, now: NOW, by: BY,
    });
    expect(first.ok).toBe(true);
    expect((await approvedSlots(db, { siteId: SITE, serviceDate: DATE, direction: "PM" })).get(NOAH()))
      .toEqual([{ start: "16:50", end: "17:20" }]);

    await recordApprovedSlot(db, {
      siteId: SITE, childToken: NOAH(), contactToken: guardian, serviceDate: DATE, direction: "PM",
      time: "17:05", changeRequestId: null, approvalId: null, now: NOW, by: BY,
    });
    expect((await approvedSlots(db, { siteId: SITE, serviceDate: DATE, direction: "PM" })).get(NOAH()))
      .toEqual([{ start: "17:05", end: "17:35" }]);
    const rows = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.availability WHERE child_token = $1::uuid", [NOAH()],
    );
    expect(rows.rows[0].n).toBe(2);
    // The morning is another ride and has no slot.
    expect((await approvedSlots(db, { siteId: SITE, serviceDate: DATE, direction: "AM" })).has(NOAH())).toBe(false);
  });

  it("refuses a time that is not a time", async () => {
    expect(await recordApprovedSlot(db, {
      siteId: SITE, childToken: NOAH(), contactToken: null, serviceDate: DATE, direction: "PM",
      time: "late", changeRequestId: null, approvalId: null, now: NOW, by: BY,
    })).toEqual({ ok: false, reason: "BAD_TIME" });
  });

  it("reaches the board: the day's rider carries the approved slot, and a child with none carries nothing", async () => {
    const riders = await sqlDaySource(db, SITE).riders(DATE, "PM");
    expect(riders.find((rider) => rider.token === NOAH())?.slots).toEqual([{ start: "17:05", end: "17:35" }]);
    expect(riders.filter((rider) => rider.token !== NOAH()).every((rider) => rider.slots === undefined)).toBe(true);
  });
});
