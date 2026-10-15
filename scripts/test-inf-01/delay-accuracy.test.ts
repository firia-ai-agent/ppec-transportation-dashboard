import { describe, expect, it } from "vitest";
import {
  CALLS, LATE_THRESHOLDS_MS, PROBES_PER_CALL, TOTAL_MESSAGES,
  distribution, parseProbeLog, percentile, refuseOnProduction, requestedFromId, subSecondVerdict, summarize, toCsv,
  type Measurement, type Probe,
} from "./delay-accuracy";

// Unit tests for the PROPOSED TEST-INF-01 harness (scripts/test-inf-01/delay-accuracy.ts). The live run is
// not what is tested here — the *stats* are, so that when the run does happen its report can be trusted.
// Nothing here opens a socket, reads an env var, or touches a database.

const probe = (requested: number, n: number): Probe => ({ id: `run-a:1:${requested}#${n}`, requested });
const line = (p: Probe, actualMs: number) => `[delay-probe] id=${p.id} requested=${p.requested} actual=${actualMs} ms`;

describe("percentile / distribution", () => {
  it("is nearest-rank, so p99 of 100 samples is the 99th and max is the 100th", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(s, 0), percentile(s, 50), percentile(s, 90), percentile(s, 99), percentile(s, 100)]).toEqual([1, 50, 90, 99, 100]);
  });
  it("never reads off the end of a short sample", () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(() => percentile([], 50)).toThrow();
  });
  it("sorts numerically, not lexically (1000 ms must not sort before 250 ms)", () => {
    expect(distribution([1000, 250, 90])).toEqual({ count: 3, min: 90, p50: 250, p90: 1000, p99: 1000, max: 1000 });
  });
  it("returns null rather than NaN for an empty sample", () => expect(distribution([])).toBeNull());
});

describe("requestedFromId / parseProbeLog", () => {
  it("reads the requested delay out of the route's id format", () => {
    expect(requestedFromId("01a1:2:0.75")).toBe(0.75);
    expect(requestedFromId("01a1:2:0.75#3")).toBeNull(); // not a number → ignored, never NaN into the stats
    expect(requestedFromId("nonsense")).toBeNull();
  });

  it("extracts only the consumer's measurement lines, in order, from a noisy capture", () => {
    const text = [
      "Running build in Washington, D.C., USA (East) – iad1",
      "[queue:timer] skipped (preview)",
      "[delay-probe] id=r:1:0.25 requested=0.25 actual=263 ms",
      "some other line mentioning delay-probe but not matching",
      "[delay-probe] id=r:1:1.5 requested=1.5 actual=1502 ms",
      "[delay-probe] id=r:1:0.25 requested=0.25 actual=1263 ms",
    ].join("\n");
    expect(parseProbeLog(text)).toEqual([
      { id: "r:1:0.25", requested: 0.25, actualMs: 263 },
      { id: "r:1:1.5", requested: 1.5, actualMs: 1502 },
      { id: "r:1:0.25", requested: 0.25, actualMs: 1263 },
    ]);
  });

  it("finds nothing in an empty or unrelated capture", () => {
    expect(parseProbeLog("")).toEqual([]);
    expect(parseProbeLog("no probe lines here\n")).toEqual([]);
  });
});

describe("summarize", () => {
  it("reports the lateness distribution, the late counts, and both thresholds", () => {
    const ps = [probe(0.25, 1), probe(0.25, 2), probe(0.25, 3), probe(0.25, 4)];
    // Lateness = actual − requested·1000: 10, 260, 1_010, 2_010 ms.
    const log = [line(ps[0], 260), line(ps[1], 510), line(ps[2], 1_260), line(ps[3], 2_260)].join("\n");
    const s = summarize(ps, parseProbeLog(log));
    expect(s).toMatchObject({ requestedMessages: 4, delivered: 4, missing: 0, duplicateDeliveries: 0, unmatched: 0 });
    expect(s.lateness).toEqual({ count: 4, min: 10, p50: 260, p90: 2_010, p99: 2_010, max: 2_010 });
    expect([s.lateOver250ms, s.lateOver1s]).toEqual([3, 2]);
    expect(LATE_THRESHOLDS_MS).toEqual([250, 1_000]);
  });

  it("counts a message that never arrived as missing, not as late", () => {
    const ps = [probe(0.5, 1), probe(0.5, 2)];
    const s = summarize(ps, parseProbeLog(line(ps[0], 505)));
    expect(s).toMatchObject({ requestedMessages: 2, delivered: 1, missing: 1 });
    expect(s.lateness).toEqual({ count: 1, min: 5, p50: 5, p90: 5, p99: 5, max: 5 });
    expect(s.byRequested).toEqual([{ requested: 0.5, requestedMessages: 2, missing: 1, count: 1, min: 5, p50: 5, p90: 5, p99: 5, max: 5 }]);
  });

  it("scores only the FIRST delivery of an id, so an at-least-once retry is a duplicate and not a 60 s outlier", () => {
    const p = probe(0.25, 1);
    const s = summarize([p], parseProbeLog([line(p, 260), line(p, 60_260), line(p, 120_260)].join("\n")));
    expect(s).toMatchObject({ delivered: 1, missing: 0, duplicateDeliveries: 2, duplicatedIds: [p.id] });
    expect(s.lateness).toEqual({ count: 1, min: 10, p50: 10, p90: 10, p99: 10, max: 10 });
    expect(s.lateOver1s).toBe(0); // the 60 s retries must not be charged as lateness
  });

  it("ignores log lines from a different run instead of mixing them in", () => {
    const p = probe(0.25, 1);
    const foreign = "[delay-probe] id=other-run:1:0.25 requested=0.25 actual=9999 ms";
    const s = summarize([p], parseProbeLog([line(p, 260), foreign].join("\n")));
    expect(s).toMatchObject({ delivered: 1, unmatched: 1, duplicateDeliveries: 0 });
    expect(s.lateness?.max).toBe(10);
  });

  it("uses the manifest's requested delay, not the log line's, when the two disagree", () => {
    const p = probe(0.25, 1);
    const tampered: Measurement[] = [{ id: p.id, requested: 5, actualMs: 260 }];
    expect(summarize([p], tampered).lateness?.max).toBe(10); // 260 − 250, not 260 − 5000
  });

  it("splits by requested delay, which is where flooring or rounding shows up", () => {
    const ps = [probe(0.25, 1), probe(0.75, 1), probe(1.75, 1)];
    // Every sub-second request delivered at ~1 s: the signature of rounding up to whole seconds.
    const s = summarize(ps, parseProbeLog([line(ps[0], 1_000), line(ps[1], 1_000), line(ps[2], 1_760)].join("\n")));
    expect(s.byRequested.map((g) => [g.requested, g.p50])).toEqual([[0.25, 750], [0.75, 250], [1.75, 10]]);
    expect(subSecondVerdict(s)).toMatch(/^FAIL:/);
  });

  it("is empty-safe: no manifest and no logs is a report, not a crash", () => {
    const s = summarize([], []);
    expect(s).toMatchObject({ requestedMessages: 0, delivered: 0, missing: 0, lateness: null, byRequested: [] });
    expect(subSecondVerdict(s)).toMatch(/^INCONCLUSIVE:/);
    expect(toCsv(s)).toContain("requested_s,messages");
  });
});

describe("verdict", () => {
  const withSub = (p50ForQuarter: number, p50ForThreeQuarter: number) =>
    summarize([probe(0.25, 1), probe(0.75, 1)], [
      { id: "run-a:1:0.25#1", requested: 0.25, actualMs: 250 + p50ForQuarter },
      { id: "run-a:1:0.75#1", requested: 0.75, actualMs: 750 + p50ForThreeQuarter },
    ].map((m) => ({ ...m, id: `run-a:1:${m.requested}#1` })) as Measurement[]);

  it("PASSes when sub-second delays are honoured", () => expect(subSecondVerdict(withSub(12, 15))).toMatch(/^PASS:/));
  it("FAILs when every sub-second bucket lands at ~1 s", () => expect(subSecondVerdict(withSub(750, 250))).toMatch(/^FAIL:/));
  it("flags MIXED when only some buckets look rounded", () => expect(subSecondVerdict(withSub(750, 15))).toMatch(/^MIXED:/));
});

describe("safety rails", () => {
  it("refuses on production and nowhere else", () => {
    expect(refuseOnProduction({ VERCEL_ENV: "production" })).toMatch(/refusing to run/);
    for (const env of [{}, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: undefined }]) {
      expect(refuseOnProduction(env)).toBeNull();
    }
  });
  it("the refusal names no env value and no secret", () => {
    const msg = refuseOnProduction({ VERCEL_ENV: "production", CRON_SECRET: "s3cret" }) as string;
    expect(msg).not.toContain("s3cret");
    expect(msg).not.toMatch(/VERCEL_ENV=/);
  });
  it("25 calls × 12 probes is the 300 messages the test plan asks for", () => {
    expect(TOTAL_MESSAGES).toBe(300);
    expect(CALLS * PROBES_PER_CALL).toBe(TOTAL_MESSAGES);
  });
});

describe("toCsv", () => {
  it("emits one row per requested delay, an ALL row, and the counts as comments", () => {
    const ps = [probe(0.25, 1), probe(1.5, 1)];
    const s = summarize(ps, parseProbeLog([line(ps[0], 1_500), line(ps[1], 1_510)].join("\n")));
    const csv = toCsv(s).trim().split("\n");
    expect(csv[0]).toBe("requested_s,messages,delivered,missing,late_min_ms,late_p50_ms,late_p90_ms,late_p99_ms,late_max_ms");
    expect(csv[1]).toBe("0.25,1,1,0,1250,1250,1250,1250,1250");
    expect(csv[2]).toBe("1.5,1,1,0,10,10,10,10,10");
    expect(csv[3]).toBe("ALL,2,2,0,10,10,1250,1250,1250"); // nearest-rank p50 of two samples is the lower one
    expect(csv.slice(4)).toEqual(["# late_over_250ms,1", "# late_over_1s,1", "# duplicate_deliveries,0", "# unmatched_log_lines,0"]);
  });

  it("leaves cells blank rather than writing NaN when a bucket got nothing", () => {
    const s = summarize([probe(0.25, 1)], []);
    expect(toCsv(s).split("\n")[1]).toBe("0.25,1,0,1,,,,,");
  });
});
