import { getNeonDb } from "@/db/exec";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";
import { DbSimMessagingProvider } from "@/modules/messaging/sim-provider";
import type { DrainDeps } from "./outbox";
import { identityGateway } from "@/modules/identity/gateway";
import { gatewayRecipientAuthorizer } from "./policy";

/** P1 wiring: SIM provider only (APP_DATA_CLASS=SYNTHETIC, ADR-006). One instance per server process. */
let deps: DrainDeps | undefined;
export function outboxDeps(): DrainDeps {
  if (!deps) {
    const db = getNeonDb();
    deps = {
      provider: new DbSimMessagingProvider(db, new VercelQueueScheduler(db, vercelQueueTransport)),
      /*
       * THE DRAIN'S CONSENT CHECK, OFF THE APP CONNECTION (S1-6).
       *
       * This line used to read `dbRecipientAuthorizer(db)`, and `db` is `getNeonDb()` — the
       * application connection, whose role has no SELECT on `identity` (src/db/schema.ts:104).
       * So the one check that decides whether a family may be texted raised `permission denied
       * for schema identity` on any deployment with the real role split. It is the gateway's
       * question now, answered by whichever gateway this data class wires (ADR-015).
       */
      authorizer: gatewayRecipientAuthorizer(identityGateway()),
    };
  }
  return deps;
}
