# PPEC data model

```
READER: Rudy (build B-02), Veri (ID-swap matrix), Athena (P2 vault design). DECISION IT SERVES: schema for M1.
SOURCE: PRD §6.1–6.6, §7, §11, §12, §13. Draft schema: schema-draft.ts (56 tables: identity 4, ops 52).
STATUS: PROPOSED (by Firia, 2026-10-14). Table set and state machines are the PRD's (frozen, ADR 5.1); column choices are mine.
```

## Summary
- **Two Postgres schemas.** `identity` holds legal names, DOB, phones (encrypted) and the consent ledger. `ops` holds everything operational and refers to people only by `child_token` / `contact_token` / `person_token` (PRD §6.1, §15.1 "no-rewrite interfaces"). The app's DB role cannot SELECT `identity`; only the IdentityGateway role can.
- **Every ops row:** `id` UUIDv7 (app-generated; npm `uuidv7` 1.2.1), `site_id`, `version`, `created_at/by`, `updated_at/by`, `source_mode` (LIVE|SANDBOX|REPLAY|SIMULATED|MANUAL). In P1 everything is `SIMULATED` or `REPLAY`.
- **State machines are enums + an explicit transition table** (`LEG_TRANSITIONS` etc. in schema-draft.ts). One `transition()` function does `UPDATE … SET state=$to, version=version+1 WHERE id=$1 AND version=$expected AND state=$from` and writes `audit_event` + `event_log` in the same transaction. 0 rows → 412 VERSION_CONFLICT (or 409 for the named domain conflicts in PRD §12).
- **Exactly-once effects** come from unique keys, not from the queue: `message(provider, external_id)`, `telemetry_point(device_id, recorded_at)`, `agent_run(trigger_type, trigger_id)`, `outbound_message(idempotency_key)`, `job(key) WHERE live`, `attendance_event(idempotency_key)`.

## Evidence (commands run 2026-10-14 on the box)
| Check | Result | Where |
|---|---|---|
| `tsc --noEmit --strict` on schema-draft.ts with drizzle-orm 0.45.4 | exit 0 | /tmp/schemacheck (scratch) |
| `drizzle-kit generate` (0.31.11) | 1 migration, 56 `CREATE TABLE` | research/drizzle-0000_init.generated.sql |
| Applied that SQL to PGlite (in-process Postgres) | identity 4 tables, ops 52 tables; `task` check blocks CLOSED_VERIFIED without `completion_evidence`; live `job.key` unique; second guarded claim returns 0 rows | research/pglite-apply.log |

Not yet done (Unverified): applying to a real Neon branch; FK constraints (see §6); RLS.

## 1. Identity / ops split
| Schema | Tables | Who can read | P1 protection | P2/AWS protection |
|---|---|---|---|---|
| identity | child_identity, guardian_contact, consent_event (append-only), external_person_identity | role `identity_gateway` only | app-level AES-GCM for `*_enc` columns, key in env per environment; HMAC-SHA256 blind index `phone_hmac` with a pepper | KMS CMK per data class, yearly rotation, RLS, reveal-with-reason + MFA (B-19) |
| ops | everything else | role `app_rw` | synthetic data only; masked display names ("Maya R." style first name + initial) | RLS by `site_id` (P3 multi-site) |

Rules: no FK from ops into identity (keeps the boundary physical); `child_profile.child_token` = `child_identity.child_token` by convention, checked by a nightly reconciliation job. Address text never enters ops; ops has only `stop_location` coordinates + a label (in P1, the label is the landmark name).

## 2. Tables (PRD §6.1 mapping)
| PRD §6.1 name | Draft table(s) | Notes |
|---|---|---|
| child_identity | identity.child_identity | `(site_id, external_ehr_id)` unique (INT-01: match on external id only, no name/DOB fallback) |
| guardian_contact | identity.guardian_contact | `phone_hmac` index for inbound resolution |
| consent_event | identity.consent_event | append-only grant |
| family_group | ops.family_group | |
| transport_profile (version, status, items[]) | ops.transport_profile + ops.transport_need_item | one APPROVED per child (partial unique index); items carry UNKNOWN/REPORTED/VERIFIED/APPROVED |
| attendance_plan / _exception / _event | ops.attendance_plan, attendance_exception, attendance_day (state), attendance_event | `attendance_day` added to hold the per-date state machine |
| therapy_session | ops.therapy_session (+ ops.therapist) | |
| provider | ops.provider (`dispatch_ownership`) | |
| vehicle / vehicle_layout | ops.vehicle, vehicle_layout, layout_position | positions as rows so the solver gets securement + max dimensions per WC slot (§7) |
| vehicle_capability_day | ops.vehicle_capability_day | `(vehicle_id, service_date)` unique |
| trip_leg | ops.trip_leg | `(child_token, service_date, direction)` unique; `prior_state` for EXCEPTION return |
| manifest_reservation | ops.manifest + ops.manifest_reservation | |
| device_binding | ops.device + ops.device_binding | |
| telemetry_point (append-only) | ops.telemetry_point | `bound=false` rows stored, shown nowhere (LOC-01) |
| eta_estimate | ops.eta_estimate | `consecutive_shift_count` for the 2-consecutive-calcs hysteresis |
| conversation_thread / message | ops.conversation_thread, ops.message | `body_tokenized` always; plaintext only as `body_enc` (FQ-12 default: retain tokenized + encrypted) |
| change_request | ops.change_request | |
| outbound_message | ops.outbound_message | **the transactional outbox** for every external send |
| acknowledgment | ops.acknowledgment | `timer_job_id` links to ops.job |
| task/exception | ops.task | DB check: CLOSED_VERIFIED requires `completion_evidence` (AGT-04) |
| approval_request | ops.approval_request | first decision wins via `WHERE decided_at IS NULL` |
| agent_run | ops.agent_run + ops.agent_tool_call + ops.agent_memory | tool calls persisted before execution (§11.1) |
| job | ops.job (+ job_fire_log, runtime_marker) | JobScheduler storage, see ARCHITECTURE §6 |
| event_log | ops.event_log | bigserial `seq` = SSE event id |
| teams_conversation_ref | ops.teams_conversation_ref + ops.teams_activity | adapter = MOCK in P1 |
| roi_event | ops.roi_event | cohort SYNTHETIC in P1, never mixed (SURF-07) |
| audit_event | ops.audit_event | append-only grant; hashes, not message bodies |
| (not in §6.1, needed) | ops.org, site, app_user, site_membership, dispatcher_link, contact_authorization, stop_location, suppression, integration_health, idempotency_record, scenario_clock, sim_run | auth/tenancy (§6.4), §12 contracts, §16 health, §18 demo |

## 3. Indexes (all in schema-draft.ts)
Hot paths and the index that serves each:
| Query | Index |
|---|---|
| Board: today's legs for a site by state | `trip_leg_board_idx (site_id, service_date, state)` |
| Manifest stop order | `trip_leg_manifest_idx (manifest_id, stop_seq)` |
| Inbound resolution by phone | `guardian_contact_phone_hmac_idx`, `external_person_phone_hmac_idx` |
| Authorization check at send | `contact_auth_lookup_idx (contact_token, child_token, scope)` |
| Outbox drain | `outbound_drain_idx (state, next_attempt_at)` |
| Timer sweeper | `job_due_idx (state, due_at)` |
| SSE tail | `event_log_site_seq_idx (site_id, seq)` |
| Latest position per vehicle | `telemetry_vehicle_time_idx (vehicle_id, recorded_at)` |
| Open exceptions | `task_open_idx (site_id, state, severity)` |
| Therapy overlap (NTF-03) | `therapy_child_time_idx (child_token, starts_at)` |

## 4. State machines (PRD §6.3, frozen) and enforcement
Actors: S staff, P provider, G guardian, A agent-tool, Y system. Full edge lists for leg, capability, reservation and outbound are code in schema-draft.ts; the remaining four:

| Machine | Edges (from → to, actor) |
|---|---|
| Attendance (per date) | SCHEDULED→EXPECTED_LATE (A/S); SCHEDULED→AM_SELF_DROP (A/S); SCHEDULED/EXPECTED_LATE/AM_SELF_DROP→CHECKED_IN (S); CHECKED_IN→EARLY_DEPARTURE (S); CHECKED_IN→CHECKED_OUT (S); SCHEDULED/EXPECTED_LATE→ABSENT_FULL_DAY (A/S) ⇒ cascade both legs CANCELED_ATTENDANCE + therapy IMPACTED |
| Acknowledgment | PENDING→ACKNOWLEDGED; PENDING→DECLINED (⇒ AMBER exception); PENDING→EXPIRED_ESCALATED (Y, timer); PENDING→SUPERSEDED (Y) |
| Task/exception | OPEN→IN_PROGRESS (S); IN_PROGRESS→RESOLVED_APPROVED/RESOLVED_OVERRIDE (S); RESOLVED_*→CLOSED_VERIFIED (Y, requires completion_evidence); CLOSED_VERIFIED→OPEN on failed verification (Y); any open→SNOOZED with reason (S); SNOOZED→OPEN (Y timer/S) |
| Conversation thread | OPEN↔PAUSED_HUMAN (any staff send pauses; release requires next owner); OPEN/PAUSED_HUMAN→CLOSED (Y after 24 h idle) |
| Transport profile | DRAFT→APPROVED (director/coordinator role only); APPROVED→SUPERSEDED (Y when a newer version is approved); items UNKNOWN→REPORTED→VERIFIED→APPROVED |

Actor → role mapping (RBAC, ADR-004): S = DIRECTOR/COORDINATOR (all S edges) or FRONT_DESK (only ramp/check-in edges: BOARDED_VERIFIED at center, COMPLETED_HANDOFF, CHECKED_IN/OUT, capability VERIFIED at ramp); P = dispatcher link holder for that provider+date only; G = resolved guardian with the matching `contact_authorization` scope; A = agent tools (and only the edges the §11.2 catalog allows; prohibited list enforced in the policy engine); Y = system jobs.

Unit tests: one table-driven test per machine asserting every listed edge succeeds for its actor and every unlisted pair (and every wrong actor) is rejected.

## 5. Authorization model in data (PRD §6.4)
- Staff: `site_membership(user_id, site_id, role)`. Every query takes `siteId` from the session's active membership, never from the URL.
- Guardians: `contact_authorization(contact_token, child_token, scope, channel, valid_from, valid_to)`; re-evaluated at send time (historical authorization never confers present authorization).
- Dispatchers: `dispatcher_link(token_hash, provider_id, vehicle_id, service_date, expires_at, used_at)`; the page shows only that provider's manifest for that date.
- ID-swap matrix: in BUILD-PLAN.md §4 (from the access-control skill).

## 6. Open design items (Proposed, decide during B-02)
1. Foreign keys inside `ops` are not in the draft; add them in B-02 (ON DELETE RESTRICT) except on append-only logs. Reason they're not in the draft: kept the first pass readable.
2. `version` on append-only tables (consent_event, telemetry_point, audit_event, event_log) is omitted on purpose.
3. Retention jobs (PRD §15.4: 90-day raw location, 90-day plaintext bodies) are scheduled but **purge disabled** in P1 (CQ-05 default "Keep all; purge disabled").

## 7. Migrations and environments (database-lifecycle skill)
| Env | Neon | Data | Migration path |
|---|---|---|---|
| local | Docker Postgres 16 or a personal Neon branch | fixtures | `drizzle-kit generate` → review SQL → `drizzle-kit migrate` |
| preview | `preview/<branch>` copy-on-write branch per deployment | fixtures | migrate in build step against the branch URL |
| demo-prod | `main` branch | fixtures only (no real data ever in P1) | CI `drizzle-kit migrate` with the unpooled URL after a Neon branch snapshot taken the same hour |
`db:push` is allowed only against a disposable local DB. `DATABASES.md` in the repo records branch ids, roles, PITR window and the last restore drill (first drill before M2 sign-off).
