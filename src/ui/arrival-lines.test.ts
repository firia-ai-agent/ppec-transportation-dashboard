import { describe, expect, it } from "vitest";
import {
  arrivalBannerLines,
  holdLines,
  laneVanName,
  moveLines,
  rideChangeLine,
  rideChangeState,
  stayLines,
  unplacedState,
} from "./arrival-lines";
import { boardArrival, replanForArrival, type RampFinding } from "@/domain/plan/arrival";
import { legStates } from "./states";
import { VEHICLES } from "@/modules/demo/fixtures/standard";

/**
 * The sentences one ramp check reaches three screens as.
 *
 * What is checked here is not the re-plan — src/domain/plan/arrival.test.ts does that — but the
 * words: that a child is named, that a van is named by what it is, that a hold says what is
 * missing and wears the state the day gives it, and that nothing the machine says to itself
 * reaches a line (a lane key, a place id, a configuration code, a deficit type, a verdict).
 */
const CONVERTIBLE = "V1";
const CENTER_VAN = "V2";

function finding(over: Partial<RampFinding> = {}): RampFinding {
  return {
    laneId: CONVERTIBLE,
    layoutCode: "1WC/3A",
    outOfService: [],
    unanswered: [],
    liftOk: true,
    latchOk: true,
    measured: [],
    ...over,
  };
}

/** Every vocabulary the build uses to talk to itself, as the patterns that would catch one. */
const INTERNALS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "a lane or van key", re: /\bV\d\b/ },
  { name: "a place id", re: /·[A-Z]\d|\/\d+WC/ },
  { name: "a configuration shorthand", re: /\d+WC\/\d+A/ },
  { name: "a solver verdict", re: /\b(?:FEASIBLE|INFEASIBLE|CAPABILITY_PENDING)\b/ },
  { name: "an enum code", re: /\b[A-Z][A-Z_]{3,}\b/ },
];

function assertPlain(lines: readonly string[]) {
  for (const line of lines) {
    for (const { name, re } of INTERNALS) {
      expect(re.test(line), `${line} leaks ${name}`).toBe(false);
    }
    // §1: a line on a screen is a sentence, and it ends like one.
    expect(line, line).toMatch(/[.?]$/);
  }
}

describe("two walking seats out of service: what the three screens say", () => {
  const replan = replanForArrival(finding({ outOfService: [3, 4] }));

  it("names the van by what it is, never by the key the day files it under", () => {
    expect(laneVanName(CENTER_VAN)).toBe("the center van");
    expect(laneVanName(CONVERTIBLE)).toBe("the convertible van");
  });

  it("says who moves, and to which van, in one sentence each", () => {
    expect(moveLines(replan).map((line) => line.text)).toEqual([
      "Owen C. moves to the center van.",
      "Ivy H. moves to the center van.",
    ]);
    assertPlain(moveLines(replan).map((line) => line.text));
  });

  it("says who keeps their seat, so the list accounts for every rider on the van", () => {
    const stays = stayLines(replan);
    expect(stays.map((line) => line.text)).toEqual(["Zoe B. keeps their seat."]);
    expect([...stays, ...moveLines(replan), ...holdLines(replan)]).toHaveLength(
      replan.before[CONVERTIBLE].length,
    );
  });

  it("gives a child who only changed van no state chip, because their state did not change", () => {
    for (const line of [...moveLines(replan), ...stayLines(replan)]) {
      expect(line.state).toBeUndefined();
    }
  });

  it("opens the banner on what happened, then on how many children it is about", () => {
    expect(arrivalBannerLines(replan)).toEqual([
      // Written for mid-sentence, and capitalised by the stylesheet, like every other van name.
      "the convertible van was checked at the ramp, and the afternoon is re-planned around it.",
      "2 moving to another van, 0 with no van.",
    ]);
    assertPlain(arrivalBannerLines(replan));
  });

  it("gives each board row the one thing that changed about that ride", () => {
    const changes = boardArrival(replan).changes;
    expect(rideChangeLine(changes.get("C7")!)).toBe("Moving to the center van after the ramp check.");
    expect(rideChangeLine(changes.get("C6")!)).toBe("Ramp staff have checked this van.");
    assertPlain([rideChangeLine(changes.get("C7")!), rideChangeLine(changes.get("C6")!)]);
    // A ride nobody had to move gets no chip: the van is checked, the ride is where it was.
    expect(rideChangeState(changes.get("C6")!)).toBeNull();
  });
});

describe("a van with no place for a chair: the child nobody can carry", () => {
  const replan = replanForArrival(finding({ layoutCode: "0WC/6A" }));
  const [hold] = holdLines(replan);

  it("says what is missing and names the child, never the rule that was broken", () => {
    expect(hold.text).toBe("No van with four-point straps for Zoe B.");
    expect(hold.childToken).toBe("C6");
    assertPlain([hold.text]);
  });

  it("wears a state, because a child with no van is a ride in a state", () => {
    expect(hold.state?.label).toBe("Doesn't fit");
  });

  it("counts the hold in the banner rather than hiding it behind the moves", () => {
    expect(arrivalBannerLines(replan)[1]).toBe("0 moving to another van, 1 with no van.");
  });

  it("says on the board that the ride has no van, with the state beside it", () => {
    const change = boardArrival(replan).changes.get("C6")!;
    expect(rideChangeLine(change)).toBe("No van after the ramp check.");
    expect(rideChangeState(change)).not.toBeNull();
  });
});

describe("a van that arrived as planned", () => {
  const replan = replanForArrival(finding());

  it("says so, and says nothing about moves it did not make", () => {
    expect(arrivalBannerLines(replan)).toEqual([
      "the convertible van was checked at the ramp and arrived as planned.",
    ]);
    expect(moveLines(replan)).toEqual([]);
    expect(holdLines(replan)).toEqual([]);
  });
});

describe("the state a full van's own exit wears", () => {
  /**
   * PRD l.750 and l.876 name one side exit for a child a van has no room for, and this is where
   * a screen picks it up: a van that fits the child and is full is that exit, and a van that is
   * not built for the child is a different fact and says a different thing.
   */
  it("is the leg machine's own, for the two causes that mean a van is full", () => {
    expect(unplacedState("VANS_FULL")).toBe(legStates.LEFT_BEHIND_CAPACITY);
    expect(unplacedState("NO_SEAT")).toBe(legStates.LEFT_BEHIND_CAPACITY);
  });

  it("is not that exit for a van that was never built for this child", () => {
    for (const cause of ["NO_SECUREMENT", "CHAIR_TOO_LARGE", "NO_WC_PLACE", "NO_LIFT"] as const) {
      expect(unplacedState(cause), cause).not.toBe(legStates.LEFT_BEHIND_CAPACITY);
    }
  });
});

describe("every van the day runs can be named", () => {
  it("has a plain description for each one, so no screen falls back to a key", () => {
    for (const vehicle of VEHICLES) {
      const named = laneVanName(vehicle.key);
      expect(named, vehicle.key).not.toMatch(/\bV\d\b/);
      expect(named.length, vehicle.key).toBeGreaterThan(0);
    }
  });
});
