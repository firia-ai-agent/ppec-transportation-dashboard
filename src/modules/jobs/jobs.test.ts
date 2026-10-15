import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAfterCommit, type Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { cronAuthorized } from "@/lib/cron-auth";
import { FakeTransport } from "./fake-transport";
import { TIMER_TOPIC } from "./vercel-queue";
import { VercelQueueScheduler, MAX_ATTEMPTS } from "./scheduler";
import { claimForWake, fire, handleWake, renewLease, sweep, type FireOpts, type Handlers } from "./runner";
import { EARLY_SLACK_MS, LEASE_SECONDS, MAX_DELAY_SECONDS, MAX_DELIVERIES, QUEUE_RETRY_AFTER_SECONDS, QUEUE_VISIBILITY_TIMEOUT_SECONDS, REWAKE_DELAY_SECONDS, REWAKE_MARGIN_MS, RETRY_MAX_SECONDS, delayFor, queueRetryDirective, redeliveryDelaySeconds, rewakeDelaySeconds, staleWake } from "./scheduler";

let db: Db; let t: FakeTransport; let now: Date; let s: VercelQueueScheduler;
const clock = () => now;
const at = (secs: number) => new Date(now.getTime() + secs * 1000);
const calls: string[] = [];
const handlers: Handlers = {
  "noop.test": async (_tx, job) => { calls.push(job.key); },
  "boom.test": async () => { throw new Error("boom"); },
};
const state = async (key: string) => (await db.query<{ state: string; attempts: number }>("SELECT state, attempts FROM ops.job WHERE key=$1 ORDER BY created_at DESC LIMIT 1", [key])).rows[0];
const fires = async (id: string) => (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.job_fire_log WHERE job_id=$1", [id])).rows[0].n;
const sched = (key: string, inSecs: number, kind = "noop.test") =>
  db.tx((tx, ac) => s.schedule(tx, ac, { siteId: SITE, key, kind, payload: {}, dueAt: at(inSecs), by: "test" }));
/** The process dying after the claim: nothing after the claim runs in that invocation (test seam, FireOpts.isFatal). */
class SimulatedCrash extends Error {}
const kill: Pick<FireOpts, "isFatal"> = { isFatal: (e) => e instanceof SimulatedCrash };
/** Report lines that must be visible in a plain `pnpm test` run (see the call site for why not console.log). */
const print = (lines: string[]) => process.stdout.write(`${lines.join("\n")}\n`);
const leaseUntil = async (id: string) =>
  new Date((await db.query<{ claimed_until: Date }>("SELECT claimed_until FROM ops.job WHERE id=$1", [id])).rows[0].claimed_until).getTime();

/** Every PGlite opened by a test, closed after it: each instance holds its own WASM heap, so leaking ~30 of them into one vitest worker gets the worker OOM-killed. */
const open: PGlite[] = [];
const openDb = async () => { const h = await freshDb(); open.push(h.pg); return h; };

beforeEach(async () => {
  ({ db } = await openDb()); t = new FakeTransport(); now = new Date(); s = new VercelQueueScheduler(db, t, clock); calls.length = 0;
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((pg) => pg.close().catch(() => {})));
});

describe("JobScheduler (ADR-001)", () => {
  it("writes the row in the caller's tx and publishes only after commit", async () => {
    const { id } = await sched("a", 30);
    expect(t.sent).toEqual([expect.objectContaining({ jobId: id, delaySeconds: 30 })]);
    await expect(db.tx(async (tx, ac) => { await s.schedule(tx, ac, { siteId: SITE, key: "rb", kind: "noop.test", payload: {}, dueAt: at(5), by: "t" }); throw new Error("rollback"); })).rejects.toThrow();
    expect(t.sent.length).toBe(1);
    expect(await state("rb")).toBeUndefined();
  });
  it("live key is unique; cancel makes the wake a no-op", async () => {
    const { id } = await sched("k", 0);
    await expect(sched("k", 10)).rejects.toThrow();
    expect(await db.tx((tx) => s.cancel(tx, "k", "t"))).toBe(1);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("noop");
    expect(calls).toEqual([]);
  });
  it("early wake no-ops; due wake fires once; duplicate wake no-ops", async () => {
    const { id } = await sched("x", 10);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("noop");
    now = at(10);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("fired");
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("noop");
    expect(await fires(id)).toBe(1);
    expect((await state("x")).state).toBe("DONE");
  });
  it("a first wake delivered early re-publishes itself for the rest of the wait, and that wake fires the job", async () => {
    // The job's only wake-up would otherwise be acked away as `not-due`: `arm` has already set
    // wake_published_at, so the sweeper's re-arm pass skips the row and nothing fires it until the overdue
    // pass, > 5 s past due on a 60 s cron. Same answer as an early re-wake: one hop of remaining + margin.
    const { id } = await sched("early-first", 10);
    t.sent.length = 0;
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock, { transport: t })).toBe("early-deferred");
    expect(calls).toEqual([]);
    expect((await state("early-first")).state).toBe("SCHEDULED");
    // The re-published wake carries the row's own generation, so it fences exactly like the original.
    expect(t.sent).toEqual([{ jobId: id, dueAt: at(10).toISOString(), version: 1,
      delaySeconds: rewakeDelaySeconds(10_000), idempotencyKey: `early:${id}:${now.toISOString()}` }]);

    now = at(t.sent[0].delaySeconds);
    expect(await handleWake(db, t.sent[0], "d1", handlers, clock, { transport: t })).toBe("fired");
    expect(await fires(id)).toBe(1);
  });
  it("a delivery inside the claim slack still claims; one just outside it is deferred, not dropped", async () => {
    const { id } = await sched("slack", EARLY_SLACK_MS / 1000);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock, { transport: t })).toBe("fired");

    const { id: id2 } = await sched("slack2", EARLY_SLACK_MS / 1000 + 0.001);
    expect(await handleWake(db, { jobId: id2 }, "d1", handlers, clock, { transport: t })).toBe("early-deferred");
  });
  it("an early wake with no transport clears the wake marker, so the next sweep re-arms the job", async () => {
    const { id } = await sched("early-noarm", 120);
    const armed = async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.job WHERE id=$1 AND wake_published_at IS NOT NULL", [id])).rows[0].n;
    expect(await armed()).toBe(1);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("noop");
    expect(await armed()).toBe(0); // without it, sweep step 4 (wake_published_at IS NULL) would skip the row
    expect((await sweep(db, t, "d1", handlers, clock)).republished).toBe(1);
    expect(t.sent.at(-1)).toMatchObject({ jobId: id, delaySeconds: 120 });
  });
  it("an early wake for a superseded generation is dropped, not re-published", async () => {
    const { id } = await sched("early-stale", 10);
    const stale = t.sent.at(-1)!;
    await db.tx((tx, ac) => s.reschedule(tx, ac, "early-stale", at(30), "t"));
    t.sent.length = 0;
    expect(await handleWake(db, stale, "d1", handlers, clock, { transport: t })).toBe("noop");
    expect(t.sent).toEqual([]); // the reschedule armed the live wake; this one must not circle on top of it
  });
  it("reschedule moves due_at; the old wake no-ops", async () => {
    const { id } = await sched("r", 5);
    await db.tx((tx, ac) => s.reschedule(tx, ac, "r", at(60), "t"));
    now = at(5);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("noop");
    expect(t.sent.at(-1)).toMatchObject({ jobId: id, delaySeconds: 60 });
  });
});

describe("failures, leases, sweeper", () => {
  it("handler error retries; DEAD after 5 attempts with a RED task", async () => {
    const { id } = await sched("b", 0, "boom.test");
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = await fire(db, id, "d1", handlers, "QUEUE", clock);
      expect(r).toBe(i < MAX_ATTEMPTS ? "failed" : "dead");
    }
    expect(await state("b")).toMatchObject({ state: "DEAD", attempts: MAX_ATTEMPTS });
    const task = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.task WHERE category='TIMER_DEAD' AND severity='RED'", []);
    expect(task.rows[0].n).toBe(1);
  });
  it("crash after claim (lease expires) is reclaimed and fires exactly once", async () => {
    const { id } = await sched("c", 0);
    await db.query("UPDATE ops.job SET state='CLAIMED', claimed_by='dead-consumer', claimed_until=$2 WHERE id=$1", [id, at(60).toISOString()]);
    expect((await sweep(db, t, "d1", handlers, clock)).reclaimed).toBe(0); // lease still valid
    now = at(61);
    const rep = await sweep(db, t, "d1", handlers, clock);
    expect(rep.reclaimed).toBe(1);
    expect(rep.fired).toBe(1); // overdue, so the same sweep fires it via the claim
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("noop");
    expect(await fires(id)).toBe(1);
  });
  it("lost wake-up (publish failed) is re-published by the sweeper", async () => {
    t.failNext = 1;
    const { id } = await sched("lost", 120);
    expect(t.sent.length).toBe(0);
    const rep = await sweep(db, t, "d1", handlers, clock);
    expect(rep.republished).toBe(1);
    expect(t.sent[0]).toMatchObject({ jobId: id });
  });
  it("deployment pinning: old deployment acks without claiming; new deployment's first sweep re-arms all", async () => {
    await sweep(db, t, "d1", handlers, clock);
    const a = await sched("p1", 30); const b = await sched("p2", 90);
    t.sent.length = 0;
    const rep = await sweep(db, t, "d2", handlers, clock);
    expect(rep).toMatchObject({ activated: true, rearmed: 2, republished: 2 });
    now = at(30);
    expect(await handleWake(db, { jobId: a.id }, "d1", handlers, clock)).toBe("inactive-deployment");
    expect(await handleWake(db, { jobId: a.id }, "d2", handlers, clock)).toBe("fired");
    expect((await sweep(db, t, "d2", handlers, clock)).activated).toBe(false);
    expect(b.id).toBeTruthy();
  });
});

describe("local TEST-INF-01 shape (not the recorded runs)", () => {
  it("50 jobs, 10 on the same second, 5 canceled, every wake delivered twice out of order → 45 DONE, 0 duplicates", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push((await sched(`t${i}`, i < 10 ? 60 : 60 + ((i * 7) % 180))).id);
    for (const i of [3, 14, 22, 37, 49]) await db.tx((tx) => s.cancel(tx, `t${i}`, "t"));
    now = at(241);
    // Deliver the real messages (fence included), twice each and in reverse order: the at-least-once +
    // unordered contract, end to end.
    const wakes = [...t.sent, ...t.sent].reverse();
    await Promise.all(wakes.map((w) => handleWake(db, w, "d1", handlers, clock)));
    const r = await db.query<{ state: string; n: number }>("SELECT state, count(*)::int n FROM ops.job GROUP BY state ORDER BY state::text", []);
    expect(r.rows).toEqual([{ state: "CANCELED", n: 5 }, { state: "DONE", n: 45 }]);
    const dup = await db.query<{ n: number }>("SELECT count(*)::int n FROM (SELECT job_id FROM ops.job_fire_log GROUP BY job_id HAVING count(*) > 1) d", []);
    expect(dup.rows[0].n).toBe(0);
  });
});

describe("cron auth fails closed", () => {
  const secret = "x".repeat(32);
  it.each([
    [null, secret, false], [`Bearer ${secret}`, undefined, false], [`Bearer ${secret}`, "short", false],
    ["Bearer wrong", secret, false], [`Bearer ${secret}`, secret, true],
  ])("header %s secret-set %s → %s", (h, s2, ok) => expect(cronAuthorized(h as string | null, s2 as string | undefined)).toBe(ok));
});

describe("Option A: short lease + re-wake at lease expiry (kill-after-claim)", () => {
  const due = 10; // job due 10 s after the row's base time
  const NFR03_SECONDS = 5; // PRD NFR-03: fire within 5 s of due (TEST-INF-01 crash paths)
  const MAX_JITTER = 1; // s of queue delivery jitter assumed per delivery
  const ms = (secs: number) => Math.round(secs * 1000); // keep the fake clock on whole milliseconds
  type Row = { j1: number; j2: number; earlyBy: number; late: number };

  /**
   * One kill-after-claim run on its own job row: the first wake arrives at due+j1 and the consumer dies after
   * claiming; the re-wake is delivered `earlyBy` s *before* the lease expires (0 = at expiry) and j2 s after
   * whatever delay it asked for. Returns the measured lateness (`fired_at - due_at`).
   */
  async function killAfterClaim(j1: number, j2: number, earlyBy = 0): Promise<Row> {
    const base = now; const key = `kac-${j1}-${j2}-${earlyBy}`;
    const { id } = await sched(key, due);
    let crashed = false; let firedAt: Date | null = null;
    const hs: Handlers = { "noop.test": async () => {
      if (!crashed) { crashed = true; throw new SimulatedCrash("process killed after claim"); }
      firedAt = new Date(now);
    } };
    const opts: FireOpts = { transport: t, ...kill };
    const rewakes = () => t.sent.filter((m) => m.jobId === id && m.idempotencyKey.startsWith("rewake:"));

    now = new Date(base.getTime() + ms(due + j1));
    const claimedAt = now;
    await expect(handleWake(db, { jobId: id }, "d1", hs, clock, opts)).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await state(key)).state).toBe("CLAIMED");
    expect(rewakes()).toEqual([expect.objectContaining({ delaySeconds: REWAKE_DELAY_SECONDS })]);

    // Redelivery of the ORIGINAL message mid-lease must not double-claim; it re-publishes itself instead of no-op.
    now = new Date(claimedAt.getTime() + (LEASE_SECONDS * 1000) / 2);
    expect(await handleWake(db, { jobId: id }, "d1", hs, clock, opts)).toBe("rewake-deferred");
    expect(rewakes().at(-1)?.delaySeconds).toBe(rewakeDelaySeconds((LEASE_SECONDS * 1000) / 2));

    let deliveredAt = new Date(claimedAt.getTime() + ms(REWAKE_DELAY_SECONDS + j2));
    if (earlyBy > 0) {
      // The re-wake lands before the lease expires (queue jitter, or skew between the two instances' clocks).
      now = new Date(claimedAt.getTime() + ms(REWAKE_DELAY_SECONDS - earlyBy));
      expect(await handleWake(db, { jobId: id }, "d1", hs, clock, opts)).toBe("rewake-deferred");
      expect((await state(key)).state).toBe("CLAIMED"); // not reclaimed, not run
      const republished = rewakes().at(-1);
      expect(republished?.delaySeconds).toBe(rewakeDelaySeconds(earlyBy * 1000));
      deliveredAt = new Date(now.getTime() + ms((republished?.delaySeconds ?? 0) + j2));
    }
    now = deliveredAt;
    expect(await handleWake(db, { jobId: id }, "d1", hs, clock, opts)).toBe("fired");
    expect(await fires(id)).toBe(1);
    const late = ((firedAt as unknown as Date).getTime() - (base.getTime() + ms(due))) / 1000;
    now = new Date(base.getTime() + 3_600_000); // the next row runs an hour later, on its own job row
    return { j1, j2, earlyBy, late };
  }

  it("recovers a killed consumer and fires once, both when the re-wake lands at expiry and when it lands early", async () => {
    // Re-wake at or after lease expiry: the published delay is the whole lease, so recovery is j1 + lease + j2.
    const onTime: Row[] = [];
    for (const [j1, j2] of [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]]) onTime.push(await killAfterClaim(j1, j2));
    for (const r of onTime) expect(r.late).toBeLessThan(NFR03_SECONDS);

    // Re-wake early (Veri #10, blocker 1): it re-publishes for the rest of the lease + margin, so recovery costs
    // one more hop instead of falling back to the 1-minute sweep. With sub-second delays (ledger row 58) that
    // hop is exactly the margin + jitter, not the margin rounded up to the next whole second.
    const early: Row[] = [];
    for (const [j1, j2, e] of [[0, 0, 0.001], [0.25, 0.25, 0.5], [0.5, 0.5, 0.75], [1, 1, 0.001], [1, 1, 0.25], [1, 1, 0.5], [1, 1, 0.75], [1, 1, 1]]) early.push(await killAfterClaim(j1, j2, e));
    for (const r of early) expect(r.late).toBeCloseTo(r.j1 + LEASE_SECONDS - r.earlyBy + rewakeDelaySeconds(r.earlyBy * 1000) + r.j2, 3);
    for (const r of early) expect(r.late).toBeLessThan(NFR03_SECONDS);

    const all = [...onTime, ...early];
    const worst = Math.max(...all.map((r) => r.late));
    // Straight to stdout, not console.log: vitest's default reporter drops intercepted console output from
    // *passing* tests when stdout is not a TTY (i.e. in CI), and this table is the deliverable of the test.
    print([
      "| first delivery jitter | re-wake arrives early by | re-wake jitter | lateness |",
      "|---|---|---|---|",
      ...all.map((r) => `| ${r.j1} s | ${r.earlyBy ? `${r.earlyBy} s` : "–"} | ${r.j2} s | ${r.late.toFixed(3)} s |`),
      `lease ${LEASE_SECONDS} s, re-wake margin ${REWAKE_MARGIN_MS} ms, sub-second (ms-precision) queue delays, jitter ≤ ${MAX_JITTER} s per delivery, early arrival ≤ ${MAX_JITTER} s`,
      `worst-case lateness ${worst.toFixed(3)} s → margin ${(NFR03_SECONDS - worst).toFixed(3)} s under the ${NFR03_SECONDS} s NFR-03 bar`,
      `(the re-wake-at-expiry path is ${Math.max(...onTime.map((r) => r.late)).toFixed(3)} s at ${MAX_JITTER} s jitter; the early path costs exactly one re-wake margin more)`,
      `sub-second delaySeconds is Unverified until a live TEST-INF-01 run (GET /api/probe/delay → topic ppec-delay-probe); if Queues floors it, revert to the 3 s lease proposed for ledger row 38 (PR #10, closed)`,
    ]);
    // Analytic bound for the early path: j1 + lease − ε + (ε + margin) + j2 = j1 + j2 + lease + margin, for any ε.
    expect(worst).toBeLessThanOrEqual(LEASE_SECONDS + 2 * MAX_JITTER + REWAKE_MARGIN_MS / 1000);
  }, 180_000);

  it("a re-wake 1 ms early re-publishes itself for the remaining lease + margin, and that wake reclaims and runs the job", async () => {
    const { id } = await sched("early", 0);
    const opts: FireOpts = { transport: t, ...kill };
    await expect(handleWake(db, { jobId: id }, "d1", { "noop.test": async () => { throw new SimulatedCrash("killed"); } }, clock, opts))
      .rejects.toBeInstanceOf(SimulatedCrash);
    const token = (await db.query<{ claimed_by: string }>("SELECT claimed_by FROM ops.job WHERE id=$1", [id])).rows[0].claimed_by;
    t.sent.length = 0;

    now = at(REWAKE_DELAY_SECONDS - 0.001); // 1 ms before the lease expires: reclaim would match 0 rows
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock, opts)).toBe("rewake-deferred");
    expect((await state("early")).state).toBe("CLAIMED");
    expect(calls).toEqual([]);
    // The re-published wake carries the claimed row's own generation, so it fences exactly like the original.
    expect(t.sent).toEqual([{ jobId: id, dueAt: expect.any(String), version: 1, delaySeconds: rewakeDelaySeconds(1), idempotencyKey: `rewake:${token}:${now.toISOString()}` }]);

    now = at(REWAKE_DELAY_SECONDS - 0.001 + t.sent[0].delaySeconds);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock, opts)).toBe("fired");
    expect(calls).toEqual(["early"]);
    expect(await fires(id)).toBe(1);
    expect((await state("early")).state).toBe("DONE");
  });

  it("claim tokens differ per claim, so a reclaimed consumer's DONE (WHERE claimed_by = its token) matches 0 rows", async () => {
    const { id } = await sched("fence", 0);
    const crash: Handlers = { "noop.test": async () => { throw new SimulatedCrash("killed"); } };
    await expect(fire(db, id, "d1", crash, "QUEUE", clock, { transport: t, ...kill })).rejects.toBeInstanceOf(SimulatedCrash);
    const a = (await db.query<{ claimed_by: string }>("SELECT claimed_by FROM ops.job WHERE id=$1", [id])).rows[0].claimed_by;
    now = at(REWAKE_DELAY_SECONDS);
    await expect(handleWake(db, { jobId: id }, "d1", crash, clock, { transport: t, ...kill })).rejects.toBeInstanceOf(SimulatedCrash);
    const b = (await db.query<{ claimed_by: string }>("SELECT claimed_by FROM ops.job WHERE id=$1", [id])).rows[0].claimed_by;
    expect(a).not.toBe(b); expect(a.startsWith("d1:")).toBe(true);
    const stale = await db.query("UPDATE ops.job SET state='DONE' WHERE id=$1 AND state='CLAIMED' AND claimed_by=$2 RETURNING id", [id, a]);
    expect(stale.rows.length).toBe(0);
  });

  it("handler failure: job back to SCHEDULED, and a redelivered message fires it", async () => {
    const { id } = await sched("redeliver", 0);
    let n = 0; const flaky: Handlers = { "noop.test": async () => { if (n++ === 0) throw new Error("transient"); } };
    expect(await handleWake(db, { jobId: id }, "d1", flaky, clock, { transport: t })).toBe("failed");
    expect((await state("redeliver")).state).toBe("SCHEDULED");
    expect(await handleWake(db, { jobId: id }, "d1", flaky, clock, { transport: t })).toBe("fired");
  });
});

describe("lease renewal for slow handlers (Veri #10, point 2)", () => {
  it("renewLease pushes claimed_until out, and only for the claim that owns the row", async () => {
    const { id } = await sched("renew", 0);
    await db.query("UPDATE ops.job SET state='CLAIMED', claimed_by='tok-1', claimed_until=$2 WHERE id=$1", [id, at(LEASE_SECONDS).toISOString()]);
    expect(await renewLease(db, id, "tok-1", at(2))).toBe(true);
    expect(await leaseUntil(id)).toBe(at(2 + LEASE_SECONDS).getTime());
    expect(await renewLease(db, id, "tok-2", at(2))).toBe(false); // fenced out: not this consumer's claim
    expect(await leaseUntil(id)).toBe(at(2 + LEASE_SECONDS).getTime());
  });

  it("a handler slower than the lease renews it: no reclaim, no second run, one fire", async () => {
    // PGlite is a single connection, so the renewal — which in production runs on its own pooled connection
    // (ADR-009) — cannot query while a real transaction is open. This Db runs the handler's statements directly
    // instead of inside BEGIN/COMMIT: this test is about the lease, atomicity is covered by the tests above.
    const { pg } = await openDb();
    const q: Db["query"] = async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] });
    db = { query: q, tx: async (fn) => { const hooks: (() => Promise<void>)[] = []; const r = await fn({ query: q }, (h) => hooks.push(h)); await runAfterCommit(hooks); return r; } };
    s = new VercelQueueScheduler(db, t, clock);

    const { id } = await sched("slow", 0);
    let release = () => {}; const blocked = new Promise<void>((res) => { release = res; });
    let runs = 0;
    const slow: Handlers = { "noop.test": async () => { runs++; await blocked; } };
    const running = fire(db, id, "d1", slow, "QUEUE", clock, { transport: t, renewEveryMs: 10 });

    // Past the original lease: a renewal must have pushed claimed_until out again by itself.
    now = at(LEASE_SECONDS + 1);
    const giveUp = Date.now() + 10_000;
    while ((await leaseUntil(id)) <= now.getTime() && Date.now() < giveUp) await new Promise((r) => setTimeout(r, 10));
    expect(await leaseUntil(id)).toBe(now.getTime() + LEASE_SECONDS * 1000); // renewed from the current clock

    // The re-wake armed at claim time now finds a live (renewed) lease, so it defers instead of reclaiming.
    expect(await handleWake(db, { jobId: id }, "d1", slow, clock, { transport: t })).toBe("rewake-deferred");
    expect(t.sent.at(-1)?.delaySeconds).toBe(rewakeDelaySeconds(LEASE_SECONDS * 1000));
    expect(runs).toBe(1);

    release();
    expect(await running).toBe("fired");
    expect(runs).toBe(1);
    expect(await fires(id)).toBe(1);
    expect((await state("slow")).state).toBe("DONE");
  }, 30_000);

  it("a claim taken over mid-handler abandons the commit (renewal and DONE are fenced by the same token)", async () => {
    const { id } = await sched("stolen", 0);
    const hs: Handlers = { "noop.test": async (tx) => { // another consumer takes the row over mid-handler
      await tx.query("UPDATE ops.job SET claimed_by='someone-else' WHERE id=$1", [id]);
    } };
    expect(await fire(db, id, "d1", hs, "QUEUE", clock, { transport: t })).toBe("failed");
    expect(await fires(id)).toBe(0);
    expect((await db.query<{ claimed_by: string }>("SELECT claimed_by FROM ops.job WHERE id=$1", [id])).rows[0].claimed_by).toMatch(/^d1:/); // the handler's write rolled back
  });
});

describe("queue redelivery backoff (route.ts; Veri #10, point 3)", () => {
  it.each([[1, 2], [2, 4], [3, 8], [4, 16], [5, 32], [6, RETRY_MAX_SECONDS], [50, RETRY_MAX_SECONDS]])(
    "delivery %i → redelivery after %i s", (n, secs) => expect(redeliveryDelaySeconds(n)).toBe(secs));

  it("a deferred re-wake waits the remaining lease plus the margin, to the millisecond (ledger row 58)", () => {
    expect(rewakeDelaySeconds(-5)).toBe(REWAKE_MARGIN_MS / 1000); // expired lease: just the margin
    expect(rewakeDelaySeconds(1)).toBe(0.251);
    expect(rewakeDelaySeconds(750)).toBe(1);
    expect(rewakeDelaySeconds(800)).toBe(1.05); // 0.8 s + 250 ms margin, no rounding up to 2 s
    expect(rewakeDelaySeconds(1.2)).toBe(0.252); // sub-millisecond remainder still rounds up to a whole ms
    expect(rewakeDelaySeconds(LEASE_SECONDS * 1000)).toBe(LEASE_SECONDS + REWAKE_MARGIN_MS / 1000);
  });

  it("the wake published at schedule time keeps millisecond precision", () => {
    expect(delayFor(new Date(1_000), new Date(0))).toBe(1);
    expect(delayFor(new Date(1_250), new Date(0))).toBe(1.25);
    expect(delayFor(new Date(0), new Date(1_250))).toBe(0); // already due
    expect(delayFor(new Date(MAX_DELAY_SECONDS * 2000), new Date(0))).toBe(MAX_DELAY_SECONDS);
  });
});

describe("handler idempotency at fire time (DECISION-LEDGER row 58; at-least-once, unordered, no delay SLA)", () => {
  /** The message Queues would actually deliver for the last wake published: {jobId, dueAt, version}. */
  const lastWake = () => t.sent.at(-1)!;
  const row = async (id: string) => (await db.query<{ state: string; version: number; due_at: Date }>("SELECT state, version, due_at FROM ops.job WHERE id=$1", [id])).rows[0];

  it("duplicate delivery of one message fires exactly once, concurrently or in sequence", async () => {
    const { id } = await sched("dup", 0);
    const m = lastWake();
    const rs = await Promise.all([handleWake(db, m, "d1", handlers, clock), handleWake(db, m, "d1", handlers, clock), handleWake(db, m, "d1", handlers, clock)]);
    expect(rs.filter((r) => r === "fired").length).toBe(1);
    // Everything else acks: a duplicate is expected traffic on an at-least-once queue, not an error.
    expect(rs.filter((r) => r === "failed" || r === "dead").length).toBe(0);
    expect(await handleWake(db, m, "d1", handlers, clock)).toBe("noop"); // and once more, after it is DONE
    expect(calls).toEqual(["dup"]);
    expect(await fires(id)).toBe(1);
  });

  it("an out-of-order older version is dropped: the pre-reschedule wake cannot fire the rescheduled job", async () => {
    const { id } = await sched("ooo", 5);
    const stale = lastWake(); // version 1, due at +5 s
    await db.tx((tx, ac) => s.reschedule(tx, ac, "ooo", at(60), "t"));
    const current = lastWake(); // version 2, due at +60 s
    expect([stale.version, current.version]).toEqual([1, 2]);

    // Delivered *after* the new due time, so without the fence the old message would fire the job here.
    now = at(61);
    expect(await handleWake(db, stale, "d1", handlers, clock)).toBe("noop");
    expect(calls).toEqual([]);
    expect(await fires(id)).toBe(0);
    expect((await row(id)).state).toBe("SCHEDULED");

    // The current generation fires, and the stale message stays dropped afterwards.
    expect(await handleWake(db, current, "d1", handlers, clock)).toBe("fired");
    expect(await handleWake(db, stale, "d1", handlers, clock)).toBe("noop");
    expect(calls).toEqual(["ooo"]);
    expect(await fires(id)).toBe(1);
  });

  it("a wake whose version is ahead of the row is dropped (replay or forged message), not fired", async () => {
    const { id } = await sched("ahead", 0);
    const m = lastWake();
    expect(await handleWake(db, { ...m, version: m.version + 7 }, "d1", handlers, clock)).toBe("noop");
    expect(calls).toEqual([]);
    expect((await row(id)).state).toBe("SCHEDULED"); // still live: the real wake can still fire it
    expect(await handleWake(db, m, "d1", handlers, clock)).toBe("fired");
  });

  it("a cancelled job is dropped, even though cancel bumped the version past the in-flight wake", async () => {
    const { id } = await sched("canc", 0);
    const m = lastWake();
    expect(await db.tx((tx) => s.cancel(tx, "canc", "t"))).toBe(1);
    expect((await row(id)).version).toBe(m.version + 1); // the wake is behind, which is not what drops it
    expect(await handleWake(db, m, "d1", handlers, clock)).toBe("noop");
    expect(calls).toEqual([]);
    expect(await fires(id)).toBe(0);
    expect((await row(id)).state).toBe("CANCELED");
  });

  it("an already-sent job is dropped: the second delivery never reaches the handler", async () => {
    const { id } = await sched("sent", 0);
    const m = lastWake();
    expect(await handleWake(db, m, "d1", handlers, clock)).toBe("fired");
    expect((await row(id)).state).toBe("DONE");
    for (let i = 0; i < 3; i++) expect(await handleWake(db, m, "d1", handlers, clock)).toBe("noop");
    expect(calls).toEqual(["sent"]); // exactly one handler run
    expect(await fires(id)).toBe(1);
  });

  it("redelivery after a crash mid-lease still fires exactly once (the reclaim's version bump must not fence it out)", async () => {
    const { id } = await sched("crash", 0);
    const m = lastWake();
    const opts: FireOpts = { transport: t, ...kill };
    const crash: Handlers = { "noop.test": async () => { throw new SimulatedCrash("process killed after claim"); } };
    await expect(handleWake(db, m, "d1", crash, clock, opts)).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await row(id)).state).toBe("CLAIMED");

    // Redelivery while the lease is still live: no second claim, no handler run.
    now = at(LEASE_SECONDS / 2);
    expect(await handleWake(db, m, "d1", handlers, clock, opts)).toBe("rewake-deferred");
    expect(calls).toEqual([]);

    // Redelivery of that same message once the lease has lapsed: reclaim (version 1 → 2) and fire. The message
    // still carries version 1, so this is the case a `version !== row.version` fence would have broken.
    now = at(LEASE_SECONDS);
    expect(await handleWake(db, m, "d1", handlers, clock, opts)).toBe("fired");
    expect((await row(id)).version).toBeGreaterThan(m.version);
    for (let i = 0; i < 3; i++) expect(await handleWake(db, m, "d1", handlers, clock, opts)).toBe("noop");
    expect(calls).toEqual(["crash"]);
    expect(await fires(id)).toBe(1);
  });

  it("claimForWake reports the specific refusal, and only a live due generation is claimed", async () => {
    const { id } = await sched("why", 0);
    const m = lastWake();
    const tok = (n: string) => `d1:${n}`;
    const fence = { dueAt: m.dueAt, version: m.version };

    expect(await claimForWake(db, "00000000-0000-7000-8000-00000000dead", tok("a"), now, fence)).toEqual({ ok: false, reason: "missing" });
    expect(await claimForWake(db, id, tok("b"), now, { dueAt: at(999).toISOString() })).toEqual({ ok: false, reason: "superseded" });
    expect(await claimForWake(db, id, tok("c"), now, { version: m.version + 1 })).toEqual({ ok: false, reason: "superseded" });
    expect(await claimForWake(db, id, tok("d"), at(-10), fence)).toEqual({ ok: false, reason: "not-due" }); // >1 s early

    const won = await claimForWake(db, id, tok("e"), now, fence);
    expect(won).toMatchObject({ ok: true, job: { id, key: "why", version: m.version } });
    expect(await claimForWake(db, id, tok("f"), now, fence)).toEqual({ ok: false, reason: "claimed" });

    await db.query("UPDATE ops.job SET state='DONE' WHERE id=$1", [id]);
    expect(await claimForWake(db, id, tok("g"), now, fence)).toEqual({ ok: false, reason: "already-done" });
    await db.query("UPDATE ops.job SET state='CANCELED' WHERE id=$1", [id]);
    expect(await claimForWake(db, id, tok("h"), now, fence)).toEqual({ ok: false, reason: "cancelled" });
    await db.query("UPDATE ops.job SET state='DEAD' WHERE id=$1", [id]);
    expect(await claimForWake(db, id, tok("i"), now, fence)).toEqual({ ok: false, reason: "dead" });
  });

  it("a wake with no fence (published before the fence existed) is still honoured", async () => {
    const { id } = await sched("legacy", 0);
    expect(await handleWake(db, { jobId: id }, "d1", handlers, clock)).toBe("fired");
    expect(await fires(id)).toBe(1);
  });
});

describe("staleWake / queue bounds (pure)", () => {
  const due = "2026-10-14T18:00:00.000Z";
  const r = { due_at: new Date(due), version: 4 };

  it.each([
    ["no fence at all", {}, false],
    ["same generation", { dueAt: due, version: 4 }, false],
    ["version behind the row (a retry of the same firing: reclaim or post-failure redelivery)", { dueAt: due, version: 1 }, false],
    ["version ahead of the row (replay or forged)", { dueAt: due, version: 5 }, true],
    ["due_at moved (rescheduled)", { dueAt: "2026-10-14T19:00:00.000Z", version: 4 }, true],
    ["due_at moved earlier, version behind", { dueAt: "2026-10-14T17:00:00.000Z", version: 1 }, true],
    ["dueAt only, matching", { dueAt: due }, false],
    ["version only, behind", { version: 2 }, false],
  ])("%s → stale %s", (_why, fence, stale) => expect(staleWake(r, fence)).toBe(stale));

  it("the retry directive backs off, then acknowledges at MAX_DELIVERIES (no maxDeliveries option exists)", () => {
    expect(queueRetryDirective(1)).toEqual({ afterSeconds: 2 });
    expect(queueRetryDirective(MAX_DELIVERIES - 1)).toEqual({ afterSeconds: RETRY_MAX_SECONDS });
    expect(queueRetryDirective(MAX_DELIVERIES)).toEqual({ acknowledge: true });
    expect(queueRetryDirective(MAX_DELIVERIES + 50)).toEqual({ acknowledge: true });
  });

  it("the timer trigger in vercel.json carries the lease as its retryAfterSeconds", () => {
    expect(QUEUE_RETRY_AFTER_SECONDS).toBe(LEASE_SECONDS);
    // vercel.json cannot import the constant, so pin the two together here instead of letting them drift.
    const vercelJson = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "vercel.json"), "utf8")) as
      { functions: Record<string, { experimentalTriggers?: { topic: string; retryAfterSeconds?: number }[] }> };
    const trigger = vercelJson.functions["src/app/api/queues/timer/route.ts"].experimentalTriggers?.[0];
    expect(trigger).toMatchObject({ topic: TIMER_TOPIC, retryAfterSeconds: QUEUE_RETRY_AFTER_SECONDS });

    // The visibility timeout, by contrast, *cannot* match the lease: 30 s is @vercel/queue 0.8.0's documented
    // floor (`@minimum 30`), so the 5 s recovery rests on our own re-wake, not on queue redelivery.
    expect(QUEUE_VISIBILITY_TIMEOUT_SECONDS).toBe(30);
    expect(QUEUE_VISIBILITY_TIMEOUT_SECONDS).toBeGreaterThan(LEASE_SECONDS);
  });
});
