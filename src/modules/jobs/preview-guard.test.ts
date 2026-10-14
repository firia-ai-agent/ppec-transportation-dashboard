import { afterEach, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { rewriteBeginReadOnly } from "@/db/read-only";
import type { Db, Exec } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { FakeTransport } from "./fake-transport";
import { VercelQueueScheduler, MAX_ATTEMPTS } from "./scheduler";
import { fire, handleWake, renewLease, sweep, type Handlers } from "./runner";

/**
 * Every statement the timer module sends has to survive the preview read-only guard (src/db/read-only.ts,
 * DECISION-LEDGER #43), which previews put in front of every query. The guard refuses multi-statement
 * strings, `SET`/`RESET`/`set_config`/`DO`/`DISCARD`/`CALL`, and caller-sent transaction control — the
 * framing is the guard's own. Previews never run timers (`previewSkip` in the cron and queue routes), so
 * this is a belt-and-braces check: it fails the moment someone writes a timer statement that could not be
 * sent through the guard, which is also the shape that would smuggle a second statement past it.
 *
 * The statements are collected by driving the real code paths, not by reading the source, so a new query
 * anywhere in schedule/claim/fire/renew/reclaim/sweep is covered the day it is written.
 */
const open: PGlite[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((pg) => pg.close().catch(() => {}))); });

function recording(base: Db, sent: string[]): Db {
  const wrap = (e: Exec): Exec => ({
    query: (sql, params) => { sent.push(sql); return e.query(sql, params); },
  });
  return { query: wrap(base).query, tx: (fn) => base.tx((tx, afterCommit) => fn(wrap(tx), afterCommit)) };
}

it("every statement the timer module sends passes the preview read-only guard", async () => {
  const h = await freshDb();
  open.push(h.pg);
  const sent: string[] = [];
  const db = recording(h.db, sent);
  const t = new FakeTransport();
  let now = new Date();
  const clock = () => now;
  const s = new VercelQueueScheduler(db, t, clock);
  const at = (secs: number) => new Date(now.getTime() + secs * 1000);
  const sched = (key: string, inSecs: number, kind = "noop.test") =>
    db.tx((tx, ac) => s.schedule(tx, ac, { siteId: SITE, key, kind, payload: {}, dueAt: at(inSecs), by: "test" }));
  const handlers: Handlers = { "noop.test": async () => {}, "boom.test": async () => { throw new Error("boom"); } };

  // Schedule → arm → claim → handler → DONE → fire log.
  const { id } = await sched("guard-fire", 0);
  expect(await fire(db, id, "d1", handlers, "QUEUE", clock, { transport: t })).toBe("fired");

  // Early first delivery: the deferred re-publish, and the wake-marker reset on its no-transport path.
  const { id: early } = await sched("guard-early", 30);
  expect(await handleWake(db, { jobId: early }, "d1", handlers, clock, { transport: t })).toBe("early-deferred");
  expect(await handleWake(db, { jobId: early }, "d1", handlers, clock)).toBe("noop");

  // Cancel and reschedule.
  const { id: resch } = await sched("guard-reschedule", 30);
  await db.tx((tx, ac) => s.reschedule(tx, ac, "guard-reschedule", at(60), "t"));
  await db.tx((tx) => s.cancel(tx, "guard-reschedule", "t"));
  expect(await handleWake(db, { jobId: resch }, "d1", handlers, clock)).toBe("noop");

  // Handler failure → attempts, last_error, DEAD + RED task.
  const { id: boom } = await sched("guard-boom", 0, "boom.test");
  for (let i = 0; i < MAX_ATTEMPTS; i++) await fire(db, boom, "d1", handlers, "QUEUE", clock);

  // Lease renewal (both the matching and the fenced-out spelling) and a reclaim through the sweeper.
  const { id: lease } = await sched("guard-lease", 0);
  await db.query("UPDATE ops.job SET state='CLAIMED', claimed_by='tok', claimed_until=$2 WHERE id=$1", [lease, at(1).toISOString()]);
  expect(await renewLease(db, lease, "tok", now)).toBe(true);
  expect(await renewLease(db, lease, "other", now)).toBe(false);
  now = at(600);
  const rep = await sweep(db, t, "d2", handlers, clock); // new deployment id: also exercises the marker + re-arm
  expect(rep.reclaimed + rep.fired).toBeGreaterThan(0);

  expect(sent.length).toBeGreaterThan(20);
  for (const sql of sent) {
    // Not refused (no second statement, no SET/CALL/DO, no COMMIT/ROLLBACK/BEGIN of the caller's own) …
    expect(() => rewriteBeginReadOnly(sql, { inTransaction: true }), sql).not.toThrow();
    // … and returned untouched: a rewrite would mean the timer code had opened a transaction itself.
    expect(rewriteBeginReadOnly(sql, { inTransaction: true })).toBe(sql);
  }
}, 60_000);
