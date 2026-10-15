# B-08 slice 1 — what is deferred

Slice 1 (`src/modules/agent`, commit "B-08 slice 1 — LLM gateway seam…") builds the **seam**: the
LLM gateway contract, the §11.2 tool catalog as schemas, the policy engine, two offline providers,
and the red-team fixture set. It deliberately builds no run loop, touches no table and makes no
vendor call.

This file is the honest other half of that: every part of B-08's PRD scope — **§11.1 Invocation and
context** (PRD l.924), **§11.2 Tool catalog** (l.926–993) and **§18.3 acceptance tests** (l.1333) —
that slice 1 leaves for later, so nothing in the slice-1 diff can be mistaken for a claim about it.

Status key: **Deferred** = not built, named here. **Partial** = the mechanism exists, the wiring
does not. **Stricter** = slice 1 is deliberately tighter than the PRD, and the PRD shape returns
with the thing that makes it safe.

---

## §11.1 Invocation and context

| PRD text | Slice 1 | Status | Lands with |
|---|---|---|---|
| Triggers: `msg.inbound`, operational event (rules first), timer/deadline, overdue sweeper (5 min), ETA threshold (deterministic → template), reconciliation (hourly/EOD) | nothing invokes the agent; every test calls `complete()` itself | Deferred | slice 2 (run loop) on B-03 timers + B-04 inbound |
| Each run = job with idempotency `(trigger_type, trigger_id)` | `runId` is a string the caller picks; it buckets rate limits and nothing else | Deferred | slice 2; `ops.agent_run` already has the unique index |
| Tool calls persisted **before** execution | nothing is persisted; `ops.agent_run` / `ops.agent_tool_call` / `ops.agent_memory` are unwritten | Deferred | slice 2 |
| Resumes from last committed result | no resume, because nothing commits | Deferred | slice 2 |
| Delayed external responses are tasks with timers, never waiting sessions | no task rows, no timers from the agent | Deferred | slice 3 with B-03 `JobScheduler` |
| Tiers assembled fresh each run: **T1** approved facts + authorization (immutable) | no assembly; prompts are fixtures (`fixtures/prompts.ts`) | Deferred | slice 2 (tier assembly from B-02/B-07) |
| **T2** current state with versions, "fetched via tools before every write" | schemas carry `expected_version`; nothing fetches or checks it | Partial | slice 2 — the tool executors |
| **T3** last N family-scoped messages wrapped as untrusted | `wrapUntrusted()` / `triageInbound()` exist and are tested; nothing selects "last N" from `ops.message` | Partial | slice 2 |
| **T4** structured preferences (cannot override T1/T2) | the tier label exists (`ContextTier`); no preference store, no precedence check | Deferred | slice 2 |
| Run scope (which site/family a run may touch) | `FamilyScope` is built by the caller; in slice 1 that is a test | Partial | slice 2 — built from the session, per VERI-3 |

## §11.2 Tool catalog

All 15 tools exist as zod schemas with their tier and effect (`tools.ts`), and every one of them has
a policy row (`POLICY_ROWS`, VERI-1). **None of them has an executor.** The "Precondition → effect"
and "Failure" columns of the PRD table are therefore all deferred:

| Tool | Deferred precondition / effect / failure |
|---|---|
| `resolve_sender` | contact-point lookup; `candidates{child, legs, confidence}`; unknown → `unknown_sender` task |
| `get_leg_state` | the read itself, and the version it returns |
| `cancel_attendance_or_leg` | the transition, `expected_version` conflict → 412, `expected_self_arrival` handling |
| `request_clarification` | thread ACTIVE check, **≤2/thread/hour**, 15-min await timer, send fail → exception |
| `record_acknowledgment` | matching PENDING ack, timer cancel, `DECLINED` → AMBER |
| `send_followup` | egress re-check at send time, notify gates, `canceled_stale` → recompute |
| `notify_affected_therapist` | overlapping-session lookup, minimized SMS, `THERAPIST_NOTIFIED` |
| `request_provider_capability` | capability UNKNOWN at T−90 / on substitution, signed dispatcher link, state REQUESTED, no reply → escalate |
| `record_capability_report` | provider-contact-point check, observation row, low confidence → staff review |
| `report_boarding` | guardian-reply / stationary-tap evidence, the `BOARDED_REPORTED` transition |
| `propose_manifest_reallocation` | RED exception + Teams card, `ops.approval_request` row |
| `propose_contact_or_profile_change` | `ops.change_request` row + exception |
| `escalate_exception` | the exception row, severity routing, next-step dispatch |
| `close_task` | the completion predicate, "else stays open" |
| `summarize_thread_for_staff` | the staff note row |

Other §11.2 clauses:

| Clause | Slice 1 | Status | Lands with |
|---|---|---|---|
| "free-text to parents **without human approval**" | slice 1 holds **every** send behind an approval bound to the exact call (`send_requires_approval`, `approvalKey`), so the §11.2 auto tier on the templated sends is not yet available | **Stricter** | slice 2/3: narrow back to the §11.2 tiers once the staff approval surface (`ops.approval_request`) and the egress re-check are wired — not before |
| Human approval itself | no surface produces an approval key; `ctx.approvedCalls` is empty everywhere but in tests | Deferred | slice 2/3 (approval UI + B-12) |
| "messaging non-consented numbers" | consent is checked against `ctx.sendableSubjects`, a set the caller passes | Partial | slice 2 — the mirror reads consent, and the outbox re-checks per contact at send time |
| Injection defenses: delimiters; schema-only tools; family-scope post-validator; identity_change_request | all four built and tested (VERI-1, VERI-3, VERI-4) | — | — |
| "red-team fixtures in CI (**≥100 adversarial cases by P2**)" | 45 fixtures + the VERI suites | Partial | P2; the gap is case count, not harness |
| Pause / kill switch ("sending while paused") | `ctx.paused` is a flag the caller sets | Partial | ops surface in a later slice |
| LLM gateway: `redact()`, `validatePromptTokensOnly()`, JSON-schema-only, endpoint allow-list, per-call audit | all built and tested | — | — |
| …`validatePromptTokensOnly` name list | the synthetic fixture roster, not a name index | Partial | identity vault (B-07) swaps the list behind the same function |
| …per-call audit "of hashes only" | in memory, plus an optional sink; nothing writes `ops.audit_event` | Partial | slice 2 |
| `vendorAttestation` required in PHI mode | enforced; **no deployment may select PHI** (no BAA — ARCHITECTURE risk 3, ADR-000 #4) | Partial | AWS/Bedrock step |
| Rate limits | per gateway instance, in memory | Partial | per-site/day budget + ADR-000 #11 spend alert |
| Live vendor call | `providers/remote.ts` is a typed placeholder that fails closed with no key (VERI-5); no HTTP body, no retries, no timeouts, no token/cost accounting | Deferred | slice 2 (ADR-000 #4/#12: Claude Sonnet via OpenRouter, `zdr:true`) |

## §18.3 acceptance tests

| Test | Slice 1 | Status |
|---|---|---|
| **AT-09** wrong-recipient / injection (zero sends) | evidenced **at the seam**: 45 fixtures + VERI-2/VERI-4 through the real gateway and the real policy engine, with a send sink that stays empty | Partial — no run loop, no live traffic, no outbox behind it |
| **TEST-SEC-01** token-only prompts | `validatePromptTokensOnly` fails closed before the provider is called; audit holds hashes only | Partial — proved against the fixture roster, not the identity vault |
| AT-01 message→state→notify | needs inbound → run loop → transition → outbox | Deferred (B-04 + slice 2) |
| AT-02 autonomous timer follow-up + escalation | needs timers and the run loop | Deferred (B-03 + slice 2) |
| AT-06 sibling ambiguity | `request_clarification` has no executor and no rate limit | Deferred |
| AT-07 leg vs full-day absence | `cancel_attendance_or_leg` has no executor | Deferred |
| AT-04/05/12 approval-gated infeasibility and substitution | `propose_*` produce decisions, not `approval_request` rows or Teams cards | Deferred |
| AT-14 therapist notified ≤10 min, ack tracked | no executor, no timer | Deferred |
| TEST-SEC-02 egress (zero `*.googleapis.com`, zero tokens in routing payloads) | VERI-5 proves the agent module makes no network call at all; the egress allow-list itself is B-16's | Partial |
| TEST-INF-01 restart (50 timers, exactly-once) | `JobScheduler`, not the agent | Out of scope for B-08 |
| §18.4 source-mode matrix, LLM row: "Live vendor API, synthetic — proves tool-calling, policy, **recovery**" | policy is proved against scripted and recorded providers; **live tool-calling and recovery are unproven** | Partial |

---

## What slice 1 does claim

Only this: no agent code can reach a model except through the gateway; no prompt leaves with a
number, an address or an untokenized name in it; no response is accepted unless it is exactly one
schema-valid call to a catalog tool; every catalog tool has a policy row and an undeclared one is
refused; nothing addressed to a family, a therapist or a driver becomes a send without a human
approval bound to that exact call; no argument can name another family's or another site's object;
an injected SMS executes nothing; and neither provider can reach the network.

Everything else on this page is later work, and none of it is implied by the tests in this slice.
