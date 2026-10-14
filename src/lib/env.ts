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
