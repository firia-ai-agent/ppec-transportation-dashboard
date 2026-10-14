# ADR-002 Realtime: SSE tailing event_log
**Status: Proposed** (Firia, 2026-10-14).
**Decision.** `GET /api/stream` (Node runtime) polls `ops.event_log WHERE site_id=$1 AND seq>$last` every 1 s via Neon HTTP, emits `id: seq`, honors `Last-Event-ID`, self-closes at 290 s (under the 300 s Pro default) and the browser's EventSource reconnects. Behind `RealtimeBus`; on AWS swap to LISTEN/NOTIFY on a direct connection.
**Alternatives.** LISTEN/NOTIFY now (impossible on Neon pooled/PgBouncer transaction mode). Pusher/Ably (vendor + data path). Client polling (works; worse UX and more requests).
**Cost note.** Fluid compute bills active CPU, not I/O wait; open stream cost per user is Unverified until measured in B-04.
**Test.** Same restart drills as TEST-INF-01: kill stream mid-flight; no missed or duplicate seq after reconnect.
**Evidence.** https://vercel.com/docs/functions/limitations ; https://neon.com/docs/connect/connection-pooling .
