/**
 * The slice-2 harness, wired to the **live** executors instead of the intent recorder: a run that
 * reads and writes the operational tables, with the real outbox behind its sends.
 *
 * Everything scripted stays scripted — the model is still `FakeProvider`, the gateway and the
 * policy engine are the real ones — so a failure in a slice-3 suite is an executor's, not a
 * vendor's. The two pieces this adds are the executor dependencies (a `JobScheduler` to cancel an
 * acknowledgment's deadline, the outbox's wake-up transport) and `drainOutbox`, which runs the
 * send-time half: a message the agent queued only becomes a send when the outbox re-checks
 * staleness, suppression, consent and the recipient's authorization for that child (§11.2
 * "egress re-check"; outbox/outbox.drain).
 */
import type { Db } from "@/db/exec";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { type JobScheduler, VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { type DrainDeps, type DrainResult, drain } from "@/modules/outbox/outbox";
import { dbRecipientAuthorizer } from "@/modules/outbox/policy";
import { SimMessagingProvider } from "@/modules/outbox/provider";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import type { ToolExecutor } from "../executors";
import { type Harness, type HarnessInput, runHarness } from "../harness";
import type { DispatcherLinkSigner, ExecutorDeps } from "./effects";
import { liveExecutors, liveProposalWriter } from "./registry";

export type LiveHarnessInput = Omit<HarnessInput, "executors" | "overrides"> & {
  /** Per-tool executors layered **over** the live registry, for a tool with no live executor yet. */
  readonly overrides?: Readonly<Record<string, ToolExecutor>>;
  /**
   * The dispatcher-link signer seam (`exec/effects.ts`). P1 configures none, so a suite that wants
   * a link row supplies one of its own — exactly as it supplies the clock.
   */
  readonly linkSigner?: DispatcherLinkSigner;
};

export type LiveHarness = Harness & {
  readonly execDeps: ExecutorDeps;
  readonly scheduler: JobScheduler;
  readonly outboxTransport: FakeOutboxTransport;
  /** The provider the outbox would hand a message to. `sent` is the only true "a message left". */
  readonly provider: SimMessagingProvider;
  readonly drainDeps: DrainDeps;
  /** Drain every message the run queued, in order. Returns one outcome per message. */
  drainOutbox(): Promise<DrainResult[]>;
};

export function liveHarness(input: LiveHarnessInput): LiveHarness {
  const wake = new FakeTransport();
  const outboxTransport = new FakeOutboxTransport();
  const scheduler = new VercelQueueScheduler(input.db, wake, () => input.now());
  const execDeps: ExecutorDeps = {
    db: input.db, scheduler, transport: outboxTransport, linkSigner: input.linkSigner,
  };
  const provider = new SimMessagingProvider();
  const drainDeps: DrainDeps = {
    provider,
    authorizer: dbRecipientAuthorizer(input.db),
    clock: () => input.now(),
    timeoutMs: 500,
  };
  const base = runHarness({
    ...input,
    executors: { ...liveExecutors(execDeps), ...(input.overrides ?? {}) },
    proposals: liveProposalWriter(execDeps),
  });
  return {
    ...base,
    execDeps,
    scheduler,
    outboxTransport,
    provider,
    drainDeps,
    drainOutbox: () => drainQueued(input.db, drainDeps),
  };
}

/** Every QUEUED outbound row, drained oldest first. */
export async function drainQueued(db: Db, deps: DrainDeps): Promise<DrainResult[]> {
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM ops.outbound_message WHERE state = 'QUEUED' ORDER BY created_at, id",
    [],
  );
  const out: DrainResult[] = [];
  for (const r of rows.rows) out.push(await drain(db, r.id, deps));
  return out;
}
