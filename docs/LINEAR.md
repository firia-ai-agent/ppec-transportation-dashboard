# Linear map

Workspace `tokos`, team **PPE** (PPEC). Regenerated 2026-10-14 from a Linear read-back (45 issues, all in team PPEC). Linear is the tracker; the repo `docs/` is the source of truth.

- Project: [PPEC Transport Dashboard — POC (mock)](https://linear.app/tokos/project/ppec-transport-dashboard-poc-mock-c71244c967e7)
- Decision Ledger pointer: [PPE-8](https://linear.app/tokos/issue/PPE-8/decision-ledger-lives-in-docsdecision-ledgermd) + project doc [Decision Ledger lives in docs/DECISION-LEDGER.md](https://linear.app/tokos/document/decision-ledger-lives-in-docsdecision-ledgermd-066fea5cb94c)
- Labels (PPE team): `rudy-build`, `veri-verify`, `vera-taste`, `athena-research`, `mock`, `epic`, `acceptance-test`

## PASS rules (read before touching any AT/TEST issue)

1. **Only Veri marks PASS.** The builder (Rudy, or anyone who wrote the code under test) never marks an AT/TEST issue PASS or Done, and never grades the harness it built. Veri owns every AT/TEST issue (PPE-25…PPE-45). Veri has no Linear user in workspace `tokos` (checked 2026-10-14: only `Firia` and the `Linear` app), so those issues are **unassigned** and carry the `veri-verify` label; assign them when Veri gets a seat.
2. **The bar is PASS (mock)** (ADR-016, DECISION-LEDGER row 12). It is never reported as a PRD P1 pass.
3. **No PASS without evidence** (PRD §18.2: "No test is claimed passed without this package"). A PASS (mock) needs a comment on the issue linking the evidence package, containing every §18.2 item that applies under ADR-016:

| §18.2 evidence item | PASS (mock) requirement |
|---|---|
| test log | required: run log with commit SHA and timestamp (ET) |
| DB diffs | required: before/after rows for the entities the test touches |
| message-status table | required: SIM-provider message table (to, body hash, status, timestamps) |
| egress-proxy log | required: outbound request log (OpenRouter, routing fixtures); must show zero sends where the test expects none |
| timer log | required for timer tests (AT-02, AT-08, AT-14, TEST-INF-01): scheduled vs fired times, claim ids |
| screen recording | required: recording of the demo panel or console run |
| agent transcripts | required for agent tests (AT-01, AT-06, AT-07, AT-09, TEST-SEC-01): tokenized prompts + tool calls |
| Twilio SIDs | N/A (mock): replaced by SIM-provider message ids |
| Teams activity IDs | N/A (mock): replaced by Teams-mock activity ids (AT-14, AT-18) |
| signed by operator and founder | required for the final POC exit package (B-15); Veri signs as operator |

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
| B-02 | Schema, 8 state machines, migration 0000 | [PPE-10](https://linear.app/tokos/issue/PPE-10/b-02-schema-8-state-machines-migration-0000) | PPE-1 | rudy-build, veri-verify | B-01 |
| B-03 | Durable timers (Vercel Queues + cron + claim) + outbox | [PPE-12](https://linear.app/tokos/issue/PPE-12/b-03-durable-timers-vercel-queues-cron-claim-outbox) | PPE-3 | rudy-build, veri-verify | B-02 |
| B-04 | MessagingProvider SIM + persona phones + consent ledger | [PPE-17](https://linear.app/tokos/issue/PPE-17/b-04-messagingprovider-sim-persona-phones-consent-ledger) | PPE-2 | rudy-build, vera-taste | B-02 |
| B-05 | Group MMS harness (mock fixture); EXP-GRP-01 stays open | [PPE-18](https://linear.app/tokos/issue/PPE-18/b-05-group-mms-harness-mock-fixture-exp-grp-01-stays-open) | PPE-2 | athena-research | B-04 |
| B-06 | Teams mock panel, adaptive cards, 409 race | [PPE-16](https://linear.app/tokos/issue/PPE-16/b-06-teams-mock-panel-adaptive-cards-409-race) | PPE-2 | rudy-build, vera-taste | B-02 |
| B-07 | IdentityGateway, tokenization (AES-GCM + HMAC), family isolation | [PPE-14](https://linear.app/tokos/issue/PPE-14/b-07-identitygateway-tokenization-aes-gcm-hmac-family-isolation) | PPE-1 | rudy-build, veri-verify | B-02 |
| B-08 | Agent runtime, OpenRouter ZDR gateway, §11.2 tools, policy engine, injection evals | [PPE-19](https://linear.app/tokos/issue/PPE-19/b-08-agent-runtime-openrouter-zdr-gateway-112-tools-policy-engine) | PPE-4 | athena-research, rudy-build | B-03, B-04, B-07, TEST-INF-01 |
| B-09 | Capacity solver (vans V1–V4 seating configs) | [PPE-15](https://linear.app/tokos/issue/PPE-15/b-09-capacity-solver-vans-v1-v4-seating-configs) | PPE-5 | rudy-build | B-02 |
| B-10 | Telemetry simulator + LocationIngest + fault injection | [PPE-13](https://linear.app/tokos/issue/PPE-13/b-10-telemetry-simulator-locationingest-fault-injection) | PPE-5 | rudy-build | B-02 |
| B-11 | Routing (OSRM fixtures) + traffic model + ETA hysteresis | [PPE-20](https://linear.app/tokos/issue/PPE-20/b-11-routing-osrm-fixtures-traffic-model-eta-hysteresis) | PPE-5 | athena-research, rudy-build | B-10 |
| B-12 | Console (board, drawer, inbox, exceptions, map) + SSE | [PPE-21](https://linear.app/tokos/issue/PPE-21/b-12-console-board-drawer-inbox-exceptions-map-sse) | PPE-6 | rudy-build, vera-taste | B-03 |
| B-13 | Ramp iPad, dispatcher form, setup + vehicle config screens | [PPE-22](https://linear.app/tokos/issue/PPE-22/b-13-ramp-ipad-dispatcher-form-setup-vehicle-config-screens) | PPE-6 | rudy-build, vera-taste | B-09, B-12 |
| B-14 | Metrics, ROI drill-down, health, EOD close (cohort SYNTHETIC) | [PPE-23](https://linear.app/tokos/issue/PPE-23/b-14-metrics-roi-drill-down-health-eod-close-cohort-synthetic) | PPE-7 | rudy-build | B-12 |
| B-15 | Acceptance suite, demo reset/replay panel, evidence export | [PPE-24](https://linear.app/tokos/issue/PPE-24/b-15-acceptance-suite-demo-resetreplay-panel-evidence-export) | PPE-7 | rudy-build, veri-verify | B-06, B-08, B-11, B-13, B-14, B-16 + all AT/TEST issues |
| B-16 | Security baseline (Auth.js + RBAC, secret scanning, log scrubber, dep audit) | [PPE-11](https://linear.app/tokos/issue/PPE-11/b-16-security-baseline-authjs-rbac-secret-scanning-log-scrubber-dep) | PPE-3 | rudy-build, veri-verify | B-01 |

B-15 (the acceptance harness) is co-labelled `rudy-build` + `veri-verify`: Rudy builds it, Veri reviews it and alone grades tests.

## Acceptance tests

Titles quote PRD §18.3 verbatim, including its pass qualifiers.

- **Owner** is the grader; only that owner can mark PASS.
- **Milestones (BUILD-PLAN §2):** every contributing milestone. The Linear milestone field holds the last one in that list, which is the gate.
- **Vendor mock used:** which mocked vendor the test runs against. Every test, including those with "—", is graded PASS (mock) under ADR-016.

| Test | PRD §18.3 title | Linear | Owner | Milestones (BUILD-PLAN §2) | Vendor mock used | In ADR-016 exit bar |
|---|---|---|---|---|---|---|
| AT-01 | message→state→notify | [PPE-27](https://linear.app/tokos/issue/PPE-27/at-01-messagestatenotify) | Veri | B-04, B-08 | SMS | yes |
| AT-02 | autonomous timer follow-up + escalation | [PPE-26](https://linear.app/tokos/issue/PPE-26/at-02-autonomous-timer-follow-up-escalation) | Veri | B-03 | — | yes |
| AT-03 | live and replayed traffic delay (downstream only, hysteresis, deterministic replay) | [PPE-29](https://linear.app/tokos/issue/PPE-29/at-03-live-and-replayed-traffic-delay-downstream-only-hysteresis) | Veri | B-10, B-11 | GPS, routing | yes |
| AT-04 | unknown equipment at arrival (infeasible before boarding, approval required) | [PPE-25](https://linear.app/tokos/issue/PPE-25/at-04-unknown-equipment-at-arrival-infeasible-before-boarding-approval) | Veri | B-09, B-13 | vehicles | yes |
| AT-05 | substitution | [PPE-30](https://linear.app/tokos/issue/PPE-30/at-05-substitution) | Veri | B-09 | vehicles | yes |
| AT-06 | sibling ambiguity | [PPE-28](https://linear.app/tokos/issue/PPE-28/at-06-sibling-ambiguity) | Veri | B-08 | SMS | yes |
| AT-07 | leg vs full-day absence | [PPE-31](https://linear.app/tokos/issue/PPE-31/at-07-leg-vs-full-day-absence) | Veri | B-02, B-08 | SMS | yes |
| AT-08 | manual correction invalidates queued message | [PPE-32](https://linear.app/tokos/issue/PPE-32/at-08-manual-correction-invalidates-queued-message) | Veri | B-03, B-12 | SMS | yes |
| AT-09 | wrong-recipient/injection (zero sends) | [PPE-35](https://linear.app/tokos/issue/PPE-35/at-09-wrong-recipientinjection-zero-sends) | Veri | B-04, B-07, B-08 | SMS | yes |
| AT-10 | geofence ≠ handoff | [PPE-33](https://linear.app/tokos/issue/PPE-33/at-10-geofence-handoff) | Veri | B-10, B-13 | GPS | yes |
| AT-11 | duplicate/out-of-order + location loss (180 s/600 s) | [PPE-38](https://linear.app/tokos/issue/PPE-38/at-11-duplicateout-of-order-location-loss-180-s600-s) | Veri | B-10 | GPS | yes |
| AT-12 | no feasible vehicle (family told only after staff choose) | [PPE-34](https://linear.app/tokos/issue/PPE-34/at-12-no-feasible-vehicle-family-told-only-after-staff-choose) | Veri | B-09 | vehicles | yes |
| AT-13 | no receiving adult (HELD_NO_RECEIVER, no auto-return) | [PPE-36](https://linear.app/tokos/issue/PPE-36/at-13-no-receiving-adult-held-no-receiver-no-auto-return) | Veri | B-02, B-13 | — | yes |
| AT-14 | therapist notified ≤10 min, ack tracked | [PPE-37](https://linear.app/tokos/issue/PPE-37/at-14-therapist-notified-10-min-ack-tracked) | Veri | B-03, B-06 | Teams | yes |
| AT-15 | ROI instrumentation with drill-down | [PPE-39](https://linear.app/tokos/issue/PPE-39/at-15-roi-instrumentation-with-drill-down) | Veri | B-14 | — | yes |
| AT-16 | EOD blocks close | [PPE-41](https://linear.app/tokos/issue/PPE-41/at-16-eod-blocks-close) | Veri | B-14 | — | yes |
| AT-17 | import without name/DOB merge, approved untouched | [PPE-40](https://linear.app/tokos/issue/PPE-40/at-17-import-without-namedob-merge-approved-untouched) | Veri | B-07 | CSV fixture | yes |
| AT-18 | Teams proactive + card + race | [PPE-42](https://linear.app/tokos/issue/PPE-42/at-18-teams-proactive-card-race) | Veri | B-06 | Teams | yes |
| TEST-INF-01 | restart (50 timers, exactly-once, ≤5 s late) | [PPE-43](https://linear.app/tokos/issue/PPE-43/test-inf-01-restart-50-timers-exactly-once-5-s-late) | Veri | B-03 | — | yes |
| TEST-SEC-01 | token-only prompts | [PPE-45](https://linear.app/tokos/issue/PPE-45/test-sec-01-token-only-prompts) | Veri | B-07, B-08 | — | no (included by default, ledger row 16) |
| TEST-SEC-02 | egress (zero *.googleapis.com, zero tokens in routing payloads) | [PPE-44](https://linear.app/tokos/issue/PPE-44/test-sec-02-egress-zero-googleapiscom-zero-tokens-in-routing-payloads) | Veri | B-08, B-16 | egress log | no (included by default, ledger row 16) |
| EXP-GRP-01 | group handshake | tracked on [PPE-18](https://linear.app/tokos/issue/PPE-18/b-05-group-mms-harness-mock-fixture-exp-grp-01-stays-open) (B-05) | Athena | B-05 | group MMS (mock fixture) | no: N/A (mock); **open — needs live Twilio** |

All AT/TEST issues are children of Epic: Ops & Demo (PPE-7) and block B-15 (PPE-24). TEST-INF-01 also blocks B-08 (PPE-19).

## Open question for the founder

TEST-SEC-01 (token-only prompts) and TEST-SEC-02 (egress) are **outside** the ADR-016 exit bar (AT-01–AT-18 + TEST-INF-01). Should they be required for the POC? Default until you answer: **included as required**, recorded as DECISION-LEDGER row 16 (Accepted by default).

EXP-GRP-01 is not deferred; it stays open until live Twilio is available or the founder decides otherwise.
