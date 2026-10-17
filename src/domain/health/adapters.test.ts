import { describe, expect, it } from "vitest";
import { buildBoard } from "@/domain/board/board";
import { replayForVehicle, runOfChild } from "@/domain/board/scenario";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE } from "@/modules/agent/config";
import { ADAPTERS, adapterHealth, liveModelCallsRefused, type AdapterStatus } from "./adapters";

/**
 * SURF-06's panel: the mode each part of the system is in, and what it is doing on today's data.
 *
 * The assertion this file exists for is the first one: every row is mocked and `allMocked` is
 * true, **whatever the environment says**, so the screen cannot read as "everything is fine".
 * That is the point of the suite below titled "no environment can talk a row into saying Live":
 * each of the three has a mocked seam and no live one, so a mode read off a variable would be
 * able to print a green chip over a code path that does not exist.
 *
 * The rest hold the numbers: the agent row to the configuration it really is read from (that
 * module's own three-condition fail-shut guard), and the counts to the same board and the same
 * committed replays the Today screen reads.
 */

const BOARD = buildBoard();

/** The environment the demo deployment runs with (ADR-015 data class, ADR-014 demo switch). */
const DEMO_ENV: Record<string, string | undefined> = {
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
  DEMO_MODE: "1",
};

describe("the panel as the demo deployment reads it", () => {
  const health = adapterHealth(BOARD, DEMO_ENV);

  it("has one row per part of the system, in reading order", () => {
    expect(health.rows.map((r) => r.key)).toEqual([...ADAPTERS]);
  });

  it("says every row is mocked, so nothing on the screen can read as 'all fine'", () => {
    expect(health.allMocked).toBe(true);
    for (const row of health.rows) {
      expect(row.mode, row.key).toBe("MOCK");
      expect(row.mockedBecause, row.key).not.toBeNull();
    }
  });

  it("gives each mocked row its own reason, because the three are different facts", () => {
    expect(health.rows.map((r) => r.mockedBecause)).toEqual([
      "NO_CARRIER_ADAPTER",
      "REPLAYED_ROUTES",
      "NO_RUNNER",
    ]);
  });
});

describe("no environment can talk a row into saying Live", () => {
  /**
   * The environments a deployment could plausibly be in, including the ones a mode read off a
   * variable would have got wrong: the ADR-015 data class unset, the demo switch off, a basemap
   * configured, and the agent's own demo-data confirmation set.
   */
  const ENVIRONMENTS: Array<Record<string, string | undefined>> = [
    DEMO_ENV,
    {},
    { DEMO_MODE: "0" },
    { [DATA_CLASS_ENV_VAR]: "PHI" },
    { ...DEMO_ENV, NEXT_PUBLIC_MAP_TILE_URL: "https://tiles.example/style.json" },
    { ...DEMO_ENV, [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE },
    { ...DEMO_ENV, VERCEL_ENV: "production" },
  ];

  it("keeps every row mocked, with its own reason, in every one of them", () => {
    for (const env of ENVIRONMENTS) {
      const health = adapterHealth(BOARD, env);
      expect(health.allMocked, JSON.stringify(env)).toBe(true);
      expect(health.rows.map((r) => r.mode)).toEqual(["MOCK", "MOCK", "MOCK"]);
      expect(health.rows.map((r) => r.mockedBecause)).toEqual([
        "NO_CARRIER_ADAPTER",
        "REPLAYED_ROUTES",
        "NO_RUNNER",
      ]);
    }
  });

  it("still computes `allMocked` off the rows, so a live adapter changes the panel by itself", () => {
    const health = adapterHealth(BOARD, DEMO_ENV);
    expect(health.allMocked).toBe(true);
    // `allMocked` is a function of the rows and not a constant: shown by handing the same rule a
    // row in the other mode, which is what the first real adapter will be.
    const rows: readonly AdapterStatus[] = [{ ...health.rows[0], mode: "LIVE" }];
    expect(rows.every((r) => r.mode === "MOCK")).toBe(false);
  });
});

describe("whether a live model call would be allowed at all", () => {
  it("is refused with nothing set: the guard fails shut", () => {
    expect(liveModelCallsRefused({})).toBe(true);
  });

  it("is refused while the deployment has not confirmed demo-data-only operation", () => {
    expect(liveModelCallsRefused(DEMO_ENV)).toBe(true);
  });

  it("is allowed once all three of the guard's conditions hold", () => {
    expect(
      liveModelCallsRefused({
        ...DEMO_ENV,
        [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
      }),
    ).toBe(false);
  });

  it("is refused when the agent config cannot even be parsed", () => {
    // An unparseable config is certainly not one that may reach a vendor, so this answers
    // "refused" rather than throwing out of a health panel.
    expect(liveModelCallsRefused({ ...DEMO_ENV, AGENT_BASE_URL: "http://evil.example" })).toBe(
      true,
    );
  });

  it("is what the assistant row reports", () => {
    const refused = (env: Record<string, string | undefined>) =>
      adapterHealth(BOARD, env).rows.find((r) => r.key === "AGENT")?.facts.liveCallsRefused;
    expect(refused(DEMO_ENV)).toBe(1);
    expect(
      refused({ ...DEMO_ENV, [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE }),
    ).toBe(0);
  });
});

describe("what today's data says", () => {
  const rows = adapterHealth(BOARD, DEMO_ENV).rows;
  const row = (key: (typeof ADAPTERS)[number]) => {
    const found = rows.find((r) => r.key === key);
    if (!found) throw new Error(`no ${key} row`);
    return found;
  };

  /** The vans carrying a child on this board, from the same runs the board reads. */
  const vanKeys = [
    ...new Set(
      BOARD.legs.flatMap((leg) => {
        const run = runOfChild(leg.child.childKey);
        return run ? [run.vehicleKey] : [];
      }),
    ),
  ];

  it("counts the arrival changes the notify gate weighed up for a family, up to now", () => {
    const expected = vanKeys.reduce((total, key) => {
      const replay = replayForVehicle(key);
      if (!replay) return total;
      return (
        total +
        replay.decisions.filter(
          (d) => d.atMs <= BOARD.nowMs && d.familyLabel !== undefined,
        ).length
      );
    }, 0);
    expect(row("SMS").facts.considered).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("counts none of them as sent on the demo day: the gate damped every one (§18.2 step 7)", () => {
    // The point of the number. Every recalculation is a text that was *not* sent, and a demo
    // that cannot show the suppression has only ever shown the sending.
    expect(row("SMS").facts.sent).toBe(0);
  });

  it("never counts a decision the board has not reached yet", () => {
    const later = vanKeys.some((key) =>
      (replayForVehicle(key)?.decisions ?? []).some((d) => d.atMs > BOARD.nowMs),
    );
    expect(later, "the committed replays run past the instant the board is read").toBe(true);
    // Which is exactly why the count is cut at `nowMs`: "so far today" has to be true.
    expect(row("SMS").facts.considered).toBeLessThan(
      vanKeys.reduce((n, key) => n + (replayForVehicle(key)?.decisions.length ?? 0), 0),
    );
  });

  it("counts the vans carrying children, and how many of them can be located", () => {
    const maps = row("MAPS").facts;
    expect(maps.vans).toBe(vanKeys.length);
    expect(maps.locating).toBe(
      new Set(
        BOARD.legs
          .filter((leg) => leg.ride.gpsFreshness !== null)
          .flatMap((leg) => {
            const run = runOfChild(leg.child.childKey);
            return run ? [run.vehicleKey] : [];
          }),
      ).size,
    );
    // LOC-01: one van on this scenario has never sent a position anybody may draw.
    expect(maps.locating).toBeLessThan(maps.vans);
  });

  it("counts a van whose arrival updates are paused separately from one it cannot see", () => {
    const maps = row("MAPS").facts;
    // LOC-03: a stale van is still on the map; what stopped is the text about it. So it is in
    // `locating` and in `paused` at once, which is the distinction this row exists to show.
    expect(maps.paused).toBeGreaterThan(0);
    expect(maps.paused).toBeLessThanOrEqual(maps.locating);
  });
});
