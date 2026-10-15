import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "./copy";
import { renderedStrings } from "./no-internals.test";
import { DEMO_RUNS } from "@/fixtures/replays";
import { FIXTURE_ROUTES } from "@/fixtures/routes";
import { knownTemplates, renderTemplate, templatePlaceholders, UNKNOWN_STOP } from "@/modules/messaging/templates";
import { TEMPLATE_VARS } from "@/modules/outbox/outbox";

/**
 * No build-internal codes on screen (Vera's review; COPY-GUIDE §1–§2).
 *
 * `no-internals.test.ts` already bars ticket ids and internal endpoints. This is the rest of
 * the same rule, and it exists because the map preview had been quietly leaking the whole set:
 * the intro named its own surface ("SURF-01"), the fault list printed fixture route ids
 * ("route1", "route1-unbound"), and each row ended in the PRD step and acceptance test it was
 * written for ("PRD §18.2 step 7 · AT-03", "LOC-01 · ADR-013"). Every one of those is a note
 * between engineers. Nobody standing in front of the screen can act on any of them.
 *
 * Three nets, because the offending strings were not all in one place:
 *  1. every string the copy module exports;
 *  2. every string literal and JSX text node under src/ui, src/app and src/components —
 *     everything a component can put on a screen without going through copy.ts;
 *  3. the fixture fields that are *rendered* as words rather than used as identifiers. A
 *     fixture file cannot be scanned wholesale: `id: "route1"` is a key, not copy, and the
 *     `note:` annotations on the state machines are engineering margin notes that no screen
 *     reads. So the rendered fields are named here instead, and e2e/screens.spec.ts runs the
 *     same patterns over the real rendered text of all three screens, which is the net that
 *     needs no judgement about which literal is which.
 *
 * Comments are stripped first: a code in a comment is a note to the next engineer, which is
 * exactly where these belong.
 */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Surface, ADR, location-requirement and acceptance-test ids: "SURF-01", "ADR-013", "AT-10".
  { name: "a surface / ADR / requirement / acceptance-test code", re: /\b(?:SURF|ADR|LOC|AT|NFR|FQ|ASM|EV)-\d+/g },
  // Section references into the specs: "PRD §7", "PRD l.1058", "DESIGN-DIRECTION §5.1".
  { name: "a reference into a spec document", re: /\b(?:PRD|COPY-GUIDE|DESIGN-DIRECTION|MOCKS)\b\s*(?:§|l\.)?/g },
  // Fixture route ids. The screen says "Okeeheelee Park run" (mapPreview.routeName).
  { name: "a fixture route id", re: /\broute\d+(?:-[a-z]+)*\b/g },
];

const SRC = path.resolve(__dirname, "..");

/** Everywhere a literal can reach a screen without passing through copy.ts. */
const SCANNED_DIRS = ["ui", "app", "components"].map((d) => path.join(SRC, d));

const EXTENSIONS = new Set([".ts", ".tsx"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXTENSIONS.has(path.extname(full)) ? [full] : [];
  });
}

function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap(walk).filter(
    (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
  );
}

/** Every leaf string the copy module exports, with a dotted key for the failure message. */
function copyStrings(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === "string") return void out.push([prefix, value]);
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(prefix ? `${prefix}.${k}` : k, v);
    }
  };
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === "function") continue;
    visit(name, value);
  }
  return out;
}

function codesIn(text: string): string[] {
  return PATTERNS.flatMap(({ re }) => [...text.matchAll(re)].map((m) => m[0].trim()));
}

/**
 * A raw token, the shape the outbox carries a stop in: upper-case letters or digits in hyphenated
 * parts, at least one of them a letter ("OKEE-PARK", "STOP-4"). The letter is what keeps the phone
 * number out ("555-0100" is digits), and the en dash in a window is not a hyphen ("8:12\u20138:22 AM").
 */
const STOP_TOKEN = /\b[A-Z0-9]*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;

function tokensIn(text: string): string[] {
  return [...text.matchAll(STOP_TOKEN)].map((m) => m[0]);
}

describe("the scan itself works", () => {
  it("catches each kind of code it claims to catch", () => {
    expect(codesIn("Fleet map pane (SURF-01) on committed fixtures")).toEqual(["SURF-01"]);
    expect(codesIn("V1 · route1 · Jitter ±40 m (AT-03)")).toEqual(["AT-03", "route1"]);
    expect(codesIn("V4 · route1-unbound · Unbound device")).toEqual(["route1-unbound"]);
    expect(codesIn("PRD §18.2 step 7 · LOC-01 · ADR-013")).toEqual([
      "LOC-01",
      "ADR-013",
      "PRD §",
    ]);
  });

  it("catches a raw stop token, and passes the things that merely look like one", () => {
    expect(tokensIn("PPEC: Your child's van is on the way to OKEE-PARK.")).toEqual(["OKEE-PARK"]);
    expect(tokensIn("Pickup STOP-4")).toEqual(["STOP-4"]);
    // A phone number, a window and the fixed parts of every body are not tokens.
    expect(tokensIn("Call us at (561) 555-0100. Pickup 8:12\u20138:22 AM. Reply HELP for help, STOP to opt out. [DEMO]")).toEqual([]);
  });

  it("passes words that merely look like one", () => {
    // No digits, so no code: a route a human can say out loud is the point of the fix.
    expect(codesIn("Okeeheelee Park run")).toEqual([]);
    expect(codesIn("Simulated vans on demo routes. Nothing here is live.")).toEqual([]);
  });

  it("finds the files and the strings it claims to scan", () => {
    expect(sourceFiles().length).toBeGreaterThan(40);
    expect(copyStrings().length).toBeGreaterThan(100);
  });
});

describe("no internal codes in UI copy", () => {
  it.each(copyStrings().filter(([, v]) => v.length > 0))("copy.%s is free of codes", (key, value) => {
    expect(codesIn(value), `${key}: ${value}`).toEqual([]);
  });

  it.each(sourceFiles().map((f) => path.relative(SRC, f)))(
    "%s renders no internal code",
    (relative) => {
      const offenders = renderedStrings(readFileSync(path.join(SRC, relative), "utf8")).filter(
        (s) => codesIn(s).length > 0,
      );
      expect(offenders).toEqual([]);
    },
  );
});

describe("the fixture words that are rendered as words", () => {
  it("every demo run's fault label is free of codes", () => {
    for (const run of DEMO_RUNS) expect(codesIn(run.faultLabel), run.faultLabel).toEqual([]);
  });

  it("every stop a route names is a place, not an id", () => {
    for (const route of FIXTURE_ROUTES) {
      for (const stop of route.stops) expect(codesIn(stop.name), stop.name).toEqual([]);
    }
  });

  it("the run a vehicle is on is named by its first stop, never by the fixture id", () => {
    // What the fault list prints. The ids are still ids — they just stay in the fixture file.
    const named = FIXTURE_ROUTES.map((r) => copy.fill(copy.mapPreview.routeName, { stop: r.stops[0].name }));
    expect(named).toEqual([
      "Okeeheelee Park run",
      "John Prince Park run",
      "Greenacres City Hall run",
    ]);
    for (const label of named) expect(codesIn(label)).toEqual([]);
  });
});

describe("the strings the review fixed, verbatim", () => {
  it("the map preview says what it is in one line", () => {
    expect(copy.mapPreview.intro).toBe("Simulated vans on demo routes. Nothing here is live.");
  });

  it("the ramp check says where the answers go, in one line", () => {
    expect(copy.rampPreview.localOnly).toBe("Nothing here is sent. Answers stay on this iPad.");
  });

  it("a fault row names the run in words, with no reference trailing it", () => {
    expect(copy.mapPreview.faultRow).toBe("{vehicle} · {route} · {fault}");
    expect(copy.fill(copy.mapPreview.routeName, { stop: "Okeeheelee Park" })).toBe(
      "Okeeheelee Park run",
    );
  });
});

/**
 * The same rule on the one surface that is not a screen: a family's SMS. `stopLabel` is a short
 * token in the outbox vars (the no-free-text rule, outbox.ts), so the place name can only come from
 * the fixed copy table at render time — and if that resolution is ever dropped, the token itself
 * lands in a family's text message. These are the nets for that.
 */
describe("no internal codes in an outbound family SMS", () => {
  const SAMPLE: Record<string, string> = {
    stopLabel: "OKEE-PARK", eta: "08:12", etaEnd: "08:22",
    sessionStart: "13:30", legDate: "2026-10-14", date: "2026-10-14", reasonCode: "WEATHER",
  };
  const vars = (t: string, over: Record<string, string> = {}): Record<string, string> => ({
    ...Object.fromEntries(Object.keys(TEMPLATE_VARS[t]).map((v) => [v, SAMPLE[v]])),
    ...over,
  });
  /** The same vars with no window end, which is how a message reads when only one time is known. */
  const noWindow = (v: Record<string, string>): Record<string, string> => {
    const { etaEnd: _dropped, ...rest } = v;
    return rest;
  };
  const stopTemplates = knownTemplates().filter((t) => templatePlaceholders(t).includes("stopLabel"));
  const tokens = Object.keys(copy.outboundSms.stops);

  it("every template renders with no code and no raw token in it", () => {
    for (const t of knownTemplates()) {
      const body = renderTemplate(t, vars(t));
      expect(codesIn(body), `${t}: ${body}`).toEqual([]);
      expect(tokensIn(body), `${t}: ${body}`).toEqual([]);
    }
    expect(stopTemplates.length).toBeGreaterThan(0);
  });

  it("every stop token becomes its place, with a window and with a single time", () => {
    for (const t of stopTemplates) {
      for (const token of tokens) {
        const withWindow = vars(t, { stopLabel: token });
        for (const v of [withWindow, noWindow(withWindow)]) {
          const body = renderTemplate(t, v);
          expect(body, `${t}/${token}`).toContain(copy.outboundSms.stops[token as keyof typeof copy.outboundSms.stops]);
          expect(tokensIn(body), `${t}/${token}`).toEqual([]);
        }
      }
    }
  });

  it("a token with no place name is replaced, never printed", () => {
    for (const t of stopTemplates) {
      const body = renderTemplate(t, vars(t, { stopLabel: "NEW-STOP" }));
      expect(body, t).toContain(UNKNOWN_STOP);
      expect(tokensIn(body), t).toEqual([]);
    }
  });
});
