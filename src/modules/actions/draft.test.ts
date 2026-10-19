import { describe, expect, it } from "vitest";
import { autoPlan, emptyPlan } from "@/domain/plan/board";
import { vansOver } from "@/modules/plan/place";
import { testDay } from "@/test/board-day";
import { smallestReplan } from "./draft";

/**
 * A re-plan moves the children the problem is about, not the whole leg (ledger #76): a colleague
 * would not reshuffle eight families to fix one van.
 */
const moved = (before: Record<string, { bucket: string; vanId: string | null }>, after: typeof before) =>
  Object.keys(after).filter((t) => before[t]?.bucket !== after[t]?.bucket || before[t]?.vanId !== after[t]?.vanId);

describe("smallestReplan", () => {
  it("moves only who no longer fits, and every van fits after", async () => {
    const normal = await testDay("PM");
    const plan = autoPlan(normal, emptyPlan(normal));
    const short = await testDay("PM", { 1: { oxygenMounts: 0 } });
    const next = smallestReplan(short, plan);
    const changed = moved(plan, next);
    const zoe = short.riders.find((r) => r.name.startsWith("Zoe"))!;
    expect(changed).toEqual([zoe.token]);
    expect(next[zoe.token].bucket).toBe("VAN");
    expect(vansOver({ day: short } as never, next)).toEqual([]);
  });

  it("leaves a child no van can carry without a van, rather than pretending", async () => {
    const normal = await testDay("PM");
    const plan = autoPlan(normal, emptyPlan(normal));
    const none = await testDay("PM", { 1: { oxygenMounts: 0 }, 2: { oxygenMounts: 0 }, 3: { oxygenMounts: 0 } });
    const next = smallestReplan(none, plan);
    const zoe = none.riders.find((r) => r.name.startsWith("Zoe"))!;
    expect(next[zoe.token].bucket).toBe("UNASSIGNED");
  });
});
