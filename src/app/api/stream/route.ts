/**
 * The live board stream (ADR-002, PRD §14 SURF-01 "SSE with reconnect delta").
 *
 * A loop and a writer. Every decision about *what* to send is in
 * src/modules/realtime/live-board-stream.ts and every decision about *how* to write it is in
 * src/modules/realtime/sse.ts, both pure and both tested without a server; this file holds the
 * two things only a route can hold — the guard, and a connection that stays open.
 *
 * Guarded by the one access table like every other session route (src/auth/access.ts): the two
 * console roles, because this is SURF-01's data and the front desk's surface is the ramp iPad.
 * It takes **no site id**: the board is the seeded site's demo day, read from committed
 * fixtures, so a site id in the query is ignored rather than honoured — which is the answer
 * BUILD-PLAN §4's ID-swap row asks for ("SSE subscribe with other site id in query ⇒ stream
 * scoped to session site").
 *
 * No database: the morning is the deterministic replay the board itself is computed from
 * (docs/ui/B12-SLICE3-DEFERRED.md explains why there is no `ops.event_log` tail yet, and what
 * replaces this loop when slice 4's writes give it one). Nothing is sent anywhere, and the only
 * socket involved is the one the browser opened.
 */

import { API, mapViewerOf } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { liveStreamConfig } from "@/config/live";
import { requestedClockSpeed } from "@/domain/board/day";
import { parseLastTick, tickIntervalMs } from "@/domain/eta/scenario-clock";
import { advance, openStream, streamExpired } from "@/modules/realtime/live-board-stream";
import { encodeFrame, encodeRetry, LAST_EVENT_ID_HEADER, SSE_HEADERS } from "@/modules/realtime/sse";

/** A connection that stays open is never a static response. */
export const dynamic = "force-dynamic";
/** A long-lived stream and a `setInterval`: the Node runtime, as ADR-002 specifies. */
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const guard = await requireApiSession(API.stream);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  /*
   * The resume point. The browser sends `Last-Event-ID` by itself on a reconnect; `?since=` is
   * the same value for a caller that reconnects by hand (a test, a `curl`). Anything that is
   * not a tick means "send me the whole board", which is correct and merely larger.
   */
  const lastTick = parseLastTick(
    request.headers.get(LAST_EVENT_ID_HEADER) ?? url.searchParams.get("since"),
  );
  /*
   * §6.2's clock speeds. ×1 on the console — the demo day runs at the speed of a day — and the
   * faster two are the review and test path, behind the *same gate* `?date=` is behind
   * (`requestedClockSpeed` → `dateOverrideAllowed`, src/domain/board/day.ts): a subscriber on
   * any deployment is walked at ×1 whatever it asked for. They only ever change how long we
   * wait between ticks, never what a tick contains (PRD §8).
   */
  const speed = requestedClockSpeed(url.searchParams.get("speed"), process.env);

  /*
   * What this subscriber may see. The same matrix the live map reads
   * (src/domain/access/map-view.ts), applied to the payload rather than to the markup: the two
   * console roles differ by the fault internals, and a coordinator's browser is never sent them.
   */
  const viewer = mapViewerOf(guard.caller);
  const opened = openStream(lastTick, viewer);
  const startedAtMs = Date.now();
  const encoder = new TextEncoder();
  let tick = opened.tick;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away between our check and this write. Nothing to recover.
          open = false;
        }
      };
      const stop = (): void => {
        if (timer) clearInterval(timer);
        timer = undefined;
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the platform; closing twice is not an error worth raising.
        }
      };

      write(encodeRetry(liveStreamConfig.reconnectAfterMs));
      for (const frame of opened.frames) write(encodeFrame(frame));

      timer = setInterval(() => {
        const elapsedMs = Date.now() - startedAtMs;
        // ADR-002: self-close under the platform ceiling and let the browser come back with
        // `Last-Event-ID`, which is the reconnect this whole protocol is designed around.
        if (streamExpired(elapsedMs)) {
          stop();
          return;
        }
        const step = advance(opened.tick, tick, elapsedMs, speed, viewer);
        tick = step.tick;
        for (const frame of step.frames) write(encodeFrame(frame));
      }, tickIntervalMs(speed));

      request.signal.addEventListener("abort", stop);
    },
    cancel() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
