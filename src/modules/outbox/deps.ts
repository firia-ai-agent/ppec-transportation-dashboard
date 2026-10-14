import { getNeonDb } from "@/db/exec";
import type { DrainDeps } from "./outbox";
import { dbRecipientAuthorizer } from "./policy";
import { SimMessagingProvider } from "./provider";

/** P1 wiring: SIM provider only (APP_DATA_CLASS=SYNTHETIC, ADR-006). One instance per server process. */
let deps: DrainDeps | undefined;
export function outboxDeps(): DrainDeps {
  deps ??= { provider: new SimMessagingProvider(), authorizer: dbRecipientAuthorizer(getNeonDb()) };
  return deps;
}
