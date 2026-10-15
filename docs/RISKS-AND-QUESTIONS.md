# Risks and questions

```
READER: founder (§1 only), team (§2–3). DECISION IT SERVES: what the founder must answer; what is still unproven.
```

## 1. Founder questions
All three answered 2026-10-14 11:23 ET (see DECISION-LEDGER.md): Q1 exit bar = PASS (mock) on AT-01–18 + TEST-INF-01; Q2 $100/month alert; Q3 Claude Sonnet (current), zdr:true. No open founder questions.

## 2. Risks
| Risk | Effect | Mitigation | Owner |
|---|---|---|---|
| Vercel Queues is Beta; messages pinned to the publishing deployment | timers late or lost after deploy | DB is source of truth; cron sweeper + re-arm (ADR-001); fallback QStash behind JobScheduler | Rudy |
| Cron 1-minute floor | if Queues fails, NFR-03 ≤5 s unmet | founder decision needed only if TEST-INF-01 fails | Rudy |
| SSE on functions: 300 s cap, 1 query/s per client | cost/latency | 290 s self-close; measure in B-12 | Rudy |
| No BAA (Vercel add-on not bought; Neon BAA only on Scale; OpenRouter none) | any real child data would be a violation | synthetic-only enforcement (ADR-015) | Veri |
| Live LLM on synthetic data still sees prompts | injection, cost | token-only gateway, ZDR routing, eval set, budget alert | Athena |
| OSM tile and OSRM demo usage policies | blocked tiles in demo | fixtures for routes; tile URL env-configurable | Rudy |
| Auth.js v5 is still `beta` on npm | API churn | pin exact version; IdentityGateway seam toward Entra | Rudy |
| Credentials auth has no built-in MFA | NFR MFA not met in POC | MFA, rate limiting/lockout, and server-side sign-out with an absolute session cap are built in B-16 (in scope for the POC exit, not deferred) | Veri |
| Mocks mask real-vendor behavior (Twilio retries, Teams throttling) | false confidence | "PASS (mock)" label; live gates open (Q1) | Veri |

## 3. Unverified close-out
| # | Claim | Why unverified | How to verify | Owner |
|---|---|---|---|---|
| U1 | Vercel Queues delivers delayed messages within ≤5 s of due | not measured | TEST-INF-01 lateness histogram | Rudy/Veri |
| U2 | Neon compute restart can be triggered on our plan | not tried | Neon console/API in drill C | Rudy |
| U3 | SSE commit→screen p95 <3 s | not measured | B-12 measurement | Rudy |
| U4 | Function cost of open SSE streams | not measured | Vercel usage after 1 week demo | Rudy |
| U5 | Neon us-east-1 latency from iad1 | not measured | timing probe | Rudy |
| U6 | LISTEN over Neon WebSockets direct connection | not tested | spike (only needed for AWS path anyway) | Athena |
| U7 | OpenRouter `zdr:true` excludes first-party Anthropic for the chosen model at call time | read from docs/listing, not from a live call | live call; inspect provider in response | Athena |
| U8 | Schema applies cleanly on real Neon | PGlite only | migrate on a Neon branch in B-02 | Rudy |
| U9 | drizzle + `@neondatabase/serverless` 1.2.0 Pool transactions with `after()` cleanup | not run | B-01 spike | Rudy |
| U10 | Re-estimate effort for Vercel+mock scope | PRD numbers assume AWS + live | Rudy estimate | Rudy |
| U11 | Vercel/Neon BAA terms and prices | read from vendor pages 2026-10-14; may change | re-check before any PHI | Athena |
| U12 | **Closed by design, 2026-10-14 (DECISION-LEDGER row 60).** Was: Vercel Queues honours **sub-second** `delaySeconds`, required by row 58. The Queues docs promise no sub-second precision (`delaySeconds` is documented only as "Delay in seconds"), so the timer path no longer asks for any: every published delay is a whole second and the sub-second part of a lease is waited out inside the invocation (`recheckLeaseInline`). The probe still runs, now informational — it quantifies the precision we gave up and feeds U13 | Queues is Beta and its delay granularity is undocumented — which is the reason it is no longer depended on | TEST-INF-01 step 8: `GET /api/probe/delay` (Bearer `CRON_SECRET`, no DB, runs on a preview) → topic `ppec-delay-probe`, whose consumer logs `[delay-probe] id=… requested=… actual=… ms`. No outcome of it changes the design; a delivery floor far above the request is a U13 jitter finding | Rudy/Veri |
| U13 | Vercel Queues' real delay **distribution** (p50/p90/p99/max lateness, duplicate rate, loss) — Athena's research (PR #21) confirms delivery is at-least-once, **unordered**, and carries **no delay SLA** at all, so the 4.95 s worst case in ADR-001 (row 60) is a simulation, not a measurement — and the only Queues property it still depends on | the service documents no bound on delivery lateness; Queues is Beta | TEST-INF-01 step 8b: `scripts/test-inf-01/delay-accuracy.ts` (**PROPOSED, not run** — needs a preview deployment and Firia's go-ahead) sends 300 probes through `GET /api/probe/delay` and reports min/p50/p90/p99/max, counts late >250 ms and >1 s, missing and duplicate deliveries | Rudy/Veri |
| U14 | Whether Vercel honours `retryAfterSeconds: 2` on a queue trigger, or clamps it up | the Queues docs state no minimum and @vercel/queue 0.8.0 does not validate the value, it only forwards what vercel.json says | TEST-INF-01: force a handler failure on the preview and read the gap between deliveries off the function logs. Clamped ⇒ harmless (the sweeper is the backstop), but ADR-001's recovery numbers then rest on the re-wake alone | Rudy |
