# Linear map

Workspace `tokos`, team **PPE** (PPEC). Generated 2026-10-14 from a Linear read-back. Linear is the tracker; the repo `docs/` stays the source of truth.

- Project: [PPEC Transport Dashboard — POC (mock)](https://linear.app/tokos/project/ppec-transport-dashboard-poc-mock-c71244c967e7)
- Decision Ledger pointer: [PPE-8](https://linear.app/tokos/issue/PPE-8/decision-ledger-lives-in-docsdecision-ledgermd) + project doc [Decision Ledger lives in docs/DECISION-LEDGER.md](https://linear.app/tokos/document/decision-ledger-lives-in-docsdecision-ledgermd-066fea5cb94c)
- Labels (PPE team): `rudy-build`, `veri-verify`, `vera-taste`, `athena-research`, `mock`, `epic`, `acceptance-test`
- Bar for every AT: **PASS (mock)** per ADR-016, not PRD P1 pass.

## Epics

| Epic | Linear |
|---|---|
| Data (B-02, B-07) | [PPE-1](https://linear.app/tokos/issue/PPE-1/epic-data-b-02-b-07) |
| Messaging (B-04, B-05, B-06) | [PPE-2](https://linear.app/tokos/issue/PPE-2/epic-messaging-b-04-b-05-b-06) |
| Platform (B-01, B-03, B-16) | [PPE-3](https://linear.app/tokos/issue/PPE-3/epic-platform-b-01-b-03-b-16) |
| Agent (B-08) | [PPE-4](https://linear.app/tokos/issue/PPE-4/epic-agent-b-08) |
| Fleet (B-09, B-10, B-11) | [PPE-5](https://linear.app/tokos/issue/PPE-5/epic-fleet-b-09-b-10-b-11) |
| UI (B-12, B-13) | [PPE-6](https://linear.app/tokos/issue/PPE-6/epic-ui-b-12-b-13) |
| Ops & Demo (B-14, B-15) | [PPE-7](https://linear.app/tokos/issue/PPE-7/epic-ops-and-demo-b-14-b-15) |

## Backlog items (milestones B-01…B-16)

| B | Title | Linear | Parent epic | Owner labels | Depends on |
|---|---|---|---|---|---|
| B-01 | Repo scaffold, CI, Vercel project + Neon integration | [PPE-9](https://linear.app/tokos/issue/PPE-9/b-01-repo-scaffold-ci-vercel-project-neon-integration) | PPE-3 | rudy-build | — |
| B-02 | Schema, 8 state machines, migration 0000 | [PPE-10](https://linear.app/tokos/issue/PPE-10/b-02-schema-8-state-machines-migration-0000) | PPE-1 | veri-verify, rudy-build | B-01 |
| B-03 | Durable timers (Vercel Queues + cron + claim) + outbox | [PPE-12](https://linear.app/tokos/issue/PPE-12/b-03-durable-timers-vercel-queues-cron-claim-outbox) | PPE-3 | veri-verify, rudy-build | B-02 |
| B-04 | MessagingProvider SIM + persona phones + consent ledger | [PPE-17](https://linear.app/tokos/issue/PPE-17/b-04-messagingprovider-sim-persona-phones-consent-ledger) | PPE-2 | vera-taste, rudy-build | B-02 |
| B-05 | Group MMS harness (mock fixture); EXP-GRP-01 stays open | [PPE-18](https://linear.app/tokos/issue/PPE-18/b-05-group-mms-harness-mock-fixture-exp-grp-01-stays-open) | PPE-2 | athena-research | B-04 |
| B-06 | Teams mock panel, adaptive cards, 409 race | [PPE-16](https://linear.app/tokos/issue/PPE-16/b-06-teams-mock-panel-adaptive-cards-409-race) | PPE-2 | vera-taste, rudy-build | B-02 |
| B-07 | IdentityGateway, tokenization (AES-GCM + HMAC), family isolation | [PPE-14](https://linear.app/tokos/issue/PPE-14/b-07-identitygateway-tokenization-aes-gcm-hmac-family-isolation) | PPE-1 | veri-verify, rudy-build | B-02 |
| B-08 | Agent runtime, OpenRouter ZDR gateway, §11.2 tools, policy engine, injection evals | [PPE-19](https://linear.app/tokos/issue/PPE-19/b-08-agent-runtime-openrouter-zdr-gateway-112-tools-policy-engine) | PPE-4 | athena-research, rudy-build | B-03, B-04, B-07, TEST-INF-01 |
| B-09 | Capacity solver (vans V1–V4 seating configs) | [PPE-15](https://linear.app/tokos/issue/PPE-15/b-09-capacity-solver-vans-v1-v4-seating-configs) | PPE-5 | rudy-build | B-02 |
| B-10 | Telemetry simulator + LocationIngest + fault injection | [PPE-13](https://linear.app/tokos/issue/PPE-13/b-10-telemetry-simulator-locationingest-fault-injection) | PPE-5 | rudy-build | B-02 |
| B-11 | Routing (OSRM fixtures) + traffic model + ETA hysteresis | [PPE-20](https://linear.app/tokos/issue/PPE-20/b-11-routing-osrm-fixtures-traffic-model-eta-hysteresis) | PPE-5 | athena-research, rudy-build | B-10 |
| B-12 | Console (board, drawer, inbox, exceptions, map) + SSE | [PPE-21](https://linear.app/tokos/issue/PPE-21/b-12-console-board-drawer-inbox-exceptions-map-sse) | PPE-6 | vera-taste, rudy-build | B-03 |
| B-13 | Ramp iPad, dispatcher form, setup + vehicle config screens | [PPE-22](https://linear.app/tokos/issue/PPE-22/b-13-ramp-ipad-dispatcher-form-setup-vehicle-config-screens) | PPE-6 | vera-taste, rudy-build | B-09, B-12 |
| B-14 | Metrics, ROI drill-down, health, EOD close (cohort SYNTHETIC) | [PPE-23](https://linear.app/tokos/issue/PPE-23/b-14-metrics-roi-drill-down-health-eod-close-cohort-synthetic) | PPE-7 | rudy-build | B-12 |
| B-15 | Acceptance suite, demo reset/replay panel, evidence export | [PPE-24](https://linear.app/tokos/issue/PPE-24/b-15-acceptance-suite-demo-resetreplay-panel-evidence-export) | PPE-7 | veri-verify | B-06, B-08, B-11, B-13, B-14, B-16 + all ATs |
| B-16 | Security baseline (Auth.js + RBAC, secret scanning, log scrubber, dep audit) | [PPE-11](https://linear.app/tokos/issue/PPE-11/b-16-security-baseline-authjs-rbac-secret-scanning-log-scrubber-dep) | PPE-3 | veri-verify, rudy-build | B-01 |

## Acceptance tests

| Test | Title | Linear | Milestone | Mock |
|---|---|---|---|---|
| AT-01 | Inbound message → state change → notify | [PPE-27](https://linear.app/tokos/issue/PPE-27/at-01-inbound-message-state-change-notify) | B-08 | yes |
| AT-02 | Timer follow-up + escalation | [PPE-26](https://linear.app/tokos/issue/PPE-26/at-02-timer-follow-up-escalation) | B-03 | no |
| AT-03 | Traffic delay, ETA hysteresis, replay | [PPE-29](https://linear.app/tokos/issue/PPE-29/at-03-traffic-delay-eta-hysteresis-replay) | B-11 | yes |
| AT-04 | Unknown equipment at arrival | [PPE-25](https://linear.app/tokos/issue/PPE-25/at-04-unknown-equipment-at-arrival) | B-13 | yes |
| AT-05 | Vehicle substitution | [PPE-30](https://linear.app/tokos/issue/PPE-30/at-05-vehicle-substitution) | B-09 | yes |
| AT-06 | Sibling ambiguity | [PPE-28](https://linear.app/tokos/issue/PPE-28/at-06-sibling-ambiguity) | B-08 | yes |
| AT-07 | Leg vs full-day cancellation | [PPE-31](https://linear.app/tokos/issue/PPE-31/at-07-leg-vs-full-day-cancellation) | B-08 | yes |
| AT-08 | Manual correction invalidates queued message | [PPE-32](https://linear.app/tokos/issue/PPE-32/at-08-manual-correction-invalidates-queued-message) | B-12 | yes |
| AT-09 | Wrong recipient / prompt injection | [PPE-35](https://linear.app/tokos/issue/PPE-35/at-09-wrong-recipient-prompt-injection) | B-08 | yes |
| AT-10 | Geofence ≠ handoff | [PPE-33](https://linear.app/tokos/issue/PPE-33/at-10-geofence-handoff) | B-13 | yes |
| AT-11 | Duplicate / out-of-order / lost telemetry | [PPE-38](https://linear.app/tokos/issue/PPE-38/at-11-duplicate-out-of-order-lost-telemetry) | B-10 | yes |
| AT-12 | No feasible vehicle | [PPE-34](https://linear.app/tokos/issue/PPE-34/at-12-no-feasible-vehicle) | B-09 | yes |
| AT-13 | No receiving adult at drop-off | [PPE-36](https://linear.app/tokos/issue/PPE-36/at-13-no-receiving-adult-at-drop-off) | B-13 | no |
| AT-14 | Therapist notified ≤10 min + ack | [PPE-37](https://linear.app/tokos/issue/PPE-37/at-14-therapist-notified-10-min-ack) | B-06 | yes |
| AT-15 | ROI drill-down | [PPE-39](https://linear.app/tokos/issue/PPE-39/at-15-roi-drill-down) | B-14 | no |
| AT-16 | EOD close blocked by open items | [PPE-41](https://linear.app/tokos/issue/PPE-41/at-16-eod-close-blocked-by-open-items) | B-14 | no |
| AT-17 | Import without name/DOB merge | [PPE-40](https://linear.app/tokos/issue/PPE-40/at-17-import-without-namedob-merge) | B-07 | yes |
| AT-18 | Teams proactive message + card + 409 race | [PPE-42](https://linear.app/tokos/issue/PPE-42/at-18-teams-proactive-message-card-409-race) | B-06 | yes |
| TEST-INF-01 | Durable timer restart/duplicate-delivery test (3 runs) | [PPE-43](https://linear.app/tokos/issue/PPE-43/test-inf-01-durable-timer-restartduplicate-delivery-test-3-runs) | B-03 | no |
| TEST-SEC-01 | Agent injection eval set | [PPE-45](https://linear.app/tokos/issue/PPE-45/test-sec-01-agent-injection-eval-set) | B-08 | no |
| TEST-SEC-02 | Egress log — no PHI/secrets leave allowed providers | [PPE-44](https://linear.app/tokos/issue/PPE-44/test-sec-02-egress-log-no-phisecrets-leave-allowed-providers) | B-08 | no |

All AT/TEST issues block B-15 (PPE-24) and are children of Epic: Ops & Demo (PPE-7). TEST-INF-01 also blocks B-08 (PPE-19).
