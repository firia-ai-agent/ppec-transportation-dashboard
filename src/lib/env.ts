import { z } from "zod";

/**
 * Boot guard (ADR-015, DECISION-LEDGER #4). P1 runs on synthetic data only:
 * any value other than exactly "SYNTHETIC" stops the build and the server.
 * Secrets are validated by name only and never echoed.
 */
const bootSchema = z.object({
  APP_DATA_CLASS: z.literal("SYNTHETIC"),
  DEMO_MODE: z.enum(["0", "1"]).optional(),
});

export type BootEnv = z.infer<typeof bootSchema>;

export class BootEnvError extends Error {}

export function assertBootEnv(env: Record<string, string | undefined>): BootEnv {
  const parsed = bootSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new BootEnvError(
      `Refusing to start: invalid or missing env [${names}]. APP_DATA_CLASS must be SYNTHETIC (ADR-015).`,
    );
  }
  return parsed.data;
}

/**
 * True while this deployment runs on synthetic data (ADR-015). Drives the DEMO banner
 * (DESIGN-DIRECTION §7) and the header source-mode badge (§7.1) so the UI never has to be
 * told twice which world it is in. Non-throwing on purpose: the hard guard is
 * `assertBootEnv`, called from next.config.ts, and a render must not be the thing that fails.
 */
export function isSyntheticDemo(env: Record<string, string | undefined> = process.env): boolean {
  return env.APP_DATA_CLASS === "SYNTHETIC";
}

/**
 * The `source_mode` the UI stamps on this screen (NFR-09, §7.1). Synthetic deployments are
 * SIMULATED; anything else is LIVE, which is where the P1 build stops.
 */
export function uiSourceMode(
  env: Record<string, string | undefined> = process.env,
): "SIMULATED" | "LIVE" {
  return isSyntheticDemo(env) ? "SIMULATED" : "LIVE";
}
