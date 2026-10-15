# B-08 — what is deferred

Slice 1 (`src/modules/agent/*.ts`, commit "B-08 slice 1 — LLM gateway seam…") builds the **seam**:
the LLM gateway contract, the §11.2 tool catalog as schemas, the policy engine, two offline
providers, and the red-team fixture set. It builds no run loop, touches no table and makes no
vendor call.

Slice 2 (`src/modules/agent/run/`, commit "B-08 slice 2 — idempotent run loop…") builds **§11.1
Invocation and context**: the idempotent run, persist-before-execute tool calls, resume from the
last committed result, and awaited responses as tasks on B-03 timers. It executes nothing — every
tool executor still records intent only — and it adds no path around the gateway or the policy
engine.

This file is the honest other half of both: every part of B-08's PRD scope — **§11.1 Invocation and
context** (PRD l.924), **§11.2 Tool catalog** (l.926–993) and **§18.3 acceptance tests** (l.1333) —
that is still to come, so nothing in either diff can be mistaken for a claim about it. Rows marked
**Done (slice 2)** below were "slice 2" promises in the slice-1 version of this page and are now
built and tested; everything else is still outstanding.

Status key: **Deferred** = not built, named here. **Partial** = the mechanism exists, the wiring
does not. **Done (slice 2)** = built and tested in `src/modules/agent/run/`.

**Founder decision, 2026-10-15:** the approval policy is narrowed back to the **PRD §11.2 tiers**.
Slice 1 held *every* send behind a human approval, which was tighter than §11.2 and is no longer
what we ship: the templated follow-ups are `auto` and send on their own, and only free text to a
parent needs a human approval bound to the exact call. Since no tool in the catalog can carry free
text, the practical effect is that the agent now sends its allow-listed messages autonomously and
there is no call it can make that puts prose in front of a family. The two halves are
`policy.ts` steps 6 and 10, the declaration that decides which applies is `tools.ts` `sendCopy`, and
the bar is held by `attacks.test.ts` (VERI-2) and `free-text-approval.test.ts`. Nothing else about
the gate moved: pause, consent, scope, injection and the `human`-tier `propose_*` rows are
unchanged, and the staff approval surface is still the deferred row below.

---

## §11.1 Invocation and context

| PRD text | Where it stands after slice 2 | Status | What is left, and with whom |
|---|---|---|---|
| Triggers: `msg.inbound`, operational event (rules first), timer/deadline, overdue sweeper (5 min), ETA threshold (deterministic → template), reconciliation (hourly/EOD) | the five trigger types that start a run are `run/triggers.ts`, with the rule that a trigger id is the id of the thing that happened; `startAndDriveRun(trigger)` is the entry point. ETA threshold is deliberately **not** a type: §11.1 marks it "deterministic → template", so it renders copy without a model turn | Partial | the five *callers*: the B-04 inbound webhook, the operational-rules handoff, the 5-minute overdue sweep and the hourly/EOD reconciliation cron each belong to their own milestone. Only the `timer.deadline` caller exists (an agent timer re-triggering its own run) |
| Each run = job with idempotency `(trigger_type, trigger_id)` | `startRun` inserts `ON CONFLICT (trigger_type, trigger_id) DO NOTHING` and returns the run that already exists; concurrent duplicate starts collapse onto one row (tested five-way) | **Done (slice 2)** | the run is not yet a *queue* job: `/api/queues/agent` and its per-run claim are the next slice. Until then a double driver is bounded by the `(run_id, seq)` index and the per-call idempotency key, not by a lease |
| Tool calls persisted **before** execution | `persistCall` commits the row — args fingerprint, redaction-safe args, policy decision, `status='PENDING'`, idempotency key — in its own transaction before any executor runs; the executor's own probe asserts it sees that row PENDING and uncommitted. `status` and `idempotency_key` are migration 0007 | **Done (slice 2)** | — |
| Resumes from last committed result | `driveRun` settles any call interrupted between its persist and its commit, re-driving it with the original key and the original decision, then continues from the committed results. Tested at three crash points × three steps, asserting exactly one effect per key | **Done (slice 2)** | the sink-side half is only as good as the executor: a real one must be idempotent on `idempotencyKey` (`ops.outbound_message.idempotency_key`, a version-guarded `transition()`), which lands per tool |
| Delayed external responses are tasks with timers, never waiting sessions | an executor returning `awaitExternal` commits the call, raises an `ops.task` row, schedules a B-03 `agent.run.resume` timer and parks the run `WAITING_TOOL` — one transaction. The timer's handler is DB-only and re-triggers the run; the resume takes the next turn from the committed result | **Done (slice 2)** | the §11.2 "no reply → escalate" timer *on the task* (a second deadline past the first) and the clarification rate limit (≤2/thread/hour) land with their tools |
| Tiers assembled fresh each run: **T1** approved facts + authorization (immutable) | `run/context.ts` rebuilds the whole prompt on every turn (nothing but the committed rows crosses a restart) and `tierPrompt` writes T1 first | Partial | the *sources*: T1 comes from B-02's approved profile and authorization scopes through B-07's tokenizer. `TierFacts` is supplied by the caller today |
| **T2** current state with versions, "fetched via tools before every write" | T2 has its place in the prompt, and a tool result may carry a version forward through `promptFacts` | Partial | the readers and the write guard are the tool executors (B-02 `transition()`), still intent-only |
| **T3** last N family-scoped messages wrapped as untrusted | every T3 body is wrapped in `<untrusted_user_message>` by the assembler, and the same list is handed to the policy engine as `untrustedMessages`, so the model and the injection check see one thread | Partial | selecting "last N" from `ops.message` is B-04 wiring |
| **T4** structured preferences (cannot override T1/T2) | T4 is written after T1/T2 and the prompt states the precedence; the enforceable part (a T3-cited write) is blocked by the policy engine | Partial | no preference store exists to read T4 from |
| Run scope (which site/family a run may touch) | the scope is part of the policy context the assembler returns, built by the caller from its session and never from a tool argument; the run row carries the site | Partial | the session → scope builder lands with the B-04/B-12 callers, per VERI-3 |

## §11.2 Tool catalog

All 15 tools exist as zod schemas with their tier and effect (`tools.ts`), and every one of them has
a policy row (`POLICY_ROWS`, VERI-1). Slice 2 gives every one of them an entry in the executor
registry (`run/executors.ts`) — but **the entry records intent and nothing else**: no state change,
no outbound, no task beyond an await. The "Precondition → effect" and "Failure" columns of the PRD
table are therefore still deferred, now with a named place to land (`intentRecorder`'s override for
that tool) and two contracts to keep when they do: idempotent on the call's idempotency key, and
only `promptFacts` may reach the next prompt.

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
| "free-text to parents **without human approval**" | the §11.2 tiers, exactly (founder decision above): a send whose copy is an allow-listed template id or a body rendered downstream from structured fields is `auto` and is ALLOWed; a send carrying the model's own words is held behind `ctx.approvedCalls` keyed on `approvalKey(tool, args)`. Which one a tool is comes from its `sendCopy` declaration, and a sending tool that declares nothing is read as free text. No catalog tool declares free text, and a templated one that *carries* any — an undeclared argument, a body-shaped argument name, a value that reads as a sentence, an interpolated or overlong value, an unrenderable template id, a var the template does not permit — is blocked `free_text_to_parents`, with or without an approval | — | — |
| Human approval itself | no surface produces an approval key, and with the catalog as it stands nothing needs one: `ctx.approvedCalls` is empty everywhere but in tests. The proposed-row plumbing is built either way — a `PROPOSED` row carries `args_hash` = `approvalKey(tool, args)`, repeated in `result.approval_key`, so a human's signature and the exact call it releases match on one column. It is what the `human`-tier `propose_*` rows already use, and what a free-text sender would use on the day one is added | Partial | the approval UI + B-12 Teams card |
| "messaging non-consented numbers" | consent is checked against `ctx.sendableSubjects`, a set the caller passes | Partial | slice 2 — the mirror reads consent, and the outbox re-checks per contact at send time |
| Injection defenses: delimiters; schema-only tools; family-scope post-validator; identity_change_request | all four built and tested (VERI-1, VERI-3, VERI-4) | — | — |
| "red-team fixtures in CI (**≥100 adversarial cases by P2**)" | 45 fixtures + the VERI suites | Partial | P2; the gap is case count, not harness |
| Pause / kill switch ("sending while paused") | `ctx.paused` is a flag the caller sets | Partial | ops surface in a later slice |
| LLM gateway: `redact()`, `validatePromptTokensOnly()`, JSON-schema-only, endpoint allow-list, per-call audit | all built and tested | — | — |
| …`validatePromptTokensOnly` name list | the synthetic fixture roster, not a name index | Partial | identity vault (B-07) swaps the list behind the same function |
| …per-call audit "of hashes only" | in memory, plus an optional sink. Slice 2 persists the run's hashes in the operational tables — `ops.agent_run.prompt_hash` per turn, `ops.agent_tool_call.args_hash` per call, with results holding codes rather than text — but nothing writes `ops.audit_event` yet | Partial | the audit-event writer (B-12/B-16) |
| `vendorAttestation` required in PHI mode | enforced; **no deployment may select PHI** (no BAA — ARCHITECTURE risk 3, ADR-000 #4) | Partial | AWS/Bedrock step |
| Rate limits | per gateway instance, in memory. Slice 2 adds the loop's step budget, counted from the **persisted** calls (`maxCallsPerRun`), so a resumed run does not get a fresh allowance the way the in-memory counter would | Partial | per-site/day budget + ADR-000 #11 spend alert |
| Live vendor call | `providers/remote.ts` is a typed placeholder that fails closed with no key (VERI-5); no HTTP body, no retries, no timeouts, no token/cost accounting. `ops.agent_run.tokens_in/out` stay NULL for the same reason | Deferred | a later slice (ADR-000 #4/#12: Claude Sonnet via OpenRouter, `zdr:true`) |

## §18.3 acceptance tests

| Test | Slice 1 | Status |
|---|---|---|
| **AT-09** wrong-recipient / injection (zero sends) | evidenced **at the seam**: 45 fixtures + VERI-2/VERI-4 through the real gateway and the real policy engine, with a send sink that stays empty for every one of them, for every way of getting free text onto a templated send, and for every clean send once the agent is paused, a directive is in the thread, consent is withdrawn or the subject belongs to another family. The same sink receives exactly one send for each of the four clean, templated calls — so "zero" is a property of the defense and not of a harness that cannot send | Partial — no live traffic, no outbox behind it |
| **TEST-SEC-01** token-only prompts | `validatePromptTokensOnly` fails closed before the provider is called; audit holds hashes only | Partial — proved against the fixture roster, not the identity vault |
| AT-01 message→state→notify | the middle of it exists: a trigger starts one run, the run reads, writes and notes in persisted steps, and a crash loses nothing. The two ends do not — the inbound trigger (B-04) and the transition/outbox executors (B-02/B-04) | Partial (slice 2) |
| AT-02 autonomous timer follow-up + escalation | the follow-up half exists and is tested: an awaited reply becomes a task + a B-03 timer, and the timer firing resumes the run from its committed result. The escalation half does not — no "no reply → escalate" timer, no outbound | Partial (slice 2) |
| AT-06 sibling ambiguity | `request_clarification` has no executor and no rate limit (≤2/thread/hour). The loop drives the *shape* of it in `run/timers.test.ts` with an intent-only executor | Deferred |
| AT-07 leg vs full-day absence | `cancel_attendance_or_leg` has no executor | Deferred |
| AT-04/05/12 approval-gated infeasibility and substitution | `propose_*` produce persisted `PROPOSED` rows carrying an approval key, not `ops.approval_request` rows or Teams cards | Deferred |
| AT-14 therapist notified ≤10 min, ack tracked | no executor; the 10-minute await is expressible (`awaitExternal`) but nothing sends | Deferred |
| TEST-SEC-02 egress (zero `*.googleapis.com`, zero tokens in routing payloads) | VERI-5 proves the agent module makes no network call at all; the egress allow-list itself is B-16's | Partial |
| TEST-INF-01 restart (50 timers, exactly-once) | `JobScheduler`, not the agent — though the agent's own await timer is an ordinary `ops.job` row and rides the same guarded claim | Out of scope for B-08 |
| §18.4 source-mode matrix, LLM row: "Live vendor API, synthetic — proves tool-calling, policy, **recovery**" | policy is proved against scripted and recorded providers, and **recovery is now proved** against them too (crash-and-resume at every step, exactly one effect per call). **Live** tool-calling and live recovery remain unproven | Partial |

---

## What slices 1–2 claim

Slice 1, only this: no agent code can reach a model except through the gateway; no prompt leaves
with a number, an address or an untokenized name in it; no response is accepted unless it is
exactly one schema-valid call to a catalog tool; every catalog tool has a policy row and an
undeclared one is refused; the only messages that go out to a family, a therapist or a driver are
allow-listed templates and bodies rendered downstream, and anything carrying the model's own words
is either refused or held behind a human approval bound to that exact call; no argument can name
another family's or another site's object; an injected SMS executes nothing; and neither provider
can reach the network.

Slice 2 adds only this: one trigger makes one run, however many times it is delivered; no tool call
is executed before it is on disk with its policy decision and its effect key; a run killed at any
point in any step resumes without executing anything twice; a blocked or proposed call is recorded
and executes nothing; an awaited reply is a staff task plus a B-03 timer rather than a held session,
and the timer is what resumes the run; and the prompt is rebuilt from the tiers and the committed
results on every turn, so a resumed run carries no conversation and no untokenized text.

Everything else on this page is later work, and none of it is implied by the tests in these two
slices.
