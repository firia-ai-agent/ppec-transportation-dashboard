# Build plan

```
READER: Rudy, Veri, Vera, Athena; parent for Linear/Notion setup. DECISION IT SERVES: order of work and tracking structure.
SOURCE: PRD §20 (B-01–B-16), §18.3 AT list, ADR-000…015. Status: Proposed unless labeled.
```

## Summary
- Same 16 PRD backlog items, re-scoped for Vercel+Neon and mocks. Live-integration work (Twilio, Teams SDK, Traccar, Amazon/Google routing, HIPAA AWS account) becomes a seam + mock now and a real adapter later.
- Critical path: B-01 → B-02 → B-03 (timers, TEST-INF-01) → B-08 (agent) → B-15 (acceptance). B-12 console runs in parallel from B-03.
- No effort numbers here: the PRD's ED estimates assume the live-integration scope and AWS, so they don't carry over (Unverified until Rudy re-estimates).

## 1. Milestones
| ID | PRD scope | This POC scope | Owner | Gate |
|---|---|---|---|---|
| B-01 | Repo, CI, IaC, AWS account | New repo under firia-ai-agent; Next 16, pnpm, CI (typecheck, lint, test, drizzle check, seed linter); Vercel project on firia1 + Neon integration; env matrix | Rudy | preview deploy green |
| B-02 | Schema + 8 machines + migrations | schema-draft.ts → migration 0000; FKs; transition tests per machine | Rudy / Veri | all edge tests |
| B-03 | JobScheduler (pg-boss) + outbox + TEST-INF-01 | ADR-001 queues+cron+claim; ADR-003 outbox; TEST-INF-01 3 runs | Rudy / Veri | TEST-INF-01 pass |
| B-04 | MessagingProvider + Twilio + consent | SIM provider, persona phones, STOP/HELP/NL opt-out, consent ledger; Twilio adapter stub | Rudy / Vera | AT-09 (part) |
| B-05 | Group MMS harness | Mock-only group-thread fixture; real EXP-GRP-01 stays open | Athena | — |
| B-06 | Teams SDK | Teams mock panel, cards, 409 race | Rudy / Vera | AT-18 (mock) |
| B-07 | IdentityGateway, tokenization | identity schema, AES-GCM + HMAC, family isolation | Rudy / Veri | ID-swap matrix |
| B-08 | Agent runtime, LLM gateway, tools, policy, injection evals | OpenRouter ZDR gateway, §11.2 tools, policy engine, eval set | Rudy / Athena | AT-01/06/07/09, TEST-SEC-01 |
| B-09 | Capacity solver | Same | Rudy | AT-04/05/12 |
| B-10 | Telemetry ingest, replay, faults | Simulator + LocationIngest + faults | Rudy | AT-11 |
| B-11 | Routing + ETA + hysteresis | OSRM fixtures + traffic model + ETA hysteresis | Rudy / Athena | AT-03 |
| B-12 | Console + SSE | Board, drawer, inbox, exceptions, map, SSE (ADR-002) | Vera / Rudy | UI review |
| B-13 | Ramp iPad, dispatcher form, setup | Same; vehicle config screens | Vera / Rudy | AT-04, AT-10, AT-13 |
| B-14 | Metrics, ROI, health, EOD | Same, cohort SYNTHETIC | Rudy | AT-15/16 |
| B-15 | Acceptance suite, demo reset/replay, evidence | Demo panel (MOCKS-AND-DEMO §6), Playwright suite, evidence export | Veri | 12-step demo |
| B-16 | Security baseline | Auth.js+RBAC, secret scanning, log scrubber, dependency audit; MFA Unverified for Credentials (not built in) | Veri | security checklist |

## 2. Acceptance test mapping
| AT | Milestone(s) | Mock used |
|---|---|---|
| AT-01 message→state→notify | B-04, B-08 | SMS |
| AT-02 timer follow-up + escalation | B-03 | — |
| AT-03 traffic delay, hysteresis, replay | B-10, B-11 | GPS, routing |
| AT-04 unknown equipment at arrival | B-09, B-13 | vehicles |
| AT-05 substitution | B-09 | vehicles |
| AT-06 sibling ambiguity | B-08 | SMS |
| AT-07 leg vs full-day | B-02, B-08 | SMS |
| AT-08 manual correction invalidates queued msg | B-03, B-12 | SMS |
| AT-09 wrong recipient / injection | B-04, B-07, B-08 | SMS |
| AT-10 geofence ≠ handoff | B-10, B-13 | GPS |
| AT-11 duplicate/out-of-order + loss | B-10 | GPS |
| AT-12 no feasible vehicle | B-09 | vehicles |
| AT-13 no receiving adult | B-02, B-13 | — |
| AT-14 therapist ≤10 min + ack | B-03, B-06 | Teams |
| AT-15 ROI drill-down | B-14 | — |
| AT-16 EOD blocks close | B-14 | — |
| AT-17 import without name/DOB merge | B-07 | CSV fixture |
| AT-18 Teams proactive + card + race | B-06 | Teams |
| TEST-INF-01 | B-03 | — |
| TEST-SEC-01/02 | B-08 | egress log |
Mocked ATs pass as "PASS (mock)", not as PRD P1 pass (founder lock ADR-016).

## 3. Linear structure (to create after approval; nothing created yet)
- Team: existing Firia team. Project: **PPEC transportation dashboard – P1 POC**.
- Milestones = B-01…B-16 above.
- Epics (labels): Platform (B-01/03/16), Data (B-02/07), Messaging (B-04/05/06), Agent (B-08), Fleet (B-09/10/11), UI (B-12/13), Ops & Demo (B-14/15).
- Issues: one per milestone deliverable + one per AT (`AT-xx: <title>`, linked to milestone, owner Veri) + TEST-INF-01, TEST-SEC-01/02. Labels: `decided-by-founder`, `accepted-by-default`, `proposed`, `mock`, `unverified`.

## 4. ID-swap matrix (B-07 / B-16, Veri)
For each resource (trip_leg, child_profile, conversation_thread, task, approval_request, manifest, dispatcher_link page, event stream): actor A requests resource owned by …
| Case | Expected |
|---|---|
| same site, own role allows | 200 |
| same site, role not allowed (front desk → approval_request decide) | 403 |
| same site, unassigned (dispatcher P2 link → P1 manifest) | 404 |
| other site (second seeded site) | 404 |
| expired / used dispatcher link | 401 |
| guardian F1 asks about C2 (via SMS) | refusal, zero sends |
| SSE subscribe with other site id in query | stream scoped to session site |

## 5. Notion page tree (to create after approval)
```
PPEC transportation dashboard
├── Overview & founder locks (ADR-000)
├── PRD v1.0 (link)
├── Architecture (ARCHITECTURE.md)
├── Data model (DATA-MODEL.md)
├── ADRs (one sub-page each)
├── Mocks & demo script
├── Build plan & AT tracker (links to Linear)
├── Risks & founder questions
├── Tokos reuse notes
└── Team briefs: Athena / Rudy / Veri / Vera
```
