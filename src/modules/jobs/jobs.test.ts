import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { cronAuthorized } from "@/lib/cron-auth";
import { FakeTransport } from "./fake-transport";
import { VercelQueueScheduler, MAX_ATTEMPTS } from "./scheduler";
import { fire, handleWake, sweep, type Handlers } from "./runner";

let pg: PGlite; let db: Db; let t: FakeTransport; let now: Date; let s: VercelQueueScheduler;
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

beforeEach(async () => {
  ({ pg, db } = await freshDb()); t = new FakeTransport(); now = new Date(); s = new VercelQueueScheduler(db, t, clock); calls.length = 0;
}, 60_000);

// One PGlite per test adds up: close it, or the worker is killed part-way through the file.
afterEach(async () => { await pg.close(); });

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
