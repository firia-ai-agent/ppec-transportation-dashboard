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
  etaText,
  fill,
  fleetMap,
  liveUpdates,
  login,
  mapPreview,
  nav,
  notFound,
  pluralize,
  rampPreview,
  sentence,
  scenarioClock,
  screenReader,
  search,
  securement,
  solver,
  sourceMode,
  unbuilt,
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
    for (const body of [unbuilt.today, unbuilt.exceptions, unbuilt.setup, unbuilt.health]) {
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
    etaText,
    fleetMap,
    liveUpdates,
    login,
    mapPreview,
    nav,
    notFound,
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
