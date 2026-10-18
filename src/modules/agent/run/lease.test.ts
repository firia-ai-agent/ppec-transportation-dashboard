/**
 * The per-run lease (PR #35 review **F2**), proved the only way a claim can be: by putting two
 * drivers on one run and insisting that exactly one of them drives it.
 *
 * Four things are asserted here, and they are the four the lease exists for:
 *
 *   1. **Two drivers, one winner.** The loser is refused `leased` before it takes a model turn, and
 *      the run's effects happen once — which they did before the lease too (the `(run_id, seq)`
 *      index and the idempotency key), so what is new is the *turn* that is no longer wasted.
 *   2. **An expired lease is reclaimable.** A driver that died holds its claim until it runs out,
 *      and then the next one takes the run over and finishes it.
 *   3. **A lease is released on park, on success and on failure** — and by `releaseRunLease` while
 *      the run is still RUNNING, which is the case the expiry would otherwise have to cover.
 *   4. **The site fence (F3).** A run of another tenant is refused without being read into, let
 *      alone driven: a run id on a queue payload is not an authorization.
 *
 * `freshDb()` is PGlite, which serialises transactions on its one connection, so `Promise.all` over
 * two claims exercises the compare-and-set rather than a true wall-clock race. That is the whole
 * point of the `SELECT … FOR UPDATE` + CAS shape (`claimForWake`'s): correctness does not depend on
 * which of the two the scheduler ran first, so neither does the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import { loadAgentConfig } from "../config";
import { toolCall } from "../providers/fake";
import {
  AGENT_RUN_LEASE_SECONDS,
  acquireRunLease,
  driveRunLeased,
  isLeaseActor,
  leaseClaimedAt,
  leaseToken,
  releaseRunLease,
  runLeaseHolder,
} from "./lease";
import {
  AT01_EXECUTORS, AT01_FACTS, AT01_NOTE, AT01_SCRIPT, at01Policy, runHarness,
} from "./harness";
import { loadRun, runActor, startRun, toolCalls } from "./store";
import type { Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };
/** Routing as the row records it. Both values come from config — see no-hardcoded-models.test.ts. */
const ROUTING = { model: loadAgentConfig({}).model, provider: loadAgentConfig({}).provider };
/** A second tenant, for the fence. Same string the other run-loop suites use. */
const OTHER_SITE = "00000000-0000-7000-8000-0000000000ff";

let pg: PGlite;
let db: Db;
let now: Date;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

/** The AT-01 run, three steps and done. */
const at01 = () =>
  runHarness({
    db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(),
    overrides: AT01_EXECUTORS, now: () => now,
  });

const seconds = (n: number) => new Date(now.getTime() + n * 1000);

describe("F2: one driver at a time", () => {
  it("two drivers on one run: one claims it, the other is refused, and the effects happen once", async () => {
    const h = at01();
    const { runId } = await startRun(db, TRIGGER, ROUTING);

    const [a, b] = await Promise.all([
      driveRunLeased(h.deps(0), runId, { siteId: SITE }),
      driveRunLeased(h.deps(0), runId, { siteId: SITE }),
    ]);

    const [winner, loser] = a.claimed ? [a, b] : [b, a];
    expect([winner.claimed, loser.claimed]).toEqual([true, false]);
    if (!winner.claimed || loser.claimed) throw new Error("unreachable");

    // The winner drove the whole run; the loser was told why, by name.
    expect([winner.result.state, winner.result.steps, winner.reclaimed]).toEqual(["SUCCEEDED", 3, false]);
    expect(loser.reason).toBe("leased");
    expect(loser.heldUntil!.toISOString()).toBe(seconds(AGENT_RUN_LEASE_SECONDS).toISOString());

    // One effect per step, once — and, the part the lease adds, three model turns and not six.
    expect(h.recorder.intents.map((i) => i.tool)).toEqual([
      "get_leg_state", "cancel_attendance_or_leg", "summarize_thread_for_staff",
    ]);
    expect((await toolCalls(db, runId)).map((c) => [c.seq, c.status])).toEqual([[0, "EXECUTED"], [1, "EXECUTED"], [2, "EXECUTED"]]);
    expect(h.gateways.map((g) => g.auditLog.length).sort()).toEqual([0, 3]);
  });

  it("the refusal names the state it found: a finished run, a parked one, an unknown one", async () => {
    const h = at01();
    const finished = await h.start(TRIGGER);
    expect(finished.state).toBe("SUCCEEDED");

    expect(await acquireRunLease(db, finished.runId, { siteId: SITE, now })).toEqual({
      ok: false, reason: "finished", state: "SUCCEEDED",
    });
    expect(await acquireRunLease(db, "00000000-0000-7000-8000-00000000dead", { siteId: SITE, now })).toEqual({
      ok: false, reason: "missing",
    });

    // §11.1: a parked run is re-triggered by its own timer, so a delivery that arrives while it
    // waits must not claim it — the claim would be the waiting session the PRD forbids.
    const parked = await parkedRun();
    expect(await acquireRunLease(db, parked, { siteId: SITE, now })).toEqual({
      ok: false, reason: "parked", state: "WAITING_TOOL",
    });
  });

  it("a live lease is not reclaimable, an expired one is — and the reclaiming driver finishes the run", async () => {
    const h = at01();
    const { runId } = await startRun(db, TRIGGER, ROUTING);

    // A driver claims the run and then dies without releasing anything.
    const dead = await acquireRunLease(db, runId, { siteId: SITE, now });
    expect(dead.ok).toBe(true);

    // One second short of the lease: still theirs.
    const early = await acquireRunLease(db, runId, { siteId: SITE, now: seconds(AGENT_RUN_LEASE_SECONDS - 1) });
    expect(early).toMatchObject({ ok: false, reason: "leased", state: "RUNNING" });

    // One second past it: the claim is gone, and the run is driven to its end by whoever asks next.
    now = seconds(AGENT_RUN_LEASE_SECONDS + 1);
    const taken = await driveRunLeased(h.deps(0), runId, { siteId: SITE });
    expect(taken).toMatchObject({ claimed: true, reclaimed: true });
    if (!taken.claimed) throw new Error("unreachable");
    expect([taken.result.state, taken.result.steps]).toEqual(["SUCCEEDED", 3]);
    expect(h.recorder.intents).toHaveLength(3);
  });

  /**
   * The loop's own half of the fence (`loop.ts`, before every turn). A driver whose lease lapsed
   * and was reclaimed mid-drive must stop at the next turn rather than keep spending model turns
   * on a run it no longer holds — and it must not be able to release the new holder's claim.
   *
   * Remove the `live.updatedBy !== actor` check from loop.ts and this test fails: the first driver
   * takes a second turn on somebody else's run.
   */
  it("a driver whose lease was reclaimed mid-drive stops at the next turn, and cannot release the new claim", async () => {
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    const reclaimAt = seconds(AGENT_RUN_LEASE_SECONDS + 1);
    const stolen = leaseToken(runId, reclaimAt, "the-reclaimer");
    const mine = leaseToken(runId, now, "mine");

    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), now: () => now,
      overrides: {
        ...AT01_EXECUTORS,
        // Step 0's effect happens, and while it does the lease runs out and another driver takes
        // the run over. Nothing tells this driver; it finds out at the top of the next turn.
        get_leg_state: async (call) => {
          now = reclaimAt;
          expect(await acquireRunLease(db, runId, { siteId: SITE, now, token: stolen })).toMatchObject({
            ok: true, reclaimed: true,
          });
          return AT01_EXECUTORS.get_leg_state!(call);
        },
      },
    });

    const r = await driveRunLeased(h.deps(0), runId, { siteId: SITE, leaseSeconds: AGENT_RUN_LEASE_SECONDS });
    expect(r).toMatchObject({ claimed: true });
    if (!r.claimed) throw new Error("unreachable");

    expect([r.result.steps, r.result.reason]).toEqual([1, "run was reclaimed by another driver"]);
    // One model turn, one effect: the second turn was never taken.
    expect(h.gateways.at(-1)!.auditLog.map((a) => a.tool)).toEqual(["get_leg_state"]);
    expect(h.recorder.intents.map((i) => i.tool)).toEqual(["get_leg_state"]);
    // The release was fenced out, and the run is still the reclaimer's.
    expect(r.released).toBe(false);
    expect((await runLeaseHolder(db, runId, { siteId: SITE, now }))!.by).toBe(stolen);
    expect(await releaseRunLease(db, { runId, siteId: SITE, token: mine, version: 1, expiresAt: now })).toBe(false);
  });
});

describe("F2: the lease is released when the drive ends", () => {
  it("a run that succeeded holds no lease, and the next delivery is refused `finished` rather than `leased`", async () => {
    const h = at01();
    const { runId } = await startRun(db, TRIGGER, ROUTING);

    const r = await driveRunLeased(h.deps(0), runId, { siteId: SITE });
    expect(r).toMatchObject({ claimed: true, released: true });
    expect(await runLeaseHolder(db, runId, { siteId: SITE, now })).toBeNull();
    // The holder slot is back to the run's own actor: a lease, released, leaves no trace of itself.
    expect((await loadRun(db, runId))!.updatedBy).toBe(runActor(runId));
    expect(await acquireRunLease(db, runId, { siteId: SITE, now })).toMatchObject({ reason: "finished" });
  });

  it("a run that failed holds no lease", async () => {
    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), now: () => now,
      overrides: { ...AT01_EXECUTORS, get_leg_state: async () => ({ status: "failed", data: { error_code: "NOPE" } }) },
    });
    const { runId } = await startRun(db, TRIGGER, ROUTING);

    const r = await driveRunLeased(h.deps(0), runId, { siteId: SITE });
    expect(r).toMatchObject({ claimed: true, released: true });
    if (!r.claimed) throw new Error("unreachable");
    expect(r.result.state).toBe("FAILED");
    expect(await runLeaseHolder(db, runId, { siteId: SITE, now })).toBeNull();
  });

  it("a run parked on a timer holds no lease: the timer is what comes back for it", async () => {
    const h = parkingHarness();
    const { runId } = await startRun(db, TRIGGER, ROUTING);

    const r = await driveRunLeased(h.deps(0), runId, { siteId: SITE });
    expect(r).toMatchObject({ claimed: true, released: true });
    if (!r.claimed) throw new Error("unreachable");
    expect(r.result.state).toBe("WAITING_TOOL");
    expect(await runLeaseHolder(db, runId, { siteId: SITE, now })).toBeNull();
  });

  it("a release while the run is still RUNNING hands it straight to the next driver", async () => {
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    const got = await acquireRunLease(db, runId, { siteId: SITE, now });
    if (!got.ok) throw new Error("unreachable");

    expect(await releaseRunLease(db, got.lease)).toBe(true);
    // No waiting out the lease: the very next claim, at the same instant, wins.
    const next = await acquireRunLease(db, runId, { siteId: SITE, now });
    expect(next).toMatchObject({ ok: true, reclaimed: false });
    // And the released claim cannot be released twice, so a stale driver frees nobody.
    expect(await releaseRunLease(db, got.lease)).toBe(false);
  });
});

describe("F3: the lease is site-fenced", () => {
  it("a run of another site is refused, and neither claimed nor driven", async () => {
    const h = at01();
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    const before = await loadRun(db, runId);

    // No state and no holder come back with the refusal: the row is another tenant's, so nothing
    // about it crosses the fence — a refusal that could be told apart from "no such run" would be
    // an existence oracle (policy.ts step 7).
    expect(await driveRunLeased(h.deps(0), runId, { siteId: OTHER_SITE })).toEqual({
      claimed: false, reason: "wrong-site", state: undefined, heldUntil: undefined,
    });

    // Untouched, down to its version: the refusal happens before anything is written.
    expect(await loadRun(db, runId)).toEqual(before);
    expect(h.gateways.at(-1)!.auditLog).toEqual([]);
    expect(await toolCalls(db, runId)).toEqual([]);
  });

  it("a lease held in this site is invisible to another, and cannot be released from it", async () => {
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    const got = await acquireRunLease(db, runId, { siteId: SITE, now });
    if (!got.ok) throw new Error("unreachable");

    expect(await runLeaseHolder(db, runId, { siteId: OTHER_SITE, now })).toBeNull();
    expect(await releaseRunLease(db, { ...got.lease, siteId: OTHER_SITE })).toBe(false);
    // Still held here, by the same token.
    expect((await runLeaseHolder(db, runId, { siteId: SITE, now }))!.by).toBe(got.lease.token);
  });
});

describe("the holder slot", () => {
  it("a claim token is recognisable as one, carries when it was taken, and an ordinary run actor is not", () => {
    const token = leaseToken("r1", now, "n1");
    expect(token).toBe(`${runActor("r1")}:lease:n1@${now.toISOString()}`);
    expect([isLeaseActor(token), isLeaseActor(runActor("r1")), isLeaseActor(null)]).toEqual([true, false, false]);
    // The deadline is read back out of the token, not off `updated_at`, so no write renews a claim.
    expect(leaseClaimedAt(token)!.toISOString()).toBe(now.toISOString());
    expect(leaseClaimedAt(`${runActor("r1")}:lease:n1@not-a-date`)).toBeNull();
    // Two claims on one run are never the same string — which is what lets a release be fenced.
    expect(leaseToken("r1", now)).not.toBe(leaseToken("r1", now));
  });

  it("an unleased drive leaves the slot free, so the lease sees a crashed run as reclaimable", async () => {
    // `driveRun` without a lease (every suite but this one, and the in-process callers) stamps the
    // run's own actor, which is not a claim: a run left RUNNING by one of those is free to claim.
    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), now: () => now,
      overrides: {
        ...AT01_EXECUTORS,
        cancel_attendance_or_leg: async () => { throw new Error("process died"); },
      },
      isFatal: (e) => e instanceof Error && e.message === "process died",
    });
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    await expect(h.drive(runId)).rejects.toThrow("process died");

    const left = await loadRun(db, runId);
    expect([left!.state, left!.updatedBy]).toEqual(["RUNNING", runActor(runId)]);
    expect(await runLeaseHolder(db, runId, { siteId: SITE, now })).toBeNull();
    expect(await acquireRunLease(db, runId, { siteId: SITE, now })).toMatchObject({ ok: true, reclaimed: false });
  });
});

/* ───────────────────────────────── fixtures ───────────────────────────────── */

/** A run whose one step parks it on a §11.1 await timer. */
function parkingHarness() {
  return runHarness({
    db,
    script: [
      /*
       * `notify_affected_therapist` rather than `request_clarification`: S1-7 (Firia,
       * 2026-10-18) moved the clarification to the `human` tier, so the loop never calls an
       * executor for it and it cannot park anything. What this fixture needs is any auto-tier
       * send that awaits an answer, and this is one the AT-01 scope already reaches.
       */
      toolCall("notify_affected_therapist", {
        therapy_session_token: "SESS-C1", child_token: "C1", impact: "LATE", eta: "09:30",
      }),
      AT01_NOTE,
    ],
    facts: AT01_FACTS,
    policy: at01Policy(),
    overrides: {
      notify_affected_therapist: async () => ({
        data: { would_send: "generic.notice" },
        awaitExternal: {
          reasonCode: "CLARIFICATION",
          afterSeconds: 15 * 60,
          summary: "Waiting for the therapist to answer",
          completionPredicate: "therapist reply acknowledges the change",
        },
      }),
      summarize_thread_for_staff: AT01_EXECUTORS.summarize_thread_for_staff,
    },
    now: () => now,
  });
}

/** A parked WAITING_TOOL run, through the ordinary path that parks one. */
async function parkedRun(): Promise<string> {
  const h = parkingHarness();
  const r = await h.start({ ...TRIGGER, id: "MSG-PARKED" });
  expect(r.state).toBe("WAITING_TOOL");
  return r.runId;
}
