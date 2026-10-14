/**
 * ═══ PROPOSED — NOT RUN ═══════════════════════════════════════════════════════════════════════════════
 * Harness for **TEST-INF-01 run 1** (Vercel Queues delay accuracy). It has **not been run**. Running it
 * needs (a) a **preview deployment** of this branch to aim at and (b) **Firia's go-ahead**, because it
 * publishes 300 real queue messages and so costs real invocations on a Beta service. Nothing here is
 * evidence of anything until that run happens and its report is attached to the ledger.
 *
 * ── What it answers ───────────────────────────────────────────────────────────────────────────────────
 * DECISION-LEDGER row 56 (2 s claim lease + millisecond re-wake delays) is **conditional** on Vercel Queues
 * honouring sub-second `delaySeconds`, and Athena's research (PR #21) says the service documents
 * at-least-once, unordered delivery with **no delay SLA** at all. RISKS-AND-QUESTIONS U1 and U12. So:
 *   - Is `delaySeconds` honoured at sub-second granularity, or floored / rounded up to whole seconds?
 *   - What does the lateness distribution look like (p50/p90/p99/max), and how often is it > 250 ms / > 1 s?
 *   - Does at-least-once show up in practice (duplicates), and does anything go missing?
 * If delays are rounded up to whole seconds, row 56 is reverted to the row 38 parameters (3 s lease,
 * whole-second re-wakes) and the 6.2 s p100 is reported instead — see ADR-001 Consequences.
 *
 * ── How it works ──────────────────────────────────────────────────────────────────────────────────────
 * Two phases, because the measurement itself has to happen on the deployment:
 *
 *   1. `send`   — calls the existing `GET /api/probe/delay` 25 times (12 probes each = 300 messages), which
 *                 publishes to topic `ppec-delay-probe` **from the deployment**, so `sentAt` and the
 *                 consumer's `Date.now()` are both Vercel clocks and no laptop clock skew enters the
 *                 measurement. Writes the ids it was told were sent to a manifest file.
 *   2. `report` — takes the manifest plus a capture of the deployment's logs (`vercel logs … > probe.log`),
 *                 parses the consumer's `[delay-probe] id=… requested=… actual=… ms` lines, and writes the
 *                 lateness distribution as JSON and CSV.
 *
 * ── Safety rails ──────────────────────────────────────────────────────────────────────────────────────
 *   - **Refuses to run when `VERCEL_ENV=production`** (both phases, before anything else).
 *   - **Never touches the database.** No `pg`, no drizzle, no `DATABASE_URL` — it speaks HTTP only. This is
 *     what lets it run against a preview at all: previews share the one production DB read-only (#43).
 *   - **Never prints an env value.** `CRON_SECRET` is read and put in an `Authorization` header, never
 *     logged, and scrubbed out of any error text. The target URL is a required CLI argument, not an env
 *     var, so nothing read from the environment is ever echoed.
 *
 * ── Usage (once approved) ─────────────────────────────────────────────────────────────────────────────
 *   CRON_SECRET=… npx tsx scripts/test-inf-01/delay-accuracy.ts send   --url https://<preview>.vercel.app
 *   vercel logs <preview-deployment> > /tmp/probe.log      # or any capture containing the consumer lines
 *   npx tsx scripts/test-inf-01/delay-accuracy.ts report --logs /tmp/probe.log
 *
 * Output: `scripts/test-inf-01/out/{manifest,report}.json` and `out/report.csv` (override with `--out`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Probes per call to GET /api/probe/delay (PROBE_DELAYS_SECONDS.length × PASSES in that route). */
export const PROBES_PER_CALL = 12;
/** 25 × 12 = the 300 messages TEST-INF-01 run 1 calls for. */
export const CALLS = 25;
export const TOTAL_MESSAGES = CALLS * PROBES_PER_CALL;
/** Spacing between calls, so the 300 probes spread over ~50 s instead of landing as one burst. */
export const CALL_SPACING_MS = 2_000;
/** Lateness thresholds reported as counts (NFR-03 cares about seconds; 250 ms is the re-wake margin). */
export const LATE_THRESHOLDS_MS = [250, 1_000] as const;

const DEFAULT_OUT = join(__dirname, "out");

// ── Pure stats (unit-tested in delay-accuracy.test.ts) ────────────────────────────────────────────────

/** One message we were told was published, and the delay it asked for (parsed out of the probe id). */
export type Probe = { id: string; requested: number };
/** One delivery observed in the consumer's log. `actualMs` is publish → delivery, measured on Vercel. */
export type Measurement = { id: string; requested: number; actualMs: number };

export type Distribution = { count: number; min: number; p50: number; p90: number; p99: number; max: number };
export type Summary = {
  requestedMessages: number;
  /** Distinct manifest ids seen at least once. */
  delivered: number;
  /** Manifest ids never seen in the logs. At-least-once promises no upper bound, so this should be 0. */
  missing: number;
  /** Deliveries beyond the first for a manifest id — the at-least-once duplicate rate. */
  duplicateDeliveries: number;
  duplicatedIds: string[];
  /** Log lines whose id is not in the manifest (another run's probes in the same log capture). */
  unmatched: number;
  /** Lateness = actual − requested, in ms, over the first delivery of each id. Null when nothing matched. */
  lateness: Distribution | null;
  lateOver250ms: number;
  lateOver1s: number;
  /** Same distribution split by requested delay — this is where flooring/rounding shows up. */
  byRequested: ({ requested: number; requestedMessages: number; missing: number } & Partial<Distribution>)[];
};

/** Nearest-rank percentile over an ascending-sorted array. `p` is 0–100. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error("percentile of an empty sample");
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

export function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return { count: s.length, min: s[0], p50: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), max: s[s.length - 1] };
}

/**
 * The delay the probe asked for, encoded in its id by /api/probe/delay as `<run>:<pass>:<requested>`.
 * Returns null for anything that is not one of our ids, so a foreign log line cannot poison the stats.
 */
export function requestedFromId(id: string): number | null {
  const tail = id.split(":").at(-1);
  const n = tail === undefined ? NaN : Number(tail);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pull the consumer's measurement lines out of an arbitrary log capture. The format is fixed by
 * src/app/api/queues/delay-probe/route.ts; everything else in the capture (build output, other routes) is
 * ignored, and lines are returned in the order they appear so the *first* delivery of an id is identifiable.
 */
export function parseProbeLog(text: string): Measurement[] {
  const re = /\[delay-probe] id=(\S+) requested=([0-9.]+) actual=(-?\d+) ms/g;
  const out: Measurement[] = [];
  for (const m of text.matchAll(re)) out.push({ id: m[1], requested: Number(m[2]), actualMs: Number(m[3]) });
  return out;
}

/**
 * Fold the manifest and the observed deliveries into the report. Lateness uses the **first** delivery of
 * each id; later ones are counted as duplicates instead, so an at-least-once retry 60 s later cannot be
 * mistaken for a 60 s-late delivery.
 */
export function summarize(manifest: Probe[], measurements: Measurement[]): Summary {
  const wanted = new Map(manifest.map((p) => [p.id, p.requested]));
  const first = new Map<string, Measurement>();
  let duplicateDeliveries = 0, unmatched = 0;
  const duplicatedIds: string[] = [];
  for (const m of measurements) {
    if (!wanted.has(m.id)) { unmatched++; continue; }
    if (first.has(m.id)) {
      duplicateDeliveries++;
      if (!duplicatedIds.includes(m.id)) duplicatedIds.push(m.id);
      continue;
    }
    first.set(m.id, m);
  }

  // Trust the manifest's requested delay, not the log line's: the id is what ties the two together.
  const lateness = (ids: string[]) => ids.flatMap((id) => {
    const m = first.get(id);
    return m ? [m.actualMs - (wanted.get(id) as number) * 1000] : [];
  });

  const allIds = [...wanted.keys()];
  const all = lateness(allIds);
  const groups = [...new Set(manifest.map((p) => p.requested))].sort((a, b) => a - b);

  return {
    requestedMessages: manifest.length,
    delivered: first.size,
    missing: manifest.length - first.size,
    duplicateDeliveries,
    duplicatedIds,
    unmatched,
    lateness: distribution(all),
    lateOver250ms: all.filter((v) => v > LATE_THRESHOLDS_MS[0]).length,
    lateOver1s: all.filter((v) => v > LATE_THRESHOLDS_MS[1]).length,
    byRequested: groups.map((requested) => {
      const ids = allIds.filter((id) => wanted.get(id) === requested);
      const d = distribution(lateness(ids));
      return { requested, requestedMessages: ids.length, missing: ids.length - ids.filter((id) => first.has(id)).length, ...(d ?? {}) };
    }),
  };
}

const CSV_COLUMNS = ["requested_s", "messages", "delivered", "missing", "late_min_ms", "late_p50_ms", "late_p90_ms", "late_p99_ms", "late_max_ms"] as const;

/** One row per requested delay plus an ALL row; the overall counts ride along as trailing comment rows. */
export function toCsv(s: Summary): string {
  const cell = (v: number | undefined) => (v === undefined ? "" : String(v));
  const rows = [
    CSV_COLUMNS.join(","),
    ...s.byRequested.map((g) => [cell(g.requested), cell(g.requestedMessages), cell((g.count ?? 0)), cell(g.missing), cell(g.min), cell(g.p50), cell(g.p90), cell(g.p99), cell(g.max)].join(",")),
    ["ALL", cell(s.requestedMessages), cell(s.delivered), cell(s.missing), cell(s.lateness?.min), cell(s.lateness?.p50), cell(s.lateness?.p90), cell(s.lateness?.p99), cell(s.lateness?.max)].join(","),
    `# late_over_250ms,${s.lateOver250ms}`,
    `# late_over_1s,${s.lateOver1s}`,
    `# duplicate_deliveries,${s.duplicateDeliveries}`,
    `# unmatched_log_lines,${s.unmatched}`,
  ];
  return `${rows.join("\n")}\n`;
}

/** Verdict on the question row 56 hangs on, from the sub-second buckets alone. */
export function subSecondVerdict(s: Summary): string {
  const sub = s.byRequested.filter((g) => g.requested < 1 && g.count);
  if (sub.length === 0) return "INCONCLUSIVE: no sub-second probe was delivered";
  // Rounding a sub-second request up to 1 s shows as lateness ≈ (1000 − requested·1000) ms.
  const rounded = sub.filter((g) => (g.p50 as number) >= (1 - g.requested) * 1000 * 0.8);
  if (rounded.length === sub.length) return "FAIL: sub-second delays look rounded up to whole seconds → revert row 56 to the row 38 parameters";
  if (rounded.length > 0) return "MIXED: some sub-second buckets look rounded up — inspect byRequested before deciding";
  return "PASS: sub-second delays are honoured (row 56 stands, subject to the lateness numbers above)";
}

// ── I/O and CLI (not unit-tested; needs a live preview deployment) ────────────────────────────────────

/** Both phases refuse here. Production is never a TEST-INF-01 target: row 18's synthetic prod run is separate. */
export function refuseOnProduction(env: Record<string, string | undefined>): string | null {
  return env.VERCEL_ENV === "production"
    ? "refusing to run: this is the production environment; TEST-INF-01 run 1 targets a preview deployment only"
    : null;
}

/** Strip the secret out of anything we are about to print, in case a transport error echoed it back. */
function scrub(text: string, secret: string | undefined) {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function write(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`[delay-accuracy] wrote ${file}`);
}

async function sendPhase(argv: string[], env: Record<string, string | undefined>) {
  const url = arg(argv, "url");
  const secret = env.CRON_SECRET;
  if (!url) throw new Error("--url <preview deployment origin> is required (passed explicitly, never read from the env)");
  if (!secret) throw new Error("CRON_SECRET is not set in the environment"); // the name, never the value
  const out = arg(argv, "out") ?? DEFAULT_OUT;

  const manifest: Probe[] = [];
  for (let call = 1; call <= CALLS; call++) {
    const res = await fetch(new URL("/api/probe/delay", url), { headers: { authorization: `Bearer ${secret}` } });
    const body = (await res.json()) as { sent?: number; ids?: string[]; error?: string };
    if (!res.ok || !body.ids) throw new Error(scrub(`probe call ${call} failed: ${res.status} ${body.error ?? ""}`, secret));
    for (const id of body.ids) {
      const requested = requestedFromId(id);
      if (requested !== null) manifest.push({ id, requested });
    }
    console.log(`[delay-accuracy] call ${call}/${CALLS}: ${body.ids.length} probes (${manifest.length}/${TOTAL_MESSAGES} total)`);
    if (call < CALLS) await new Promise((r) => setTimeout(r, CALL_SPACING_MS));
  }
  write(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[delay-accuracy] now capture the deployment's logs and run: report --logs <file>`);
}

function reportPhase(argv: string[]) {
  const logs = arg(argv, "logs");
  if (!logs) throw new Error("--logs <file> is required (a capture containing the [delay-probe] consumer lines)");
  const out = arg(argv, "out") ?? DEFAULT_OUT;
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Probe[];
  const measurements = parseProbeLog(readFileSync(logs, "utf8"));
  const summary = summarize(manifest, measurements);
  write(join(out, "report.json"), `${JSON.stringify({ ...summary, verdict: subSecondVerdict(summary) }, null, 2)}\n`);
  write(join(out, "report.csv"), toCsv(summary));
  console.log(`[delay-accuracy] ${subSecondVerdict(summary)}`);
}

async function main() {
  const refusal = refuseOnProduction(process.env);
  if (refusal) { console.error(`[delay-accuracy] ${refusal}`); process.exitCode = 1; return; }
  const argv = process.argv.slice(2);
  const phase = argv[0];
  if (phase === "send") await sendPhase(argv, process.env);
  else if (phase === "report") reportPhase(argv);
  else { console.error("[delay-accuracy] usage: delay-accuracy.ts send --url <origin> | report --logs <file>"); process.exitCode = 1; }
}

// Importing this file (the unit tests do) must not start a run: only a direct `tsx …/delay-accuracy.ts` does.
if (/[/\\]delay-accuracy\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error(`[delay-accuracy] ${scrub(e instanceof Error ? e.message : String(e), process.env.CRON_SECRET)}`); process.exitCode = 1; });
}
