import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { demoResetCliGate, type CliGate } from "./reset";

/**
 * scripts/demo-reset.ts truncates the demo data. It is an operator tool: it must refuse whenever
 * VERCEL_ENV is set to anything at all, so it can only be typed into a local shell and never run from
 * a Vercel build, function, cron or deploy hook against the one shared DB (DECISION-LEDGER #43).
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const CLI = "scripts/demo-reset.ts";
const synthetic = { APP_DATA_CLASS: "SYNTHETIC" };

/** The refusal text, or "allowed" — so a gate that lets the run through fails the expectation loudly. */
const refusal = (g: CliGate) => (g.allowed ? "allowed" : g.reason);

it("refuses for every value of VERCEL_ENV, ahead of --confirm and the data class", () => {
  for (const VERCEL_ENV of ["preview", "production", "development", "", "PREVIEW", "anything-else"]) {
    const reason = refusal(demoResetCliGate({ ...synthetic, VERCEL_ENV }, ["--confirm"]));
    expect(reason).toMatch(/^refusing: never run from a Vercel environment/);
    expect(reason).toMatch(/local operator shell/);
  }
});

it("still requires --confirm and SYNTHETIC in a local shell, and allows the run when both hold", () => {
  expect(demoResetCliGate(synthetic, ["--confirm"])).toEqual({ allowed: true });
  expect(demoResetCliGate(synthetic, ["--confirm", "--site", "x"])).toEqual({ allowed: true });
  expect(refusal(demoResetCliGate(synthetic, []))).toMatch(/--confirm/);
  expect(refusal(demoResetCliGate({ APP_DATA_CLASS: "REAL" }, ["--confirm"]))).toMatch(/SYNTHETIC/);
  expect(refusal(demoResetCliGate({}, ["--confirm"]))).toMatch(/SYNTHETIC/);
});

it("the CLI itself exits non-zero on a Vercel environment, before any connection", () => {
  const tsx = resolve(ROOT, "node_modules", ".bin", "tsx");
  expect(existsSync(tsx)).toBe(true);
  for (const VERCEL_ENV of ["preview", "production"]) {
    let code: number | undefined;
    let stderr = "";
    try {
      execFileSync(tsx, [CLI, "--confirm"], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        // Everything the happy path needs is present; only VERCEL_ENV should stop it.
        env: { ...process.env, VERCEL_ENV, APP_DATA_CLASS: "SYNTHETIC", DATABASE_URL_UNPOOLED: "postgresql://u:p@db.example.com/x" },
      });
      code = 0;
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      code = err.status;
      stderr = err.stderr ?? "";
    }
    expect({ VERCEL_ENV, code }).toEqual({ VERCEL_ENV, code: 1 });
    expect(stderr).toMatch(/demo reset refused: refusing: never run from a Vercel environment/);
    expect(stderr).not.toMatch(/db\.example\.com|postgresql:\/\//);
  }
}, 60_000);
