/**
 * Server-sent events, as text (ADR-002).
 *
 * The wire format and nothing else: the headers a stream answers with, and how one event is
 * written down. No clock, no board, no request — so the three things that are easy to get
 * wrong about SSE and impossible to see in a browser (the id that a reconnect resumes from,
 * the blank line that ends an event, the `retry:` the client obeys) are unit-testable.
 *
 * Why SSE at all rather than a socket: ADR-002. One direction, through any proxy, with a
 * reconnect the browser performs for us and an id we choose.
 */

/** The event names the live board sends. The client switches on these. */
export const LIVE_EVENT = {
  /** The whole board at a tick. Sent to a client that holds nothing. */
  snapshot: "snapshot",
  /** What changed since the tick named in the payload. */
  delta: "delta",
  /**
   * Nothing changed. Carries no `id`, so the client's `Last-Event-ID` is untouched — it exists
   * only so a quiet stream still looks alive: DESIGN-DIRECTION §2's amber bar is for a stream
   * that *stopped*, and a morning with nothing happening in it must not raise it.
   */
  idle: "idle",
} as const;

export type LiveEventName = (typeof LIVE_EVENT)[keyof typeof LIVE_EVENT];

/** One event. `id` is omitted where it must not move the client's resume point. */
export interface SseFrame {
  event: LiveEventName;
  data: unknown;
  id?: number;
}

export const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * The response headers. `no-store` because a cached event stream is not a stream, and
 * `X-Accel-Buffering: no` because a buffering proxy turns a live board into a slideshow.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": `${SSE_CONTENT_TYPE}; charset=utf-8`,
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/** `retry: <ms>` — how long the browser waits before reconnecting. Sent once, first. */
export function encodeRetry(ms: number): string {
  return `retry: ${Math.max(0, Math.round(ms))}\n\n`;
}

/** A comment line. Not delivered to any handler; keeps a connection warm through a proxy. */
export function encodeComment(text: string): string {
  return `: ${text.replace(/\r?\n/g, " ")}\n\n`;
}

/**
 * One event as the protocol writes it: the optional id, the event name, one `data:` line of
 * JSON, then the blank line that means "dispatch it". JSON can contain no raw newline, so one
 * line is always enough — and the encoder asserts nothing about the payload beyond that.
 */
export function encodeFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return `${lines.join("\n")}\n\n`;
}

/** The header a reconnecting browser sends, lower-cased the way `Headers` gives it to us. */
export const LAST_EVENT_ID_HEADER = "last-event-id";
