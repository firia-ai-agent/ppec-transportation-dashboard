import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adapters,
  arrival,
  board,
  countable,
  demoBanner,
  demoReset,
  drawer,
  etaText,
  fill,
  fleetMap,
  liveUpdates,
  login,
  mapPreview,
  nav,
  needCategories,
  notFound,
  onDay,
  places,
  planRoutes,
  pluralize,
  rampPreview,
  sentence,
  scenarioClock,
  serviceDate,
  screenReader,
  search,
  securement,
  solver,
  sourceMode,
  unbuilt,
  vanName,
  whoami,
} from "./copy";

/**
 * COPY-GUIDE.md is the source of truth for words. These assertions pin the strings the guide
 * fixes verbatim, so a well-meaning rewrite in a component cannot quietly change them.
 */
describe("COPY-GUIDE strings, verbatim", () => {
  it("§6: the banner reads exactly DEMO, and so does its screen-reader label", () => {
    // Founder decision, 2026-10-14 13:18 ET (ledger row 40), "incl. screen-reader label":
    // COPY-GUIDE §6 and DESIGN-DIRECTION §7 both write aria-label "DEMO", not a paraphrase.
    expect(demoBanner.text).toBe("DEMO");
    expect(demoBanner.ariaLabel).toBe("DEMO");
  });

  it("§2 of DESIGN-DIRECTION: the four nav labels", () => {
    expect(nav.today).toBe("Today");
    expect(nav.exceptions).toBe("Exceptions & Approvals");
    expect(nav.setup).toBe("Setup");
    expect(nav.health).toBe("Health & ROI");
  });

  it("§5: search has a visible label and a hint-only placeholder", () => {
    expect(search.label).toBe("Search");
    expect(search.placeholder).toBe("Child, route or vehicle");
  });

  it("§5: the live-updates-down text, with no jargon", () => {
    expect(liveUpdates.downBody).toBe(
      "Live updates paused. Reconnecting… Board may be up to 40 s old.",
    );
    expect(liveUpdates.downBody).not.toMatch(/SSE/);
  });

  it("§5 SURF-01: the board's empty state, with a date placeholder", () => {
    expect(board.empty).toBe(
      "No rides scheduled for {date}. Change the date or reset the demo.",
    );
    expect(fill(board.empty, { date: "Tue, Oct 14" })).toBe(
      "No rides scheduled for Tue, Oct 14. Change the date or reset the demo.",
    );
  });

  /**
   * The taste bar for this surface, as assertions. Three rules, each of which the board broke
   * at least once before it was written down:
   *
   *  - an action item is a thing to do, so it opens with a verb and names the child it is done
   *    for. The "Next step" column used to say "Coordinator", which is the one fact a
   *    coordinator reading their own board already has;
   *  - a person is named, never described. "An adult on file may receive this child" is true of
   *    every family in the building (COPY-GUIDE §1 "name the person");
   *  - an empty state is one line and ends in what to do next.
   */
  const VERBS = [
    "Move",
    "Record",
    "Decide",
    "Find",
    "Call",
    "Confirm",
    "Ask",
    "Check",
    "Wait",
    "Override",
    "Change",
    "Clear",
    "Turn",
  ];

  describe("§1 / §3: an action item opens with a verb and names the child", () => {
    const steps = Object.entries(board.nextSteps).filter(([key]) => key !== "NOTHING");

    it("has steps to check", () => {
      expect(steps.length).toBeGreaterThan(5);
    });

    it.each(steps)("%s opens with a verb, names the child, and is one sentence", (key, step) => {
      expect(VERBS, `${key}: ${step}`).toContain(step.split(" ")[0]);
      expect(step, key).toContain("{child}");
      // Rendered, because a child's label ends in the full stop its last initial carries and a
      // template that supplied its own would print "Leo B..". `sentence()` closes it once.
      const rendered = sentence(
        fill(step, {
          child: "Leo B.",
          dispatcher: "Hal B.",
          provider: "SYN Palm Lift Transport",
          van: "V1",
        }),
      );
      expect(rendered.endsWith("."), rendered).toBe(true);
      expect(rendered, rendered).not.toMatch(/\.\./);
      expect(rendered, rendered).not.toMatch(/\{\w+\}/);
      // ≤3 words is for buttons (§3); a step in a column is still short enough to read at once.
      expect(step.split(" ").length, `${key}: ${step}`).toBeLessThanOrEqual(8);
    });

    it("never hands a step to a role instead of saying what the step is", () => {
      // The owner column these replaced. A role is not a next step.
      expect(board).not.toHaveProperty("owners");
      for (const [key, step] of Object.entries(board.nextSteps)) {
        for (const role of ["Coordinator", "Front desk", "Provider", "Family"]) {
          expect(step, `${key} names a role`).not.toContain(role);
        }
      }
    });

    it("and the only entry that is not an instruction is the one that is not a step", () => {
      expect(board.nextSteps.NOTHING).toBe("Nothing to do");
    });
  });

  describe("§1: the drawer names people, and never stands in for a name", () => {
    /** Every drawer line about a person, and the one placeholder each of them must carry. */
    const namesTheChild = [
      "noNeeds",
      "receiverOnFile",
      "receiverMissing",
      "heldNoReturn",
      "noApprovals",
      "noAgentChanges",
      "historyEmpty",
      "confirmHandoff",
      "handoffBlockedRamp",
      "handoffBlockedNotArrived",
      "handoffBlockedNoReceiver",
      "overrideWithReason",
    ] as const;

    it.each(namesTheChild)("drawer.%s names the child, and reads right once filled", (key) => {
      expect(drawer[key], key).toContain("{child}");
      // "Leo B." ends in a full stop, so no line may put one straight after the name.
      const rendered = fill(drawer[key], {
        child: "Leo B.",
        adult: "Alma R.",
        relationship: "parent",
      });
      expect(rendered, `${key}: ${rendered}`).not.toMatch(/\.\./);
      expect(rendered, `${key}: ${rendered}`).not.toMatch(/\{\w+\}/);
    });

    it("names the adult and their relationship to the child", () => {
      expect(
        fill(drawer.receiverOnFile, {
          adult: "Alma R.",
          relationship: "parent",
          child: "Mia R.",
        }),
      ).toBe("Alma R., Mia R.'s parent, may receive them.");
    });

    it("names the dispatcher whose report a capability is", () => {
      expect(
        fill(drawer.capabilityReported, {
          dispatcher: "Hal B.",
          provider: "SYN Palm Lift Transport",
        }),
      ).toBe("Reported by Hal B. at SYN Palm Lift Transport. Not checked at the ramp.");
    });

    it("has no sentence left that says 'this child' instead of naming one", () => {
      for (const [key, value] of Object.entries(drawer)) {
        expect(value, `${key}: ${value}`).not.toMatch(/\bthis child\b/);
      }
    });

    it("keeps the three handoff blockers as verbs: what would make the button work", () => {
      for (const blocked of [
        drawer.handoffBlockedRamp,
        drawer.handoffBlockedNotArrived,
        drawer.handoffBlockedNoReceiver,
      ]) {
        expect(VERBS, blocked).toContain(blocked.split(" ")[0]);
      }
    });

    /**
     * The fourth reason is not one of those: there is nothing a coordinator could do to unblock
     * it, so it names the thing that is missing instead — this build's write path. Both disabled
     * controls say it the same way, each under its own button (Vera, 2026-10-16), and neither
     * says it as an instruction it cannot keep.
     */
    it("says what is not connected yet, once per control and in the same words", () => {
      expect(drawer.handoffBlockedNotConnected).toBe("Handoff isn't connected yet.");
      expect(drawer.overrideDisabled).toBe("Overrides aren't connected yet.");
      for (const line of [drawer.handoffBlockedNotConnected, drawer.overrideDisabled]) {
        expect(line, line).toMatch(/isn't connected yet\.$|aren't connected yet\.$/);
        // No placeholder: it is about the build, not about the child or the day.
        expect(line, line).not.toMatch(/\{\w+\}/);
      }
    });

    /** PRD §6.6 CA-04, in the one place it is said in full: the rule closes the line. */
    it("ends the held-child line on the rule, so a quick read still gets it", () => {
      expect(drawer.heldNoReturn).toBe(
        "If nobody is there, {child} waits with the van while staff call. No automatic return.",
      );
      expect(fill(drawer.heldNoReturn, { child: "Noah O." })).toBe(
        "If nobody is there, Noah O. waits with the van while staff call. No automatic return.",
      );
    });
  });

  /**
   * The row's version of the same fact, and the column beside it. A reason in a board cell is
   * read at a glance over 56 rows, so it carries the two facts a coordinator acts on — where the
   * child is and why nobody has taken them — and leaves the rule to the drawer the row opens.
   */
  it("§5 SURF-01: the held row says where the child is and why, in two clauses", () => {
    expect(board.reasons.CHILD_HELD).toBe(
      "{child} is waiting with the van. No adult on file can receive them.",
    );
    // Two clauses in the template: the filled line splits into three, because "Noah O." carries
    // a full stop of its own — which is the reason `sentence()` exists.
    expect(board.reasons.CHILD_HELD.split(". ")).toHaveLength(2);
    expect(fill(board.reasons.CHILD_HELD, { child: "Noah O." })).toBe(
      "Noah O. is waiting with the van. No adult on file can receive them.",
    );
    // The rule is not in here, which is the point: it is in `drawer.heldNoReturn`, said in full.
    expect(board.reasons.CHILD_HELD).not.toMatch(/return/i);
    expect(drawer.heldNoReturn).toMatch(/No automatic return/);
  });

  /**
   * The row for a day that ended with a handoff nobody recorded. Two facts in the order a
   * coordinator closing out the day needs them — the van is back, and the record is missing —
   * and it says "recorded" rather than naming a state, because the state chip beside it already
   * says what the van did and this line is about what no person did.
   */
  it("§5 SURF-01: the unrecorded-handoff row says the van is back and nobody recorded it", () => {
    expect(board.reasons.HANDOFF_UNRECORDED).toBe(
      "{child}'s van is back and nobody recorded who received them.",
    );
    expect(fill(board.reasons.HANDOFF_UNRECORDED, { child: "Zoe B." })).toBe(
      "Zoe B.'s van is back and nobody recorded who received them.",
    );
    // It is not a handoff being claimed: the words never say one happened.
    expect(board.reasons.HANDOFF_UNRECORDED).not.toMatch(/handed off/i);
  });

  /**
   * "Today" is a claim about which day is on screen, and three headings make it: the board's
   * own, the table's screen-reader caption, and the drawer's first section. One function says
   * it for all three (`onDay`), so there is one rule to read and one place to break — and a day
   * that is not the replayed demo day is named by its date in every one of them, whether it is
   * a day that has finished or a day that has not started (Veri #49).
   */
  describe("§5: 'Today' is said on the demo day and on no other", () => {
    const headings = [
      ["board.heading", { today: board.heading, otherDay: board.headingOtherDay }],
      ["board.tableLabel", { today: board.tableLabel, otherDay: board.tableLabelOtherDay }],
      ["drawer.ridesHeading", { today: drawer.ridesHeading, otherDay: drawer.ridesHeadingOtherDay }],
    ] as const;
    const demoDay = { phase: "LIVE", label: "Wed, Oct 14" } as const;
    const otherDays = [
      { phase: "ENDED", label: "Tue, Oct 13" },
      { phase: "PLANNED", label: "Thu, Oct 15" },
    ] as const;

    it("has a pair for every phase a day can be in, so no phase falls through", () => {
      expect(Object.keys(serviceDate.phases).sort()).toEqual(["ENDED", "LIVE", "PLANNED"]);
      expect([demoDay, ...otherDays].map((d) => d.phase).sort()).toEqual(
        Object.keys(serviceDate.phases).sort(),
      );
    });

    it.each(headings)("%s says 'Today' on the demo day", (key, words) => {
      expect(onDay(words, demoDay), key).toBe(words.today);
      expect(onDay(words, demoDay), key).toMatch(/^Today/);
    });

    it.each(headings)("%s names the date on a day that is not the demo day", (key, words) => {
      expect(words.otherDay, key).toContain("{date}");
      for (const day of otherDays) {
        const said = onDay(words, day);
        expect(said, `${key} on ${day.phase}`).toContain(day.label);
        expect(said, `${key} on ${day.phase}`).not.toMatch(/today/i);
        expect(said, `${key} on ${day.phase}`).not.toMatch(/\{\w+\}/);
      }
    });
  });

  /**
   * The two columns that can only say what they do not have. Neither may read like a code or a
   * database row: an unknown window is a time nobody has set yet, and a day whose vans are back
   * in the yard kept no van location (COPY-GUIDE §1–§2, docs/ui/B12-SLICE1-DEFERRED.md §2).
   */
  it("§5 SURF-01: an unknown window and a missing location say so in plain words", () => {
    expect(etaText.pending).toBe("Time not set yet");
    expect(board.windowPending).toBe(etaText.pending);
    expect(fleetMap.windowPending).toBe(etaText.pending);
    expect(etaText.pending).not.toMatch(/pending/i);
    expect(board.noPosition).toBe("No van location yet");
    expect(board.noPositionRecorded).toBe("No van location kept");
    expect(board.noPositionRecorded).not.toMatch(/position|recorded/i);
  });

  describe("§5: an empty state is one line that says what to do next", () => {
    const empties = [
      ["board.empty", board.empty],
      ["board.emptySearch", board.emptySearch],
      ["board.emptyNeedsAction", board.emptyNeedsAction],
    ] as const;

    it.each(empties)("%s is one line, and its last sentence is the thing to do", (key, line) => {
      expect(line.split("\n"), key).toHaveLength(1);
      const sentences = line.split(". ");
      expect(sentences, key).toHaveLength(2);
      expect(VERBS, `${key}: ${sentences[1]}`).toContain(sentences[1].split(" ")[0]);
      expect(line.endsWith("."), key).toBe(true);
    });

    it("§5 SURF-05's words, reused where they are the same fact", () => {
      expect(board.emptyNeedsAction.startsWith("Nothing needs action right now.")).toBe(true);
    });
  });

  it("§6.1: the five source-mode labels", () => {
    expect(sourceMode).toEqual({
      SIMULATED: "Simulated",
      REPLAY: "Replay",
      MANUAL: "Manual entry",
      SANDBOX: "Sandbox",
      LIVE: "Live",
    });
  });

  it("§5: the interim adapter pills read '<adapter> · Simulated'", () => {
    expect(adapters.simulatedValue).toBe("Simulated");
    expect([adapters.sms, adapters.teams, adapters.gps, adapters.agent]).toEqual([
      "SMS",
      "Teams",
      "GPS",
      "Agent",
    ]);
    expect(`${adapters.sms}${adapters.separator}${adapters.simulatedValue}`).toBe(
      "SMS · Simulated",
    );
  });

  it("§9: chips and badges announce themselves as 'State: …' and 'Source: …'", () => {
    expect(fill(screenReader.state, { label: "Needs action" })).toBe("State: Needs action");
    expect(fill(screenReader.source, { label: "Simulated" })).toBe("Source: Simulated");
  });

  it("§1: no exclamation marks, no emoji, sentence case bodies", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const [key, value] of allStrings()) {
      expect(value.includes("!"), `${key} shouts`).toBe(false);
      expect(emoji.test(value), `${key} has an emoji`).toBe(false);
    }
  });

  it("§2: no banned word reaches a user-facing string", () => {
    // Jargon list from COPY-GUIDE §2, matched as whole words so "Setup" and "Legs" are safe.
    const banned = [
      "wheelchair-bound",
      "special needs",
      "handicapped",
      "suffers from",
      "victim of",
      "unload",
      "cargo",
      "patient",
      "abandoned",
      "stranded",
      "ASAP",
      "oops",
      "idempotency",
      "webhook",
      "outbox",
      "SSE",
    ];
    // Whole words (plus a plural), as the list above intends: a substring match reads "SSE"
    // inside "passed" and "patient" inside "patiently", which would ban plain English.
    for (const [key, value] of allStrings()) {
      for (const word of banned) {
        const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`, "i");
        expect(pattern.test(value), `${key} uses "${word}"`).toBe(false);
      }
    }
  });

  it("says in plain words what each not-yet-built surface will do", () => {
    // What it must NOT say is covered by no-internals.test.ts: no build-step codes.
    for (const body of [unbuilt.exceptions, unbuilt.setup, unbuilt.health]) {
      expect(body).toMatch(/^[A-Z].*\.$/);
    }
    expect(unbuilt.tag).toBe("Not built yet");
  });

  it("§5 SURF-04: the ramp strings the guide fixes verbatim", () => {
    expect(rampPreview.offlinePill).toBe(
      "Offline · {count} saved on this iPad. They'll send when Wi-Fi is back.",
    );
    expect(fill(rampPreview.offlinePill, { count: 3 })).toBe(
      "Offline · 3 saved on this iPad. They'll send when Wi-Fi is back.",
    );
    // §5: "Boarding confirmed for Leo B." — one period, not two, after the last initial.
    expect(sentence(fill(rampPreview.snackBoarded, { child: "Leo B." }))).toBe(
      "Boarding confirmed for Leo B.",
    );
    expect(sentence(fill(rampPreview.snackLeftEarly, { child: "Mia R." }))).toBe(
      "Mia R. marked left early.",
    );
    expect(rampPreview.recordedLate).toBe("Recorded late");
    expect(rampPreview.whoPickedUp).toBe("Who picked up?");
    expect(rampPreview.liftRow).toBe("Lift works?");
    expect(rampPreview.latchRow).toBe("Car-seat anchors (LATCH)");
    expect(Object.values(rampPreview.answer)).toEqual(["Yes", "No", "Not sure"]);
    // §5 SURF-02, reused on the rider card: a transport need is never a diagnosis.
    expect(rampPreview.needsCaption).toBe("Derived from intake, not a diagnosis.");
  });

  it("§5 SURF-04: no free-text names in the pickup role list", () => {
    expect(rampPreview.pickupRoles).toEqual([
      "Parent or guardian",
      "Approved adult on the pickup list",
      "PPEC staff",
    ]);
  });

  it("the sign-in intro is the one sentence the review fixed", () => {
    expect(login.intro).toBe("Demo accounts only.");
  });

  it("never claims the sign-in error was the email or the password", () => {
    expect(login.error).toBe("Email or password is incorrect.");
  });

  it("§1: the scenario clock says the demo has not started, and why Start is inert", () => {
    expect(scenarioClock.notStarted).toBe("Demo not started");
    expect(scenarioClock.start).toBe("Start");
    expect(scenarioClock.startUnavailable).toBe("Demo controls aren't connected yet.");
  });
});

describe("pluralize", () => {
  it("never prints a bare count", () => {
    expect(pluralize(1, countable.wheelchair)).toBe("1 wheelchair");
    expect(pluralize(2, countable.wheelchair)).toBe("2 wheelchairs");
    expect(pluralize(0, countable.walkingSeat)).toBe("0 walking seats");
    expect(pluralize(1, countable.wcPosition)).toBe("1 wheelchair position");
  });
});

describe("sentence", () => {
  it("adds the full stop a name's initial already supplied, and only then", () => {
    expect(sentence("Boarding confirmed for Leo B.")).toBe("Boarding confirmed for Leo B.");
    expect(sentence("Boarding confirmed for Leo")).toBe("Boarding confirmed for Leo.");
    expect(sentence("Who picked up?")).toBe("Who picked up?");
  });
});

describe("fill", () => {
  it("replaces named placeholders", () => {
    expect(fill("Handed off to {receiver role}", { "receiver role": "parent" })).toBe(
      "Handed off to parent",
    );
  });

  it("leaves unknown placeholders visible rather than printing undefined", () => {
    expect(fill("Snoozed until {time}", {})).toBe("Snoozed until {time}");
  });

  it("accepts numbers", () => {
    expect(fill("Approved v{n}", { n: 3 })).toBe("Approved v3");
  });
});

/* ─────────────────── no user-facing text outside copy.ts ─────────────────── */

const SRC = path.resolve(__dirname, "..");

/**
 * Everything under src/ that can put words on a screen — `.ts` as well as `.tsx`, because a
 * sentence is just as rendered when a pure domain module builds it (the capacity solver's
 * option details, the map pane's freshness wording) as when a component types it between
 * tags. Tests are excluded: a test may quote the copy it is pinning.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

/** Comments are prose about the design, not rendered text; drop them before scanning. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * JSX text nodes. Two passes, because copy is often wrapped over several lines and a
 * line-anchored scan walked straight past the longest paragraph in the app:
 *  - text between tags on one line, `<h1>Today</h1>`;
 *  - text running up to a closing tag over any number of lines.
 *
 * `{` and `}` are excluded from both, which is what keeps TypeScript generics and arrow
 * functions (`useState<Foo | null>(null); …`) out of the results: real copy arrives through
 * an expression, so a brace means the match is code, not words.
 */
export function jsxTextNodes(source: string): string[] {
  const body = stripComments(source);
  const oneLine = [...body.matchAll(/>([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*)</g)].map((m) => m[1]);
  const manyLines = [...body.matchAll(/>([^<>{}]*[A-Za-z]{2}[^<>{}]*)<\//g)].map((m) => m[1]);
  return [...new Set([...oneLine, ...manyLines].map((s) => s.replace(/\s+/g, " ").trim()))].filter(
    (s) => s.length > 0,
  );
}

/** Quoted strings and template literals, with the offset of the opening quote. */
function literals(body: string): Array<{ text: string; at: number }> {
  const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  return [...body.matchAll(pattern)].map((m) => ({
    text: m[1] ?? m[2] ?? m[3] ?? "",
    at: m.index ?? 0,
  }));
}

/** `${expr}` placeholders collapse, so a template reads like the copy it would fill. */
function collapsePlaceholders(text: string): string {
  let out = text;
  // Repeated, because an inner `${}` has to go before the outer one can be matched.
  for (let i = 0; i < 5; i += 1) out = out.replace(/\$\{[^${}]*\}/g, "{}");
  return out.replace(/\s+/g, " ").trim();
}

/*
 * Two kinds of multi-word, capitalised, full-stopped string are not copy, and both are
 * excluded by what they *are* rather than by which file they sit in — there is no per-file
 * allowlist here, on purpose:
 *  - SQL. `ops.app_user` is a table, not a sentence.
 *  - the message of a thrown Error. That is a note to the next engineer about a
 *    contradiction in its own inputs; it never reaches a screen, and the surfaces that do
 *    show a failure (the sign-in error, the map's tile notice) have their own copy entries.
 */
const SQL_START =
  /^(?:SELECT|INSERT|UPDATE|DELETE|SET|WITH|CREATE|ALTER|DROP|BEGIN|COMMIT|TRUNCATE)\b/;
const THROWN_ERROR = /(?:new\s+\w*Error|\bError)\(\s*$/;

/**
 * Sentence-shaped literals: an opening capital, three or more words, and a full stop,
 * question mark, exclamation mark or ellipsis at the end. That is the shape of a sentence a
 * person reads, and it is the shape that kept being written inline instead of imported.
 */
export function proseLiterals(source: string): string[] {
  const body = stripComments(source);
  return literals(body)
    .filter(({ at }) => !THROWN_ERROR.test(body.slice(Math.max(0, at - 80), at)))
    .map(({ text }) => collapsePlaceholders(text))
    .filter((text) => /^[A-Z“"]/.test(text))
    .filter((text) => /[.?!…]$/.test(text))
    .filter((text) => text.split(" ").length >= 3)
    .filter((text) => !SQL_START.test(text));
}

/** The one file allowed to hold copy. */
const COPY_FILE = path.join("ui", "copy.ts");

describe("the copy scan itself works", () => {
  it("reads both .ts and .tsx, and skips the tests", () => {
    const files = walk(SRC).map((f) => path.relative(SRC, f));
    expect(files.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(20);
    expect(files.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(8);
    expect(files).toContain(COPY_FILE);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  it("catches a text node wrapped over several lines", () => {
    const planted = "<p>\n  Nothing needs action\n  right now.\n</p>";
    expect(jsxTextNodes(planted)).toEqual(["Nothing needs action right now."]);
  });

  it("does not read a generic type argument as a text node", () => {
    const code = "const [a, setA] = useState<string | null>(null);\nconst b = x < y;\n";
    expect(jsxTextNodes(code)).toEqual([]);
  });

  it("catches a planted sentence in a .ts module, template literals included", () => {
    const planted =
      'const a = "This vehicle cannot take the run.";\nconst b = `Ask ${who} to drive today.`;';
    expect(proseLiterals(planted)).toEqual([
      "This vehicle cannot take the run.",
      "Ask {} to drive today.",
    ]);
  });

  it("leaves SQL, thrown errors and short labels alone", () => {
    const code = [
      'await db.query("SELECT id, display_name FROM ops.app_user WHERE id = $1", [id]);',
      "throw new Error(`Vehicle ${id} has no layout.`);",
      'const name = "Mia R.";',
    ].join("\n");
    expect(proseLiterals(code)).toEqual([]);
  });
});

describe("no user-facing text outside copy.ts", () => {
  const files = walk(SRC).map((f) => path.relative(SRC, f));
  const tsx = files.filter((f) => f.endsWith(".tsx"));

  it.each(tsx)("%s has no JSX text node", (relative) => {
    // Rendered copy must arrive through an expression from src/ui/copy.ts instead.
    expect(jsxTextNodes(readFileSync(path.join(SRC, relative), "utf8"))).toEqual([]);
  });

  it.each(files)("%s has no user-facing attribute literal", (relative) => {
    const body = stripComments(readFileSync(path.join(SRC, relative), "utf8"));
    const hits = [
      ...body.matchAll(/\b(aria-label|aria-description|placeholder|title|alt)="([^"]+)"/g),
    ].map((m) => `${m[1]}="${m[2]}"`);
    expect(hits).toEqual([]);
  });

  it.each(files.filter((f) => f !== COPY_FILE))("%s writes no sentence of its own", (relative) => {
    expect(proseLiterals(readFileSync(path.join(SRC, relative), "utf8"))).toEqual([]);
  });
});

/* ─────────── the strings that move was for, pinned where they landed ─────────── */

describe("copy.ts holds the words the surfaces used to hold", () => {
  it("the map preview's heading, intro and document title", () => {
    expect(mapPreview.heading).toBe("Map preview");
    /*
     * Still "Map preview", now that the rail links to it: PRD §14 names no map surface at all
     * (the map lands inside SURF-01 at BUILD-PLAN-M2 P-03), and "Live map" would be the one
     * false word on the screen — a client clock replays fixtures here. §1, honest about
     * certainty. src/ui/nav-items.ts reads this string for the rail label.
     */
    expect(mapPreview.documentTitle).toContain(mapPreview.heading);
    /*
     * The intro's whole job is to say what is and is not real. It used to do that in a
     * paragraph of fixture provenance, which named the build's own surface code and left the
     * one sentence that matters at the end of six lines nobody read. Two sentences now, and
     * src/ui/no-codes.test.ts holds the exact wording (Vera's review).
     */
    expect(mapPreview.intro).toBe("Simulated vans on demo routes. Nothing here is live.");
    expect(mapPreview.intro).toMatch(/Nothing here is live/);
  });

  it("the motion line says what the markers do, not how they are animated", () => {
    // "Tweened along route geometry" named the implementation; the line a reviewer reads now says
    // what is happening on the screen (COPY-GUIDE §1).
    expect(mapPreview.motionTweened).toBe("Vans follow their routes.");
    expect(mapPreview.motionTweened).not.toMatch(/tween|geometry/i);
    // The reduced-motion line still says what it is: the markers step instead of sliding.
    expect(mapPreview.motionReduced).toBe("Reduced motion: markers step, no tween");
  });

  it("the map pane's own wording, including the two tile notices", () => {
    expect(fleetMap.fitAll).toBe("Fit all vehicles");
    expect(fleetMap.retry).toBe("Retry");
    expect(fleetMap.vehiclesHeading).toBe("Vehicles");
    expect(fleetMap.locationLost).toBe("Location lost · dispatcher pinged");
    // AT-10: a geofence says the vehicle arrived, never that a child was handed over.
    expect(fleetMap.arrived).toBe("Arrived (vehicle)");
    expect(fleetMap.arrived).not.toMatch(/Handed off/);
    expect(arrival.notHandoff).toMatch(/custody event/);
    expect(fleetMap.tilesFailedDetail).toBe(
      "Map tiles did not load. The board below is unaffected.",
    );
    expect(fill(fleetMap.windowPaused, { window: "8:20–8:30 AM" })).toBe(
      "8:20–8:30 AM · ETA texts paused",
    );
  });

  it("the solver's pending reasons and its six option labels", () => {
    expect(solver.pending.unobserved).toBe(
      "What this vehicle can carry today is unknown until arrival.",
    );
    expect(solver.unusable.VERIFIED_INFEASIBLE).toMatch(/does not fit/);
    expect(Object.values(solver.options).map((o) => o.label)).toEqual([
      "Split the run",
      "Move to {vehicle}",
      "Move to {vehicle}",
      "Ask the family to drive",
      "Delay the run",
      "Cancel the ride",
    ]);
    expect(fill(solver.options.SPLIT_RUN.detail, { who: "Leo B.", vehicle: "V1" })).toBe(
      "Run Leo B. separately on V1. Everyone already on the vehicle stays where they are.",
    );
    // AT-12: an option is a proposal, so no label may read like an action already taken.
    for (const option of Object.values(solver.options)) {
      expect(option.label).not.toMatch(/\b(assigned|locked|sent)\b/i);
    }
  });

  it("the Plan routes screen's reasons, refusals and the AT-12 promise", () => {
    // The reason on an unplaced child's row is the sentence Vera asked for, verbatim: it names
    // the child and the thing that is missing, and it is one line.
    expect(sentence(fill(planRoutes.reason.NO_LIFT, { child: "Noah O." }))).toBe(
      "No van with a ramp for Noah O.",
    );
    expect(
      sentence(
        fill(planRoutes.reason.NO_SECUREMENT, {
          child: "Zoe B.",
          securement: securement.FOUR_POINT_STRAP,
        }),
      ),
    ).toBe("No van with four-point straps for Zoe B.");
    for (const [key, line] of Object.entries(planRoutes.reason)) {
      expect(line, key).toContain("{child}");
      expect(line.split("\n"), key).toHaveLength(1);
      // A reason that ends on the child carries no full stop of its own: the last initial
      // already supplied one, and `sentence()` is what closes the rest.
      if (line.endsWith("{child}")) continue;
      expect(sentence(fill(line, { child: "Zoe B.", vehicle: "V1", securement: "L-track" })), key)
        .not.toMatch(/\.\.$/);
    }

    // A refused move is one line: the child first, because they are who was being moved, then
    // the van by its own name and the one thing it is missing (Vera's review, 2026-10-17).
    expect(
      fill(planRoutes.refused, {
        vehicle: vanName("substitute van"),
        child: "Zoe B.",
        missing: fill(planRoutes.missing.NO_SECUREMENT, { securement: securement.FOUR_POINT_STRAP }),
      }),
    ).toBe("Can’t put Zoe B. in the substitute van: no four-point straps.");

    // AT-12: the family is told only after staff choose, said on the screen rather than implied,
    // and said once — the second line making the same promise is gone, and so is `localOnly`.
    expect(planRoutes.nothingSent).toBe("No family has been told. Staff choose first.");
    expect(planRoutes.optionsNote).toBe(
      "A coordinator picks one. The family hears nothing before that.",
    );
    expect(planRoutes).not.toHaveProperty("localOnly");
    expect(planRoutes).not.toHaveProperty("needsApproval");
    // AT-04: nobody boards on a van that does not fit, or on one nobody has checked.
    expect(planRoutes.laneBlocked).toBe("Nobody boards until a coordinator approves.");
    expect(planRoutes.laneNeedsCheck).toBe("Nobody boards until this van is checked.");
    // VEH-01: an unapproved need is on screen and visibly not part of the allocation.
    expect(fill(planRoutes.unapprovedNeed, { need: needCategories.MEDICAL_DEVICE_POWER })).toBe(
      "Device that needs power · not used for planning",
    );
    // Every cause the planner can report has words for both the reason and the refusal.
    expect(Object.keys(planRoutes.missing).sort()).toEqual(Object.keys(planRoutes.reason).sort());
  });

  /**
   * Vera's review, 2026-10-17: no vehicle code reaches the Plan routes screen.
   *
   * "V1" is how the fixtures file a van and how the solver keys one, and it is not a thing a
   * coordinator says out loud — a lane headed "V1 · convertible van" asks them to translate
   * before they can act. A van has one name on the screen, written as it is said in the middle
   * of a sentence, and the lane's heading capitalises it in CSS so there is no second string to
   * drift from this one.
   */
  it("names a van by what it is, in one string, with no vehicle code in it", () => {
    expect(vanName("convertible van")).toBe("the convertible van");
    expect(vanName("sedan")).toBe("the sedan");
    expect(vanName("convertible van")).not.toMatch(/\bV\d\b/);
    // Every sentence on the screen that carries a van takes it from there, and none of them
    // opens on it — a van's name opens with "the", and a sentence cannot.
    for (const [key, line] of Object.entries({
      refused: planRoutes.refused,
      moved: planRoutes.moved,
      moveTo: planRoutes.moveTo,
      substituted: planRoutes.substituted,
      substituteOption: planRoutes.substituteOption,
      asked: planRoutes.asked,
      answered: planRoutes.answered,
    })) {
      expect(line, key).toContain("{vehicle}");
      if (key === "substituteOption") continue; // a button label, not a sentence
      expect(line.startsWith("{vehicle}"), `${key} opens on the van`).toBe(false);
    }
    // The relief driver leads with the person, and names no van at all (§1).
    expect(fill(planRoutes.substitutedDriver, { driver: "Gus M." })).toBe("Gus M. drives instead.");
    // The provider is named wherever they are asked something, never called "the provider".
    for (const [key, line] of Object.entries({
      askProvider: planRoutes.askProvider,
      recordAnswer: planRoutes.recordAnswer,
      reported: planRoutes.arrival.REPORTED,
    })) {
      expect(line, key).toContain("{provider}");
      expect(line, key).not.toMatch(/\bthe provider\b/);
    }
  });

  /**
   * The lines Vera shortened, verbatim. Each one replaced a sentence that said the verdict the
   * chip beside it already said, or explained the screen to a reader who was looking at it.
   */
  it("the Plan routes lines the review rewrote", () => {
    expect(planRoutes.plan).toBe("Plan routes");
    expect(planRoutes).not.toHaveProperty("planAgain");
    expect(fill(planRoutes.laneMissing, { stop: "Lantana Public Library", missing: "no free seat" })).toBe(
      "At Lantana Public Library, this van has no free seat.",
    );
    expect(planRoutes.setUpChanges).toEqual({
      BEFORE: "Convertible: planning picks the setup that fits the riders.",
      PLANNED: "Set up this way to fit these riders.",
      SEEN: "Set up as it arrived, so planning keeps it.",
    });
    expect(fill(planRoutes.dragNowhere, { child: "Zoe B." })).toBe(
      "Zoe B. wasn’t moved. Drop them on a van.",
    );
    expect(fill(planRoutes.movedOut, { child: "Zoe B." })).toBe("Zoe B. is not in a van now.");
    expect(planRoutes.missing.UNKNOWN_UNTIL_ARRIVAL).toBe("not checked yet");
    expect(fill(planRoutes.optionsHeading, { child: "Zoe B." })).toBe("Options for Zoe B.");
    expect(planRoutes.laneOptionsHeading).toBe("Options");
    expect(planRoutes.mapPlaceholder).toBe("The route map isn’t built yet.");
    // Said once over the lanes rather than under every rider card, so it is shorter than the
    // ramp check's own copy of the same promise and deliberately not the same string.
    expect(planRoutes.needsCaption).toBe("From intake, not a diagnosis.");
    expect(planRoutes.waitingHeading).toBe("Waiting to be planned");
    expect(planRoutes.changeVan).toBe("Change van or report");
  });

  /**
   * Vera's review, 2026-10-17: the demo toggle names the two scenarios, not two dates. The
   * labels it replaced ("A day everyone fits" / "A day one child has no van") read as a choice
   * of day on a screen that replays exactly one, and the first thing beside them is that one
   * day's date.
   */
  it("names the two demo scenarios by what happens, with no date in either label", () => {
    expect(planRoutes.demoScenario.EVERY_RIDER_FITS).toBe("Normal day");
    expect(planRoutes.demoScenario.ONE_RIDER_HAS_NO_VAN).toBe("A child can’t be placed");
    for (const [key, label] of Object.entries(planRoutes.demoScenario)) {
      // No weekday, no month, no number: a label with a date in it is a second day.
      expect(label, key).not.toMatch(
        /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\d/,
      );
      // "A day …" is the shape that was wrong, whatever follows it.
      expect(label, key).not.toMatch(/^A day\b/);
    }
    // The legend says what the choice is, and says it is the demo's rather than the day's.
    expect(planRoutes.demoScenarioLegend).toBe("Demo scenario");
    // Each scenario still says what it is in a sentence, and both are the same service date.
    expect(Object.keys(planRoutes.demoScenarioNote).sort()).toEqual(
      Object.keys(planRoutes.demoScenario).sort(),
    );
    expect(planRoutes.demoScenarioNote.EVERY_RIDER_FITS).toBe(
      "Three vans today: the convertible van, the center van and the sedan.",
    );
    expect(planRoutes.demoScenarioNote.ONE_RIDER_HAS_NO_VAN).toBe(
      "The convertible van is off the road and a smaller van replaced it. No van today has four-point straps.",
    );
    // Each one names the vans the way the lanes name them, and neither names a provider's role.
    for (const [key, note] of Object.entries(planRoutes.demoScenarioNote)) {
      expect(note, key).not.toMatch(/\bthe provider\b|\bV\d\b/);
    }
  });

  it("a delta that is not known says so, and never prints a bare minus", () => {
    expect(etaText.unknown).toBe("Not known yet");
    expect(etaText.unknown).not.toMatch(/NaN/);
    expect(etaText.behind).toBe("−{n} min"); // U+2212, not a hyphen (COPY-GUIDE l.36)
  });

  it("the demo-reset answers an operator reads", () => {
    expect(demoReset.previewRefusal).toMatch(/^Refusing: preview deployments/);
    expect(demoReset.directorOnly).toBe("Only a director can reset the demo.");
  });
});

/** Every leaf string exported from copy.ts, flattened with a dotted key for messages. */
function allStrings(): Array<[string, string]> {
  const copy: Record<string, unknown> = {
    adapters,
    arrival,
    board,
    countable,
    demoBanner,
    demoReset,
    drawer,
    etaText,
    fleetMap,
    liveUpdates,
    login,
    mapPreview,
    nav,
    needCategories,
    notFound,
    places,
    planRoutes,
    rampPreview,
    scenarioClock,
    search,
    securement,
    solver,
    sourceMode,
    unbuilt,
    whoami,
  };
  const out: Array<[string, string]> = [];
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === "string") {
      out.push([prefix, value]);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(prefix ? `${prefix}.${k}` : k, v);
    }
  };
  visit("", copy);
  return out;
}
