import { beforeEach, describe, expect, it } from "vitest";
import { runAfterCommit, type Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { cronAuthorized } from "@/lib/cron-auth";
import { FakeTransport } from "./fake-transport";
import { VercelQueueScheduler, MAX_ATTEMPTS } from "./scheduler";
import { fire, handleWake, renewLease, sweep, type FireOpts, type Handlers } from "./runner";
import { LEASE_SECONDS, REWAKE_DELAY_SECONDS, REWAKE_MARGIN_MS, RETRY_MAX_SECONDS, redeliveryDelaySeconds, rewakeDelaySeconds } from "./scheduler";

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
const leaseUntil = async (id: string) =>
  new Date((await db.query<{ claimed_until: Date }>("SELECT claimed_until FROM ops.job WHERE id=$1", [id])).rows[0].claimed_until).getTime();

beforeEach(async () => {
  ({ db } = await freshDb()); t = new FakeTransport(); now = new Date(); s = new VercelQueueScheduler(db, t, clock); calls.length = 0;
}, 60_000);

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
    const wakes = [...t.sent, ...t.sent].reverse();
    await Promise.all(wakes.map((w) => handleWake(db, { jobId: w.jobId }, "d1", handlers, clock)));
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
    for (const r of onTime) expect(r.late).toBeLessThanOrEqual(NFR03_SECONDS);

    // Re-wake early (Veri #10, blocker 1): it re-publishes for the rest of the lease + margin, so recovery costs
    // one more hop (whole-second queue delay + jitter) instead of falling back to the 1-minute sweep.
    const early: Row[] = [];
    for (const [j1, j2, e] of [[0, 0, 0.001], [0.25, 0.25, 0.8], [0.5, 0.5, 0.8], [1, 1, 0.001], [1, 1, 0.25], [1, 1, 0.75], [1, 1, 0.8], [1, 1, 1]]) early.push(await killAfterClaim(j1, j2, e));
    for (const r of early) expect(r.late).toBeCloseTo(r.j1 + LEASE_SECONDS - r.earlyBy + rewakeDelaySeconds(r.earlyBy * 1000) + r.j2, 3);

    const all = [...onTime, ...early];
    const worst = Math.max(...all.map((r) => r.late));
    console.log([
      "| first delivery jitter | re-wake arrives early by | re-wake jitter | lateness |",
      "|---|---|---|---|",
      ...all.map((r) => `| ${r.j1} s | ${r.earlyBy ? `${r.earlyBy} s` : "–"} | ${r.j2} s | ${r.late.toFixed(3)} s |`),
      `lease ${LEASE_SECONDS} s, re-wake margin ${REWAKE_MARGIN_MS} ms, whole-second queue delays, jitter ≤ ${MAX_JITTER} s per delivery`,
      `worst-case lateness ${worst.toFixed(3)} s → margin ${(NFR03_SECONDS - worst).toFixed(3)} s under the ${NFR03_SECONDS} s NFR-03 bar`,
      `(the re-wake-at-expiry path is ${Math.max(...onTime.map((r) => r.late)).toFixed(3)} s at ${MAX_JITTER} s jitter; the early path costs one more whole-second hop)`,
    ].join("\n"));
    // Analytic bound for the early path: j1 + lease − ε + ceil(ε + margin) + j2, worst just above ε = 1 s − margin.
    expect(worst).toBeLessThanOrEqual(LEASE_SECONDS + 2 * MAX_JITTER + 1 + REWAKE_MARGIN_MS / 1000);
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
    expect(t.sent).toEqual([{ jobId: id, dueAt: expect.any(String), delaySeconds: rewakeDelaySeconds(1), idempotencyKey: `rewake:${token}:${now.toISOString()}` }]);

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
    const { pg } = await freshDb();
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

  it("a deferred re-wake waits the remaining lease plus the margin, in whole seconds, at least 1 s", () => {
    expect(rewakeDelaySeconds(-5)).toBe(1);
    expect(rewakeDelaySeconds(1)).toBe(1);
    expect(rewakeDelaySeconds(750)).toBe(1);
    expect(rewakeDelaySeconds(800)).toBe(2); // 0.8 s + 250 ms margin, rounded up
    expect(rewakeDelaySeconds(LEASE_SECONDS * 1000)).toBe(LEASE_SECONDS + 1);
  });
});
