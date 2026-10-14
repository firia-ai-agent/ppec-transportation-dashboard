import { getNeonDb } from "@/db/exec";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";
import { DbSimMessagingProvider } from "@/modules/messaging/sim-provider";
import type { DrainDeps } from "./outbox";
import { dbRecipientAuthorizer } from "./policy";

/** P1 wiring: SIM provider only (APP_DATA_CLASS=SYNTHETIC, ADR-006). One instance per server process. */
let deps: DrainDeps | undefined;
export function outboxDeps(): DrainDeps {
  if (!deps) {
    const db = getNeonDb();
    deps = {
      provider: new DbSimMessagingProvider(db, new VercelQueueScheduler(db, vercelQueueTransport)),
      authorizer: dbRecipientAuthorizer(db),
    };
  }
  return deps;
}
