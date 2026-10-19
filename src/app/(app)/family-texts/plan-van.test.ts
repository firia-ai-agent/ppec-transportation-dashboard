import { describe, expect, it } from "vitest";
import { DEMO_SITE_ID, childTokenOf, runOfChild, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { afternoonVanOf } from "./plan-van";

/**
 * With no plan saved, the van is the day's own run — the rule Today applies too. (After a save it
 * is the saved plan's van; that half is walked against a database by the browser check.)
 */
describe("afternoonVanOf", () => {
  it("names the fixture run's van, with the riders on that run, when nobody has saved a plan", async () => {
    const run = runOfChild("C2")!;
    const found = await afternoonVanOf(DEMO_SITE_ID, childTokenOf("C2"));
    expect(found?.van.id).toBe(vehicleIdOf(run.vehicleKey));
    expect(found?.aboard.map((r) => r.token).sort()).toEqual(run.childKeys.map(childTokenOf).sort());
  });

  it("names no van for a child the roster does not have", async () => {
    expect(await afternoonVanOf(DEMO_SITE_ID, "00000000-0000-7000-8000-00000000dead")).toBeNull();
  });
});
