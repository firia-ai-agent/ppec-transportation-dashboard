import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildBoard } from "@/domain/board/board";
import { adapterHealth, type AdapterStatus } from "@/domain/health/adapters";
import {
  BASELINE_ROWS,
  dayCounts,
  metricByKey,
  type RoiMetric,
} from "@/domain/health/metrics";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { countable, fill, health, nav, pluralize, serviceDate } from "@/ui/copy";
import { pageOutcome, rolesWhoCanOpen } from "@/auth/access";
import {
  adapterDegraded,
  adapterDoing,
  adapterMockedBecause,
  adapterModeChip,
  adapterName,
  metricLabel,
  metricLine,
  metricValue,
  metricWhy,
  ridesHeading,
} from "./lines";

/**
 * The words this screen puts on a number, and who may open the screen at all.
 *
 * The counting is tested in src/domain/health; what is here is the half a reader actually sees —
 * which sentence a count picks, and that no count ever reaches the screen without its noun.
 * "1 rides need a person" is the line that would make a founder distrust every number beside
 * it, so each of the four has its zero, its one and its many written out and asserted.
 */

const BOARD = buildBoard();
const COUNTS = dayCounts(BOARD);
/** SMS, maps and the assistant: the three parts of the system the panel claims anything about. */
const ADAPTER_ROWS = 3;
const DEMO_ENV: Record<string, string | undefined> = {
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
  DEMO_MODE: "1",
};

/** A metric with the same shape as a real one, for the counts the demo day does not reach. */
function asIf(metric: RoiMetric, over: Partial<RoiMetric>): RoiMetric {
  return { ...metric, ...over };
}

describe("every number is readable, whatever it counted", () => {
  it("prints a ratio where the shortfall matters and a bare count where it does not", () => {
    expect(metricValue(metricByKey(COUNTS, "CHILDREN_PLACED"))).toMatch(/^\d+ of \d+$/);
    expect(metricValue(metricByKey(COUNTS, "VAN_UNCHECKED"))).toMatch(/^\d+ of \d+$/);
    expect(metricValue(metricByKey(COUNTS, "ARRIVING_LATE"))).toMatch(/^\d+$/);
    expect(metricValue(metricByKey(COUNTS, "NEEDS_A_PERSON"))).toMatch(/^\d+$/);
  });

  it("leaves no placeholder unfilled in any sentence, on any count", () => {
    for (const metric of COUNTS.metrics) {
      for (const count of [0, 1, 2, 9]) {
        const line = metricLine(asIf(metric, { count, minutes: count === 0 ? null : 1 }));
        expect(line, `${metric.key} at ${count}`).not.toMatch(/[{}]/);
        // A sentence, closed with one full stop. It may open on a numeral — "11 rides are on a
        // van nobody has checked today" — but never on a zero: that is what the `none` and
        // `nobody` lines are for, and the next assertion holds them.
        expect(line, `${metric.key} at ${count}`).toMatch(/^[A-Z0-9].*\.$/);
        expect(line, `${metric.key} at ${count}`).not.toMatch(/^0\b/);
      }
    }
  });

  it("never prints a bare count without its noun", () => {
    for (const metric of COUNTS.metrics) {
      for (const count of [1, 2, 11]) {
        const line = metricLine(asIf(metric, { count, minutes: 1 }));
        // A digit is always followed by a word, never by a full stop or a comma.
        expect(line.match(/\d+(?=[.,])/), `${metric.key} at ${count}: ${line}`).toBeNull();
      }
    }
  });

  it("says 'minute' at one minute and 'minutes' at more", () => {
    const late = metricByKey(COUNTS, "ARRIVING_LATE");
    expect(metricLine(asIf(late, { count: 4, minutes: 1 }))).toContain(
      pluralize(1, countable.minute),
    );
    expect(metricLine(asIf(late, { count: 4, minutes: 12 }))).toContain(
      pluralize(12, countable.minute),
    );
  });

  it("says 'ride' at one ride and 'rides' at more", () => {
    const unchecked = metricByKey(COUNTS, "VAN_UNCHECKED");
    expect(ridesHeading(asIf(unchecked, { legKeys: ["C1/AM"] }))).toContain(
      pluralize(1, countable.ride),
    );
    expect(ridesHeading(asIf(unchecked, { legKeys: ["C1/AM", "C1/PM"] }))).toContain(
      pluralize(2, countable.ride),
    );
  });

  it("heads the list with what the list holds, not with what the number counted", () => {
    // "Children with a seat: 18 rides" over eighteen rows, never "9 rides" over eighteen.
    const placed = metricByKey(COUNTS, "CHILDREN_PLACED");
    expect(placed.count).not.toBe(placed.legKeys.length);
    expect(ridesHeading(placed)).toBe(
      fill(health.ridesHeading, {
        label: metricLabel("CHILDREN_PLACED"),
        rides: pluralize(placed.legKeys.length, countable.ride),
      }),
    );
  });
});

describe("the sentences the demo day actually produces", () => {
  it("says every child who rides with us has a seat, because they all do", () => {
    expect(metricLine(metricByKey(COUNTS, "CHILDREN_PLACED"))).toBe(
      health.metrics.CHILDREN_PLACED.all,
    );
  });

  it("names the one child whose ride needs a person (AT-13), rather than making it a lookup", () => {
    const metric = metricByKey(COUNTS, "NEEDS_A_PERSON");
    const line = metricLine(metric);
    expect(metric.children).toHaveLength(1);
    expect(line).toContain(metric.children[0]);
    expect(line).toBe(fill(health.metrics.NEEDS_A_PERSON.one, { child: metric.children[0] }));
  });

  it("says how far the furthest arrival has moved, in minutes and not in seconds", () => {
    const metric = metricByKey(COUNTS, "ARRIVING_LATE");
    expect(metricLine(metric)).toContain(pluralize(metric.minutes ?? 0, countable.minute));
    expect(metricLine(metric)).not.toMatch(/\bseconds?\b/);
  });

  it("gives every number a reason it is on the screen at all", () => {
    for (const metric of COUNTS.metrics) {
      expect(metricWhy(metric.key), metric.key).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("no internals and no jargon on the numbers", () => {
  /** Every string the screen puts on a number. The watermark is checked on its own below:
   *  "SYNTHETIC" is the one all-capitals word on this screen that is deliberate. */
  const everything = [
    health.intro,
    health.roiHeading,
    health.sampleNote,
    ...COUNTS.metrics.flatMap((m) => [
      metricValue(m),
      metricLabel(m.key),
      metricLine(m),
      metricWhy(m.key),
      ridesHeading(m),
    ]),
    ...adapterHealth(BOARD, DEMO_ENV).rows.flatMap((row) => [
      adapterName(row.key),
      adapterModeChip(row).label,
      adapterDoing(row),
      adapterMockedBecause(row) ?? "",
      adapterDegraded(row.key),
    ]),
  ];

  it("never writes 'ETA', a ride id, a state code or a metric id", () => {
    for (const text of everything) {
      expect(text).not.toMatch(/\bETA\b/);
      // Ride and leg keys ("C2/PM", "L-C1-AM"), state enums, and the §17 metric ids.
      expect(text).not.toMatch(/\bC\d+\/(?:AM|PM)\b/);
      expect(text).not.toMatch(/\b[A-Z][A-Z_]{4,}\b/);
      expect(text).not.toMatch(/\bMET-\d+\b/);
    }
  });

  it("never names a vehicle by its fixture code", () => {
    for (const text of everything) expect(text).not.toMatch(/\bV\d\b/);
  });

  it("writes the watermark as the one word SURF-07 asks for and nothing else", () => {
    expect(health.watermark).toBe("SYNTHETIC");
  });

  it("holds the confidence note COPY-GUIDE §5 fixes, with the cohort in it", () => {
    const note = fill(health.sampleNote, { children: COUNTS.children, rides: COUNTS.rides });
    expect(note).toContain("Synthetic data");
    expect(note).toContain(`n = ${COUNTS.children} children`);
    expect(note).toContain("Not a real result.");
  });
});

describe("the adapter panel never reads as 'all fine'", () => {
  const panel = adapterHealth(BOARD, DEMO_ENV);

  it("wears no 'ok' tone on a mocked row, and no green is what says so", () => {
    for (const row of panel.rows) {
      expect(row.mode).toBe("MOCK");
      expect(adapterModeChip(row).tone, row.key).toBe("neutral");
    }
  });

  it("says the word 'Mocked' on every row, so the colour is never the only cue (§3)", () => {
    for (const row of panel.rows) {
      expect(adapterModeChip(row).label).toBe(health.adapterPanel.modes.MOCK);
    }
  });

  it("takes the live chip only when a row really is live", () => {
    const live: AdapterStatus = { key: "SMS", mode: "LIVE", mockedBecause: null, facts: {} };
    expect(adapterModeChip(live).label).toBe(health.adapterPanel.modes.LIVE);
    expect(adapterModeChip(live).tone).toBe("ok");
    expect(adapterMockedBecause(live)).toBeNull();
  });

  it("uses an icon that is neither a state icon nor the Simulated badge's flask", () => {
    const icons = panel.rows.map((row) => adapterModeChip(row).icon.displayName);
    expect(icons).not.toContain("FlaskConical");
    for (const name of icons) expect(name).toBe("Unplug");
  });

  it("every row says what it is doing, why it is mocked, and what a person does instead", () => {
    for (const row of panel.rows) {
      expect(adapterDoing(row), row.key).toMatch(/^[A-Z0-9].*\.$/);
      expect(adapterDoing(row), row.key).not.toMatch(/[{}]/);
      expect(adapterMockedBecause(row), row.key).toMatch(/^[A-Z].*\.$/);
      expect(adapterDegraded(row.key), row.key).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("says 'none was worth a text' rather than printing a zero", () => {
    const sms: AdapterStatus = {
      key: "SMS",
      mode: "MOCK",
      mockedBecause: "NO_CARRIER_ADAPTER",
      facts: { considered: 63, sent: 0 },
    };
    expect(adapterDoing(sms)).toBe(fill(health.adapterPanel.doing.SMS_NONE_SENT, { considered: 63 }));
    expect(adapterDoing({ ...sms, facts: { considered: 63, sent: 2 } })).toBe(
      fill(health.adapterPanel.doing.SMS, { considered: 63, sent: 2 }),
    );
  });

  it("says no arrival update is paused rather than printing a zero", () => {
    const maps: AdapterStatus = {
      key: "MAPS",
      mode: "MOCK",
      mockedBecause: "REPLAYED_ROUTES",
      facts: { vans: 3, locating: 3, paused: 0 },
    };
    expect(adapterDoing(maps)).toBe(
      fill(health.adapterPanel.doing.MAPS_NONE_PAUSED, { vans: 3, locating: 3 }),
    );
  });
});

/* ───────────────────────────── the guard, and what renders ───────────────────────────── */

vi.mock("@/auth/caller", () => ({ getCaller: vi.fn() }));
const { getCaller } = await import("@/auth/caller");
const mockedCaller = vi.mocked(getCaller);

const SITE = "01900000-0000-7000-8000-000000000001";

/** A visitor with no session at all: the guard sends them to sign in rather than refusing them. */
const ANONYMOUS = { kind: "ANONYMOUS" as const, memberships: [] };

function staff(role: "DIRECTOR" | "COORDINATOR" | "FRONT_DESK") {
  return {
    kind: "STAFF" as const,
    role,
    userId: "00000000-0000-7000-8000-0000000000d1",
    displayName: "SYN Dana Director",
    memberships: [{ siteId: SITE, role }],
  };
}

async function openPage() {
  const mod = await import("./page");
  return mod.default();
}

describe("hours saved and money saved: visible, and carrying no number (PRD §17.4)", () => {
  /** Every string the two rows put on the screen, including the words under each label. */
  const baselineText = [
    health.baseline.heading,
    health.baseline.intro,
    health.baseline.noNumber,
    ...Object.values(health.baseline.columns),
    ...BASELINE_ROWS.flatMap((key) => [
      health.baseline.rows[key].label,
      health.baseline.rows[key].detail,
    ]),
  ];

  it("has a row for each of the two, and no third row anybody could add a figure to", () => {
    expect(BASELINE_ROWS).toEqual(["HOURS_SAVED", "MONEY_SAVED"]);
    expect(health.baseline.rows.HOURS_SAVED.label).toBe("Hours saved");
    expect(health.baseline.rows.MONEY_SAVED.label).toBe("Money saved");
  });

  /**
   * The ruling this test exists for: no estimate, no assumption, no figure from §17.3's
   * parameter table. A digit anywhere in these strings is the failure, because a digit is what
   * a cropped screenshot turns into a claim — which is why "four weeks" is spelled.
   */
  it("renders no digit at all in either row", () => {
    for (const text of baselineText) expect(text, text).not.toMatch(/\d/);
  });

  it("says what has to happen first, in both rows: the first four weeks of use", () => {
    for (const key of BASELINE_ROWS) {
      expect(health.baseline.rows[key].detail, key).toContain("first four weeks of use");
    }
  });

  it("puts words where a figure would be, rather than a blank, a dash or a nought", () => {
    expect(health.baseline.noNumber).toBe("Not measured yet");
    expect(health.baseline.noNumber).not.toMatch(/^[\s\u2014\u2013-]*$/);
  });

  it("never writes 'ETA', a metric id or a state code in either row", () => {
    for (const text of baselineText) {
      expect(text, text).not.toMatch(/\bETA\b/);
      expect(text, text).not.toMatch(/\bMET-\d+\b/);
      expect(text, text).not.toMatch(/\b[A-Z][A-Z_]{4,}\b/);
    }
  });

  it("is on the page for a coordinator, under the numbers the day was actually counted on", async () => {
    mockedCaller.mockResolvedValue(staff("COORDINATOR"));
    const html = renderToStaticMarkup(await openPage());

    for (const key of BASELINE_ROWS) {
      expect(html, key).toContain(`data-baseline-row="${key}"`);
      expect(html, key).toContain(escapeHtml(health.baseline.rows[key].label));
      expect(html, key).toContain(escapeHtml(health.baseline.rows[key].detail));
    }
    expect(html).toContain(escapeHtml(health.baseline.heading));
    expect(html).toContain(escapeHtml(health.baseline.intro));
    // Once per row, so neither reads as the only one without a number.
    expect(html.match(new RegExp(health.baseline.noNumber, "g"))).toHaveLength(
      BASELINE_ROWS.length,
    );

    // §17's measured numbers lead: the counted panel is above these rows on the page.
    expect(html.indexOf(health.roiHeading)).toBeLessThan(html.indexOf(health.baseline.heading));

    // Neither row is a control. The four tiles open their rides; there is nothing behind these.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(COUNTS.metrics.length);
  });

  /**
   * The rendered cells, not just the copy. A figure could still arrive through a template or a
   * stray count, so the two rows are cut out of the markup and read for digits as they ship.
   */
  it("renders the two rows with no digit in the markup either", async () => {
    mockedCaller.mockResolvedValue(staff("COORDINATOR"));
    const html = renderToStaticMarkup(await openPage());
    for (const key of BASELINE_ROWS) {
      const start = html.indexOf(`data-baseline-row="${key}"`);
      expect(start, key).toBeGreaterThan(-1);
      const row = html.slice(start, html.indexOf("</tr>", start));
      // The row's own `data-baseline-row` value and class hashes are not read text; what a
      // person sees is what is between the tags.
      const readable = row.replace(/<[^>]*>/g, " ");
      expect(readable, `${key}: ${readable}`).not.toMatch(/\d/);
    }
  });

  /**
   * The third place a figure could hide, after the page and the drill-down: an attribute. The
   * test above strips tags before reading, so a `title="about 6 hours a week"` or an
   * `aria-label` carrying a figure would pass it and still be read out — by a pointer hovering
   * the row, and by a screen reader instead of the visible text.
   *
   * So the row's attributes are read on their own, from the other end: rather than hunting for
   * a digit in each value, the test names every attribute the row is allowed to carry. Three,
   * and none of them is spoken — `scope` on the header cell, the CSS module's hashed `class`
   * (whose hash is digits, which is why reading values for digits is the wrong net here), and
   * the `data-baseline-row` key this test finds the row by. A tooltip, an `aria-label` or any
   * other way of attaching words to the row is a new attribute, and a new attribute fails.
   */
  it("hangs no tooltip and no spoken attribute off either row", async () => {
    const INERT = new Set(["scope", "class", "data-baseline-row"]);
    mockedCaller.mockResolvedValue(staff("COORDINATOR"));
    const html = renderToStaticMarkup(await openPage());
    for (const key of BASELINE_ROWS) {
      const start = html.indexOf(`data-baseline-row="${key}"`);
      const row = html.slice(start, html.indexOf("</tr>", start));
      // No tooltip: neither the native one nor the described-by kind the header's Start uses.
      expect(row, key).not.toMatch(/\stitle=/);
      expect(row, key).not.toMatch(/aria-describedby=/);
      expect(row, key).not.toMatch(/role="tooltip"/);
      const attributes = [...row.matchAll(/\s([a-zA-Z-]+)="[^"]*"/g)].map(([, name]) => name);
      expect(attributes.length, key).toBeGreaterThan(0);
      for (const name of attributes) expect(INERT, `${key}: ${name}`).toContain(name);
    }
  });

  /**
   * The drill-down is the one part of this screen that renders rides, and a ride carries times
   * and counts. Neither savings row may open one: the panel is keyed by the metric it was
   * counted from, and a figure reached from "Hours saved" would be the claim in two clicks
   * that the row refuses in one.
   *
   * Two nets, because the screen is a client component and this test renders it once. There is
   * no control inside either row to click — no button, no link, no `aria-expanded` — and
   * neither row's key is among the four the drill-down can be opened on, which is what the
   * open-metric state is read from.
   */
  it("puts no control inside either row, so neither opens a drill-down", async () => {
    mockedCaller.mockResolvedValue(staff("COORDINATOR"));
    const html = renderToStaticMarkup(await openPage());
    for (const key of BASELINE_ROWS) {
      const start = html.indexOf(`data-baseline-row="${key}"`);
      const row = html.slice(start, html.indexOf("</tr>", start));
      expect(row, key).not.toMatch(/<button\b/);
      expect(row, key).not.toMatch(/<a\b/);
      expect(row, key).not.toMatch(/aria-expanded=/);
      // And it is not one of the four a number can be opened on.
      expect(COUNTS.metrics.map((m) => m.key), key).not.toContain(key);
    }
  });
});

describe("the guard on /health", () => {
  it("is in the access table, and only the two console roles are in its row", () => {
    expect(rolesWhoCanOpen("/health")).toEqual(["DIRECTOR", "COORDINATOR"]);
  });

  it("refuses the front desk and a signed-out visitor before it renders anything", async () => {
    expect(pageOutcome(staff("FRONT_DESK"), "/health")).toBe("NO_ACCESS");
    expect(pageOutcome(ANONYMOUS, "/health")).toBe("SIGN_IN");

    mockedCaller.mockResolvedValue(staff("FRONT_DESK"));
    await expect(openPage()).rejects.toBeTruthy();
    mockedCaller.mockResolvedValue(ANONYMOUS);
    await expect(openPage()).rejects.toBeTruthy();
  });

  it("renders the numbers and the adapter panel for a coordinator", async () => {
    mockedCaller.mockResolvedValue(staff("COORDINATOR"));
    const html = renderToStaticMarkup(await openPage());

    // The heading is the nav's own label, so the rail and the page cannot drift apart.
    expect(html).toContain(escapeHtml(nav.health));
    expect(html).toContain(serviceDate.phases[BOARD.day.phase]);
    expect(html).toContain(health.roiHeading);
    expect(html).toContain(health.adapterPanel.heading);

    // Four numbers, each with its label and its sentence, and nothing hardcoded between them.
    for (const metric of COUNTS.metrics) {
      expect(html, metric.key).toContain(metricLabel(metric.key));
      expect(html, metric.key).toContain(escapeHtml(metricLine(metric)));
    }

    // SURF-07: one watermark, and the cohort under the numbers.
    expect(html.match(new RegExp(health.watermark, "g"))).toHaveLength(1);
    expect(html).toContain(
      escapeHtml(fill(health.sampleNote, { children: COUNTS.children, rides: COUNTS.rides })),
    );

    // SURF-06: the panel says nothing is live before it shows a row, and every row's mode chip
    // says "Mocked" in words — never a green tone and never a bare colour (§3).
    expect(html).toContain(escapeHtml(health.adapterPanel.allMockedIntro));
    expect(html).not.toContain(health.adapterPanel.someLiveIntro);
    expect(html.match(/data-tone="ok"/g)).toBeNull();
    expect(html.match(new RegExp(health.adapterPanel.modes.MOCK, "g"))).toHaveLength(
      // Once for the eye and once for the ear on each of the three rows (§9).
      ADAPTER_ROWS * 2,
    );
    expect(html).not.toContain(`>${health.adapterPanel.modes.LIVE}<`);

    // Every number is a control, and nothing is open until one is pressed.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(COUNTS.metrics.length);
    expect(html).toContain(health.showRides);
    expect(html).not.toContain(health.hideRides);
  });

  it("mounts no second DEMO bar and no second source chip: the root layout owns both", async () => {
    mockedCaller.mockResolvedValue(staff("DIRECTOR"));
    const html = renderToStaticMarkup(await openPage());
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('data-token="src-sim"');
  });
});

/** React escapes these on the way out, so an expected string has to be escaped to be found. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
