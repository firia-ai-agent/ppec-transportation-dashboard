import { describe, expect, it } from "vitest";
import {
  ackState,
  agentRunState,
  attendanceState,
  capabilityState,
  jobState,
  legState,
  needItemState,
  outboundState,
  profileState,
  reservationState,
  severity,
  sourceMode,
  taskState,
  threadState,
} from "@/db/schema";
import { tones } from "./tokens";
import {
  ackStates,
  agentRunStates,
  attendanceStates,
  capabilityStates,
  gpsFreshnessBands,
  gpsFreshnessFor,
  gpsFreshnessStates,
  jobStates,
  legStates,
  needItemStates,
  outboundStates,
  profileStates,
  reservationStates,
  severityStates,
  sourceModes,
  taskStates,
  therapySessionStates,
  therapySessionStatusValues,
  threadStates,
  vocabularies,
  type StateDescriptor,
} from "./states";

type Enum = { enumName: string; enumValues: readonly string[] };
type Vocab = Readonly<Record<string, StateDescriptor>>;

/**
 * DESIGN-DIRECTION §3 must cover every value the database can hold, or a real row will render
 * with no icon and no label. These are the enums §3 defines a label for; the PR's required
 * list (leg, attendance, capability, reservation, outbound, severity, thread) comes first.
 */
const REQUIRED: ReadonlyArray<[Enum, Vocab]> = [
  [legState, legStates],
  [attendanceState, attendanceStates],
  [capabilityState, capabilityStates],
  [reservationState, reservationStates],
  [outboundState, outboundStates],
  [severity, severityStates],
  [threadState, threadStates],
];

/** The rest of §3's tables, checked the same way. */
const ALSO_IN_SECTION_3: ReadonlyArray<[Enum, Vocab]> = [
  [ackState, ackStates],
  [taskState, taskStates],
  [profileState, profileStates],
  [needItemState, needItemStates],
  [agentRunState, agentRunStates],
  [jobState, jobStates],
];

/**
 * Schema enum values that DESIGN-DIRECTION §3 does not give a label for. Empty today: §3
 * covers every value of every enum above. When an enum gains a value, this test fails rather
 * than letting someone invent a label — add the value here with a note and raise it with Vera.
 */
const KNOWN_GAPS: Readonly<Record<string, readonly string[]>> = {};

describe("§3 covers the schema enums", () => {
  it.each([...REQUIRED, ...ALSO_IN_SECTION_3])(
    "every %s value has an icon, a label and a tone",
    (pgEnum, vocab) => {
      const missing = pgEnum.enumValues.filter((v) => !(v in vocab));
      expect(missing, `${pgEnum.enumName} values with no §3 entry`).toEqual(
        KNOWN_GAPS[pgEnum.enumName] ?? [],
      );
    },
  );

  it.each([...REQUIRED, ...ALSO_IN_SECTION_3])(
    "%s has no entry the schema cannot produce",
    (pgEnum, vocab) => {
      const extra = Object.keys(vocab).filter((k) => !pgEnum.enumValues.includes(k));
      expect(extra, `${pgEnum.enumName} entries with no enum value`).toEqual([]);
    },
  );

  it("records no open gaps (the list is the escape hatch, not the norm)", () => {
    expect(Object.keys(KNOWN_GAPS)).toEqual([]);
  });

  it("names the one state family §3 defines that the schema does not model as an enum", () => {
    // ops.therapy_session.status is a plain text column, so parity cannot be asserted against
    // the schema. §3 defines exactly these four, and they are mirrored by hand. Spec gap.
    expect(therapySessionStatusValues).toEqual([
      "SCHEDULED",
      "IMPACTED",
      "THERAPIST_NOTIFIED",
      "CANCELED",
    ]);
    expect(Object.keys(therapySessionStates)).toEqual([...therapySessionStatusValues]);
  });
});

describe("descriptor shape", () => {
  const entries = Object.entries(vocabularies).flatMap(([name, vocab]) =>
    Object.entries(vocab).map(([key, descriptor]) => ({ name, key, descriptor })),
  );

  it("has an entry for every state in every vocabulary", () => {
    expect(entries.length).toBeGreaterThan(80);
  });

  it.each(entries)("$name.$key renders an icon, a label and a §8 tone", ({ descriptor }) => {
    // Lucide components are forwardRef objects, not plain functions.
    expect(["function", "object"]).toContain(typeof descriptor.icon);
    expect(descriptor.icon).toBeTruthy();
    expect(descriptor.label.trim()).toBe(descriptor.label);
    expect(descriptor.label.length).toBeGreaterThan(0);
    expect(tones).toContain(descriptor.tone);
  });

  it("uses no emoji anywhere (§2: the PRD's traffic lights became icon + label chips)", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const { name, key, descriptor } of entries) {
      expect(emoji.test(descriptor.label), `${name}.${key}`).toBe(false);
    }
  });

  it("keeps labels unique inside each vocabulary", () => {
    for (const [name, vocab] of Object.entries(vocabularies)) {
      const labels = Object.values(vocab).map((d) => d.label);
      expect(new Set(labels).size, `${name} has duplicate labels`).toBe(labels.length);
    }
  });

  it("never labels a geofence arrival as a handoff (PRD SURF-01, COPY-GUIDE §2)", () => {
    expect(legStates.ARRIVED_DROPOFF.label).toBe("Arrived (vehicle)");
    expect(legStates.ARRIVED_DROPOFF.label).not.toContain("Handed off");
  });

  it("uses no banned word from COPY-GUIDE §2 in a state label", () => {
    const banned = [
      "wheelchair-bound",
      "special needs",
      "handicapped",
      "disabled",
      "suffers",
      "unload",
      "cargo",
      "pax",
      "abandoned",
      "stranded",
      "patient",
      "ASAP",
      "URGENT!",
    ];
    for (const { name, key, descriptor } of entries) {
      for (const word of banned) {
        expect(
          descriptor.label.toLowerCase().includes(word.toLowerCase()),
          `${name}.${key} uses "${word}"`,
        ).toBe(false);
      }
    }
  });
});

describe("GPS freshness (D-2: four bands)", () => {
  it("has the four §3 bands in order", () => {
    expect(gpsFreshnessBands.map((b) => b.key)).toEqual(["FRESH", "AGING", "STALE", "LOST"]);
    expect(Object.keys(gpsFreshnessStates)).toEqual(["FRESH", "AGING", "STALE", "LOST"]);
  });

  it.each([
    [0, "FRESH"],
    [59, "FRESH"],
    [60, "AGING"],
    [179, "AGING"],
    [180, "STALE"],
    [599, "STALE"],
    [600, "LOST"],
    [100_000, "LOST"],
  ])("%i s is %s", (age, band) => {
    expect(gpsFreshnessFor(age)).toBe(band);
  });

  it("says ETA texts are paused while stale (§3)", () => {
    expect(gpsFreshnessStates.STALE.label).toContain("ETA texts paused");
  });
});

describe("source-mode badge (§7.1, D-10)", () => {
  it("covers every source_mode the schema can store", () => {
    expect(Object.keys(sourceModes).sort()).toEqual([...sourceMode.enumValues].sort());
  });

  it("uses the §7.1 labels verbatim", () => {
    expect(Object.fromEntries(Object.entries(sourceModes).map(([k, v]) => [k, v.label]))).toEqual({
      SIMULATED: "Simulated",
      REPLAY: "Replay",
      MANUAL: "Manual entry",
      SANDBOX: "Sandbox",
      LIVE: "Live",
    });
  });

  it("colours only SIMULATED with the demo violet; LIVE is never violet", () => {
    expect(sourceModes.SIMULATED.textToken).toBe("src-sim");
    expect(sourceModes.LIVE.textToken).toBe("ink");
    for (const [key, descriptor] of Object.entries(sourceModes)) {
      if (key === "SIMULATED") continue;
      expect(descriptor.textToken, key).not.toBe("src-sim");
    }
  });
});
