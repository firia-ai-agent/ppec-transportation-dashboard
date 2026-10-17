import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { formatClock24 } from "@/domain/eta/eta";
import { NOTIFY_MIN_LEAD_SECONDS } from "@/domain/eta/notify-gate";
import { childByKey, stopByKey, RUNS } from "@/modules/demo/fixtures/standard";
import { LATE_SHIFT_ENV_VAR } from "@/modules/messaging/eta-notice";
import {
  demoLateDropoffFor,
  demoLateDropoffs,
  dueEtaNotices,
  lateDropoffReplay,
  lateDropoffSpec,
  LATE_DIRECTION,
  LATE_RUN_KEY,
} from "./late-dropoff";

/**
 * AT-03 on the afternoon: "live and replayed traffic delay (downstream only, hysteresis,
 * deterministic replay)" (PRD §18.3), from the §18.2 step 7 sentence "one damped 10-min window SMS
 * to downstream families only; jitter suppressed".
 *
 * The morning half of AT-03 is already held from both ends — src/domain/eta/replay.test.ts and
 * src/fixtures/replays.test.ts, over the step 7 stall on the committed morning track. What is new
 * here is the half a *family* actually reads: a late drop-off, the window each downstream family is
 * given, and the fact that the family already at home is told nothing.
 *
 * Pure: no database, no clock, no network. The demo day is the only day in it.
 */

const day = demoDay();
/** The two families still ahead of the stall, in the order the van reaches them. */
const DOWNSTREAM = ["C3", "C2"];
/** The family the van had already set down when it stopped. */
const ALREADY_HOME = "C9";

describe("AT-03 · the afternoon stall tells the families still ahead of it, once each", () => {
  it("texts every downstream family exactly once", () => {
    const texts = demoLateDropoffs(day);
    expect(texts.map((t) => t.childKey)).toEqual(DOWNSTREAM);
  });

  it("says nothing to the family whose child is already home", () => {
    expect(demoLateDropoffFor(ALREADY_HOME, day)).toBeUndefined();
    // …and the van really had served that stop before the stall (otherwise the rule above is
    // vacuous: a family nobody has reached yet is downstream, not served).
    const served = lateDropoffReplay(day).arrivals.map((a) => a.stopId);
    expect(served).toContain(childByKey(ALREADY_HOME).stopKey);
  });

  it("says nothing about the centre, which has no family to tell", () => {
    expect(demoLateDropoffs(day).map((t) => t.stopPlace)).not.toContain("PPEC center");
  });

  /**
   * The promise the text makes: the van arrives inside the 10-minute window the family was given.
   * A damped window that the run then misses would be worse than no text at all.
   */
  it("arrives inside the window each family was given", () => {
    const replay = lateDropoffReplay(day);
    for (const notice of dueEtaNotices(day)) {
      const stopId = childByKey(notice.childKey).stopKey!;
      const arrival = replay.arrivals.find((a) => a.stopId === stopId);
      expect(arrival, notice.childKey).toBeDefined();
      expect(arrival!.atMs, notice.childKey).toBeGreaterThanOrEqual(notice.decision.windowStartMs!);
      expect(arrival!.atMs, notice.childKey).toBeLessThanOrEqual(notice.decision.windowEndMs!);
    }
  });

  it("never texts a family whose van is nearly there (ASM-14's ten-minute lead)", () => {
    for (const notice of dueEtaNotices(day)) {
      const { decision } = notice;
      expect((decision.windowStartMs! - decision.atMs) / 1000, notice.childKey).toBeGreaterThanOrEqual(
        NOTIFY_MIN_LEAD_SECONDS,
      );
    }
  });

  it("replays the same run every time (same seed ⇒ same ETA events)", () => {
    const once = demoLateDropoffs(day);
    const twice = demoLateDropoffs(day, { ...process.env });
    expect(twice).toEqual(once);
    expect(lateDropoffSpec(day).seed).toBe(lateDropoffSpec(day).seed);
  });

  it("stays silent when the operator raises the threshold above the delay", () => {
    // The stall costs about eleven minutes, so a half-hour threshold is a deployment that does not
    // consider this worth a text — and then nobody is texted, rather than texted differently.
    expect(demoLateDropoffs(day, { [LATE_SHIFT_ENV_VAR]: "1800" })).toEqual([]);
  });
});

describe("what the family reads, and what staff read beside it", () => {
  const noah = () => demoLateDropoffFor("C2", day)!;

  it("is the late-drop-off body, with the window and the public place", () => {
    const text = noah();
    expect(text.templateId).toBe("dropoff.late");
    expect(text.body).toContain(`about ${text.delayMinutes} minutes late`);
    expect(text.body).toContain(text.windowText);
    expect(text.body).toContain(stopByKey(childByKey("C2").stopKey!).label);
    expect(text.body).toContain("[DEMO]");
  });

  it("names nobody and nothing internal in the body (Veri #12, COPY-GUIDE §2)", () => {
    for (const text of demoLateDropoffs(day)) {
      expect(text.body).not.toContain(text.childFirstName);
      expect(text.body).not.toContain(text.guardianFirstName);
      expect(text.body).not.toMatch(/\bF\d{1,2}\b|\bC\d{1,2}\b|\bS\d\b|\bR\d\b/);
      expect(text.body).not.toMatch(/ETA|threshold|NOTIFY|SUPPRESS|PM\b.*window/i);
      // The stop token itself never reaches a family; the place name does.
      expect(text.body).not.toContain(stopByKey(childByKey(text.childKey).stopKey!).smsToken);
    }
  });

  it("gives the panel the people and the van by name", () => {
    const text = noah();
    expect(text.childLabel).toBe("Noah O.");
    expect(text.childFirstName).toBe("Noah");
    expect(text.guardianName).toBe("Dara O.");
    expect(text.relationship).toBe("parent");
    // A fiction number from the MOCKS §3 block, and the one this family is reachable on.
    expect(text.phone).toMatch(/^\+1-561-555-01\d\d$/);
    expect(text.vanLabel).toBe("V2 center van");
    expect(text.providerName).toBe("SYN Greenacres center fleet");
  });

  it("is on the run the scenario puts that child on", () => {
    expect(RUNS.find((r) => r.key === LATE_RUN_KEY)!.childKeys).toContain("C2");
    expect(LATE_DIRECTION).toBe("PM");
  });

  it("went out during the demo day, in the afternoon", () => {
    for (const text of demoLateDropoffs(day)) {
      expect(formatClock24(text.atMs) > "12:00", formatClock24(text.atMs)).toBe(true);
      expect(formatClock24(text.atMs) < "17:30").toBe(true);
    }
  });
});

describe("one list, two readers", () => {
  /**
   * The panel renders these decisions and the sweep queues them. If the two lists could differ,
   * the demo would show a text the message log does not hold — which is the one thing a founder
   * walking the thread would catch.
   */
  it("hands the sweep exactly the crossings the panel shows", () => {
    const panel = demoLateDropoffs(day);
    const sweep = dueEtaNotices(day);
    expect(sweep.map((d) => d.childKey)).toEqual(panel.map((t) => t.childKey));
    expect(sweep.map((d) => d.decision.windowText)).toEqual(panel.map((t) => t.windowText));
    for (const d of sweep) {
      expect(d.direction).toBe(LATE_DIRECTION);
      expect(d.stopToken).toBe(stopByKey(childByKey(d.childKey).stopKey!).smsToken);
      expect(d.decision.outcome).toBe("NOTIFY");
    }
  });
});
