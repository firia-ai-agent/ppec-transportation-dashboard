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
| Credentials auth has no built-in MFA | NFR MFA not met in POC | demo users only; MFA in P2 via IdP | Veri |
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
