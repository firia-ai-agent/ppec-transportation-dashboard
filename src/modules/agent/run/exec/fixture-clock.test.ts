/**
 * The guard on the fixtures' own clock, not on an executor.
 *
 * PGlite's `now()` is this machine's clock, and every DB-backed suite pins its own at `TEST_NOW`
 * (src/test/clock.ts). A fixture that cut its validity windows from `now() - interval '1 day'`
 * therefore agreed with the pinned clock for exactly one day: once the machine passed
 * 2026-10-16T12:00Z, the guardian authorization began *after* the message a scenario seeds, the
 * §6.4 lookup — which reads the window at the message's own arrival time — found no row,
 * `resolve_sender` called the sender unknown, and every multi-step run in the slice-3 suites
 * stopped after its first step.
 *
 * So this suite moves the machine's clock a year ahead of the pinned one and asserts the two things
 * the fixtures have to guarantee under it: the seeded windows still contain the scenario's message,
 * and AT-01 still walks all of its steps and sends. It fails on any fixture time built from the
 * database's clock or `Date.now()` instead of the clock the test runs on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). `read_message`, the capability report and the drain's
 * consent check all ask `IdentityGateway` now rather than the connection — and this one answers
 * from the rows `seedAgentScenario` just wrote. See src/test/identity-gateway.ts for why it is in
 * memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { F2_NUMBER, PEPPER } from "@/test/messaging";
import { type AgentScenario, seedAgentScenario, seedSecondGuardian } from "@/test/agent-state";
import { toolCall } from "../../providers/fake";
import { toolCalls } from "../store";
import { liveHarness } from "./live-harness";

/** Far enough ahead that no `now() - interval '1 day'` window could contain `TEST_NOW`. */
const A_YEAR_AHEAD = new Date(TEST_NOW.getTime() + 365 * 24 * 3600_000);

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  now = new Date(TEST_NOW);
  // Only `Date`: the run loop and the outbox still need real timers to make progress.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(A_YEAR_AHEAD);
}, 60_000);

afterEach(async () => {
  vi.useRealTimers();
  await pg.close();
});

/** Every seeded authorization window that does *not* contain `at` — which must be none of them. */
const windowsMissing = async (at: Date) =>
  (await db.query<{ src: string; token: string; valid_from: Date; valid_to: Date | null }>(
    `SELECT 'identity.guardian_contact' src, contact_token token, valid_from, valid_to
       FROM identity.guardian_contact WHERE valid_from > $1 OR (valid_to IS NOT NULL AND valid_to <= $1)
     UNION ALL
     SELECT 'ops.contact_authorization' src, contact_token token, valid_from, valid_to
       FROM ops.contact_authorization WHERE valid_from > $1 OR (valid_to IS NOT NULL AND valid_to <= $1)`,
    [at.toISOString()])).rows;

const seededWindows = async () =>
  (await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM identity.guardian_contact)
          + (SELECT count(*) FROM ops.contact_authorization) AS n`, [])).rows[0].n;

describe("fixture validity windows are cut from the pinned test clock", () => {
  it("contain the scenario's message with the machine's clock a year ahead of it", async () => {
    // Two children and a second guardian, so every fixture that writes a window writes one here:
    // seedPersona's contact and authorization, the sibling's authorization, seedSecondGuardian's.
    sc = await seedAgentScenario(db, { children: 2 });
    await seedSecondGuardian(db, {
      siteId: sc.siteId, familyGroupId: sc.familyGroupId, childToken: sc.children[0],
      number: F2_NUMBER, now: sc.receivedAt,
    });

    expect(Number(await seededWindows())).toBe(5);
    expect(await windowsMissing(sc.receivedAt)).toEqual([]);
    // And the machine's clock really is a year on, so this is not a vacuous pass.
    expect(new Date().getUTCFullYear()).toBe(A_YEAR_AHEAD.getUTCFullYear());
    expect((await db.query<{ n: Date }>("SELECT now() n", [])).rows[0].n.getUTCFullYear())
      .toBe(A_YEAR_AHEAD.getUTCFullYear());
  });

  it("let a multi-step run resolve its sender, write, and send — not stop after one step", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = liveHarness({
    gateway: GATEWAY,
      db,
      script: [
        toolCall("resolve_sender", { message_id: sc.messageId }),
        toolCall("get_leg_state", { leg_id: sc.legs[child].AM }),
        toolCall("cancel_attendance_or_leg", {
          child_token: child, date: sc.serviceDate, day_part: "AM",
          reason_code: "FAMILY_REQUEST", expected_self_arrival: "09:30", expected_version: 1,
        }),
        toolCall("send_followup", {
          audience: "GUARDIAN_OF_CHILD", subject_token: child,
          template_id: "leg.canceled", vars: { legDate: sc.serviceDate, reasonCode: "FAMILY_REQUEST" },
        }),
        toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian canceled a ride" }),
      ],
      facts: {
        t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
        t2: `service_date=${sc.serviceDate}`,
        t3: ["wont need the AM van, dropping at 9:30"],
        t4: "channel=SMS locale=en-US",
      },
      policy: {
        scope: sc.scope,
        sendableSubjects: new Set([sc.threadId, ...sc.children]),
        sourceMessageId: sc.messageId,
      },
      overrides: { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) },
      now: () => now,
    });
    const r = await h.start({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 5]);
    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => c.status)).toEqual(["EXECUTED", "EXECUTED", "EXECUTED", "EXECUTED", "EXECUTED"]);
    expect(calls[0].result).toMatchObject({ sender_known: true });

    // The send side reads the same windows back at the pinned clock when the outbox re-checks
    // egress, so a drifted fixture would be blocked here even if the run had got this far.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([sc.contactToken]);
  });
});
