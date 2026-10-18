import { describe, expect, it } from "vitest";
import type { Exec } from "@/domain/transition";
import { readDayFacts } from "./day-facts";
import { deriveReadiness } from "./readiness";

/**
 * THE LOADER'S THREE READS, with a stand-in for the database.
 *
 * `readDayFacts` takes an `Exec` on purpose — the seam its own comment names — so what the step
 * strip is built from can be checked without a connection: which statements run, in which case,
 * against which rows, and what happens when one of them fails. The derivation they feed is
 * tested exhaustively beside this (readiness.test.ts); this is about the going-and-getting.
 *
 * Three properties, and each one is a rule somebody could break by accident:
 *  1. **Nothing is written.** Every statement is a `SELECT`. A loader that a screen calls on
 *     every render must not be able to change the day it is reporting.
 *  2. **The bench is counted on the plan that was found**, scoped by the site as well — a plan
 *     id from somewhere else cannot be used to count another centre's children (DATA-MODEL §5).
 *  3. **A failed count is `null`, not zero** (Vera, 2026-10-17 8:46 PM ET). Zero is "everybody
 *     has a ride", which is the one answer that ticks the card, so it may never be what a
 *     failure decays into — while the facts that *were* read still stand, so the live map stays
 *     unlocked on a plan that exists (§9.1).
 */
const SITE = "00000000-0000-7000-8000-000000000001";
const DATE = "2026-10-17";
const SAVED_AT = "2026-10-17T18:41:00Z";
const PLAN_ID = "01900000-0000-7000-8000-0000000000a1";

/** A database that answers each statement by its first table, and records what it was asked. */
function execOf(answers: {
  vans?: { vans: number; checked: number };
  plan?: { id: string; saved_at: string } | null;
  unplaced?: number | Error;
}): Exec & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    async query<R>(statement: string, values: unknown[]): Promise<{ rows: R[] }> {
      sql.push(statement);
      params.push(values);
      if (statement.includes("ops.vehicle")) {
        return { rows: [answers.vans ?? { vans: 3, checked: 0 }] as R[] };
      }
      if (statement.includes("ops.plan_run")) {
        const plan = answers.plan === undefined ? null : answers.plan;
        return { rows: (plan ? [plan] : []) as R[] };
      }
      if (statement.includes("ops.plan_assignment")) {
        if (answers.unplaced instanceof Error) throw answers.unplaced;
        return { rows: [{ unplaced: answers.unplaced ?? 0 }] as R[] };
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
  };
}

describe("the day's facts, as the loader reads them", () => {
  it("writes nothing: every statement is a SELECT", async () => {
    const exec = execOf({ plan: { id: PLAN_ID, saved_at: SAVED_AT }, unplaced: 2 });
    await readDayFacts(exec, SITE, DATE, "PM");
    expect(exec.sql).toHaveLength(3);
    for (const statement of exec.sql) {
      expect(statement.trim().toUpperCase().startsWith("SELECT"), statement).toBe(true);
      expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    }
  });

  it("reads the vans and the plan, and counts no bench when there is no plan", async () => {
    const exec = execOf({ vans: { vans: 3, checked: 2 }, plan: null });
    const facts = await readDayFacts(exec, SITE, DATE, "AM");
    expect(facts).toEqual({
      date: DATE,
      leg: "AM",
      read: true,
      vans: 3,
      vansChecked: 2,
      planSavedAt: null,
      planUnplaced: null,
    });
    // Two statements, not three: there is no board to count children on.
    expect(exec.sql).toHaveLength(2);
    expect(exec.sql.some((s) => s.includes("ops.plan_assignment"))).toBe(false);
  });

  it("counts the UNASSIGNED bucket of the plan it found, scoped by the site", async () => {
    const exec = execOf({ plan: { id: PLAN_ID, saved_at: SAVED_AT }, unplaced: 2 });
    const facts = await readDayFacts(exec, SITE, DATE, "PM");
    expect(facts.planUnplaced).toBe(2);
    expect(facts.planSavedAt).toEqual(new Date(SAVED_AT));

    const bench = exec.sql.findIndex((s) => s.includes("ops.plan_assignment"));
    expect(bench).toBeGreaterThan(-1);
    expect(exec.sql[bench]).toContain("bucket = 'UNASSIGNED'");
    // The plan's own id and the caller's site, in that order.
    expect(exec.params[bench]).toEqual([PLAN_ID, SITE]);
  });

  it("reports an empty bench as zero, which is the only answer that is Done", async () => {
    const exec = execOf({ plan: { id: PLAN_ID, saved_at: SAVED_AT }, unplaced: 0 });
    const facts = await readDayFacts(exec, SITE, DATE, "PM");
    expect(facts.planUnplaced).toBe(0);
    expect(deriveReadiness(facts).plan.state).toBe("DONE");
  });

  /**
   * The contained failure: the count throws, the two reads before it stand, and the day comes
   * back "saved, bench unknown" — which is Needed on the plan and an unlocked live map.
   */
  it("answers null when the bench cannot be counted, and keeps the rest of the day", async () => {
    const exec = execOf({
      vans: { vans: 3, checked: 3 },
      plan: { id: PLAN_ID, saved_at: SAVED_AT },
      unplaced: new Error("relation does not exist"),
    });
    const facts = await readDayFacts(exec, SITE, DATE, "PM");
    expect(facts.planUnplaced).toBeNull();
    expect(facts.planSavedAt).toEqual(new Date(SAVED_AT));
    expect(facts.vansChecked).toBe(3);

    const day = deriveReadiness(facts);
    expect(day.setup.state).toBe("DONE");
    expect(day.plan.state, "a count that failed must not tick the card").toBe("NEEDED");
    expect(day.live.state, "the plan is still saved, so the map is still open").toBe("NEEDED");
  });

  /** A plan read that throws is not contained: the caller's own fail-safe takes the whole day. */
  it("lets a failure of the first two reads reach the caller", async () => {
    const exec: Exec = {
      async query() {
        throw new Error("no database here");
      },
    };
    await expect(readDayFacts(exec, SITE, DATE, "PM")).rejects.toThrow("no database here");
  });
});
