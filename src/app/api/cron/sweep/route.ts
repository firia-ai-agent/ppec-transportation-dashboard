import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { cronAuthorized } from "@/lib/cron-auth";
import { CLOCK_PARAM, requestedBoardDay } from "@/domain/board/day";
import { dueEtaNotices } from "@/modules/demo/late-dropoff";
import { handlers } from "@/modules/jobs/handlers";
import { sweep } from "@/modules/jobs/runner";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";
import { sweepEtaNotices } from "@/modules/messaging/eta-notice";
import { sweepOutbox } from "@/modules/outbox/outbox";
import { outboxDeps } from "@/modules/outbox/deps";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Production: Vercel Cron every minute (vercel.json).
// Previews share the one production DB and run read-only (DECISION-LEDGER #43), so the sweep — which
// claims jobs and sends outbox messages — refuses there: 200 + {skipped}, so it does not spam errors.
export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const skip = previewSkip(process.env);
  if (skip) return Response.json(skip, { headers: { "cache-control": "no-store" } });
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID ?? "local";
  const db = getNeonDb();
  const report = await sweep(db, vercelQueueTransport, deploymentId, handlers);
  /*
   * The deterministic ETA notice (PRD §18.2 step 7 / AT-03), before the outbox sweep below so that
   * a text this run queues also leaves on this run. Idempotent on the leg, the scenario date and
   * the window the crossing published, so every later minute writes nothing, and gated inside the
   * module on the ADR-015 data class and the ADR-014 demo switch — on a deployment holding real
   * data it refuses by name and queues nothing at all.
   *
   * Two clocks, because the module compares two different things (see `sweepEtaNotices`): wall time
   * stamps the row, and the scenario clock decides which crossings have *happened*. The scenario
   * instant is the demo day read at the tick this request may name — `requestedBoardDay` is the one
   * seam a tick reaches a projection through, and it refuses the parameter on every deployment
   * (`VERCEL_ENV` is set on all of them), so in production this is the board's own instant and the
   * afternoon's crossings are still ahead of it. That is what keeps the first sweep after a reset
   * from queueing the whole day at six in the morning.
   */
  const scenarioDay = requestedBoardDay(null, new URL(req.url).searchParams.get(CLOCK_PARAM), process.env);
  const etaNotices = await sweepEtaNotices(db, vercelQueueOutboxTransport, {
    due: dueEtaNotices(),
    now: new Date(),
    scenarioNow: new Date(scenarioDay.instantMs),
  });
  const outbox = await sweepOutbox(db, outboxDeps());
  return Response.json({ deploymentId, ...report, etaNotices, outbox });
}
