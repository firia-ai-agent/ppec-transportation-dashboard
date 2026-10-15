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

Slice 3 (`src/modules/agent/run/exec/`, commits "B-08 slice 3 — …") builds the **§11.2
"Precondition → effect" and "Failure" columns for eight of the fifteen tools**, on the real
operational tables and through the existing domain modules (`domain/transition`, `modules/outbox`,
B-03's `JobScheduler`) — plus the `human`-tier proposal rows. Eight tools now do something; seven
still do not, and a tool with no live executor fails its step shut (`NO_EXECUTOR`) rather than
reporting an effect it did not have.

This file is the honest other half of all three: every part of B-08's PRD scope — **§11.1
Invocation and context** (PRD l.924), **§11.2 Tool catalog** (l.926–993) and **§18.3 acceptance
tests** (l.1333) — that is still to come, so nothing in any of the diffs can be mistaken for a
claim about it. Rows marked **Done (slice 2)** or **Done (slice 3)** below were promises on an
earlier version of this page and are now built and tested; everything else is still outstanding.

Status key: **Deferred** = not built, named here. **Partial** = the mechanism exists, the wiring
does not. **Done (slice 2)** = built and tested in `src/modules/agent/run/`. **Done (slice 3)** =
built and tested in `src/modules/agent/run/exec/`.

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

| PRD text | Where it stands after slice 3 | Status | What is left, and with whom |
|---|---|---|---|
| Triggers: `msg.inbound`, operational event (rules first), timer/deadline, overdue sweeper (5 min), ETA threshold (deterministic → template), reconciliation (hourly/EOD) | the five trigger types that start a run are `run/triggers.ts`, with the rule that a trigger id is the id of the thing that happened; `startAndDriveRun(trigger)` is the entry point. ETA threshold is deliberately **not** a type: §11.1 marks it "deterministic → template", so it renders copy without a model turn | Partial | the five *callers*: the B-04 inbound webhook, the operational-rules handoff, the 5-minute overdue sweep and the hourly/EOD reconciliation cron each belong to their own milestone. Only the `timer.deadline` caller exists (an agent timer re-triggering its own run) |
| Each run = job with idempotency `(trigger_type, trigger_id)` | `startRun` inserts `ON CONFLICT (trigger_type, trigger_id) DO NOTHING` and returns the run that already exists; concurrent duplicate starts collapse onto one row (tested five-way) | **Done (slice 2)** | the run is not yet a *queue* job: `/api/queues/agent` and its per-run claim are the next slice. Until then a double driver is bounded by the `(run_id, seq)` index and the per-call idempotency key, not by a lease |
| Tool calls persisted **before** execution | `persistCall` commits the row — args fingerprint, redaction-safe args, policy decision, `status='PENDING'`, idempotency key — in its own transaction before any executor runs; the executor's own probe asserts it sees that row PENDING and uncommitted. `status` and `idempotency_key` are migration 0007 | **Done (slice 2)** | — |
| Resumes from last committed result | `driveRun` settles any call interrupted between its persist and its commit, re-driving it with the original key and the original decision, then continues from the committed results. Tested at three crash points × three steps, asserting exactly one effect per key. The sink-side half is now real for the eight live tools: an outbound goes out under the call's key (`ops.outbound_message.idempotency_key`), every row an executor writes has an id derived from that key (`exec/effects.effectId`, inserted `ON CONFLICT (id) DO NOTHING`), and every state change is a version-guarded `transition()`. A re-driven cancel finds its own `ops.attendance_exception` receipt and answers with the state it left rather than attempting a second write | **Done (slice 2–3)** | the same contract for the seven tools that have no executor yet |
| Delayed external responses are tasks with timers, never waiting sessions | an executor returning `awaitExternal` commits the call, raises an `ops.task` row, schedules a B-03 `agent.run.resume` timer and parks the run `WAITING_TOOL` — one transaction. The timer's handler is DB-only and re-triggers the run; the resume takes the next turn from the committed result. `request_clarification` is the first real user of it (15-minute await, coded completion predicate), and the ≤2/thread/hour limit is built, counted from the agent's own ledger | **Done (slice 2–3)** | the §11.2 "no reply → escalate" timer *on the task* — a second deadline past the first, which would escalate without a model turn — is still not built; today the resumed run decides |
| Tiers assembled fresh each run: **T1** approved facts + authorization (immutable) | `run/context.ts` rebuilds the whole prompt on every turn (nothing but the committed rows crosses a restart) and `tierPrompt` writes T1 first | Partial | the *sources*: T1 comes from B-02's approved profile and authorization scopes through B-07's tokenizer. `TierFacts` is supplied by the caller today |
| **T2** current state with versions, "fetched via tools before every write" | the readers are built (`get_leg_state` returns the leg, its version and the attendance day's version; `resolve_sender` returns the candidates and their legs) and the write guard is real: `cancel_attendance_or_leg` writes through `transition()` on the model's `expected_version`, and will not write at all unless this run's committed `resolve_sender` resolved the sender to exactly one authorized child (`machines.ts agentRequiresVerifiedGuardian`). `ExecutorCall.committed` is what makes "fetched before the write" enforceable rather than advisory — the authority comes from the committed results, never from an argument | **Done (slice 3)** | T2 is still *assembled* from `TierFacts` the caller supplies (the tier-source reader is the row above) |
| **T3** last N family-scoped messages wrapped as untrusted | every T3 body is wrapped in `<untrusted_user_message>` by the assembler, and the same list is handed to the policy engine as `untrustedMessages`, so the model and the injection check see one thread | Partial | selecting "last N" from `ops.message` is B-04 wiring |
| **T4** structured preferences (cannot override T1/T2) | T4 is written after T1/T2 and the prompt states the precedence; the enforceable part (a T3-cited write) is blocked by the policy engine | Partial | no preference store exists to read T4 from |
| Run scope (which site/family a run may touch) | the scope is part of the policy context the assembler returns, built by the caller from its session and never from a tool argument; the run row carries the site | Partial | the session → scope builder lands with the B-04/B-12 callers, per VERI-3 |

## §11.2 Tool catalog

All 15 tools exist as zod schemas with their tier and effect (`tools.ts`), and every one of them has
a policy row (`POLICY_ROWS`, VERI-1). Slice 2 gave every one of them an intent-recording entry.
Slice 3 gives **eight** of them a live executor in `run/exec/` (`registry.liveExecutors`) and the
two `human`-tier tools a proposal writer; the other **seven have no executor at all**, and the loop
records `NO_EXECUTOR` and stops the run rather than letting a stub answer "done".
`registry.unaccountedTools` is asserted empty against `TOOL_NAMES`, so the sixteenth tool has to be
placed in one of the three groups deliberately.

| Tool | Where it stands after slice 3 | Status |
|---|---|---|
| `resolve_sender` | `from_hmac` → `identity.guardian_contact` (the inbound handler's own lookup, at the message's received time), then the children that contact is **authorized** for (§6.4) and their legs on the service date. `confidence = 1/candidates`; one candidate names its legs, two name none. Unknown, unauthorized or own-echo → one `unknown_sender` AMBER task and the run ends — nothing is answered | **Done (slice 3)** |
| `get_leg_state` | leg + version + plan version, and the attendance day's state and version with it (a FULL_DAY cancel is guarded on that one) | **Done (slice 3)** |
| `cancel_attendance_or_leg` | AM/PM → that leg `CANCELED_TRANSPORT` as `A` (+ `AM_SELF_DROP` when a morning drop-off was named); FULL_DAY → the day `ABSENT_FULL_DAY` as `A`, both legs `CANCELED_ATTENDANCE` as `Y`. Guarded on the model's `expected_version` (leg's or day's), stale → `VERSION_CONFLICT` / 412 / `canceled_stale`; `expected_self_arrival` on the `ops.attendance_exception` row; the leg's `plan_version` bumped so queued messages about the old plan go CANCELED_STALE | **Done (slice 3)** |
| `request_clarification` | thread must be OPEN; **≤2/thread/hour** counted from `ops.agent_tool_call`; the question is an outbox message with fixed copy to the thread's counterparty; 15-minute await as a task + B-03 timer; send fail or no counterparty → exception task | **Done (slice 3)** |
| `record_acknowledgment` | matching PENDING ack → `ACKNOWLEDGED`/`DECLINED` as `T`, the deadline job canceled through B-03's scheduler, `DECLINED` → AMBER exception; already-in-state → idempotent | **Done (slice 3)** |
| `send_followup` | recipient computed from the audience and subject (authorized contact for the child, or the session's therapist); template/audience agreement enforced; plan-version basis read from the leg this run touched; the outbox re-checks suppression, consent, authorization and the plan at send time | **Done (slice 3)** — but see the three deferred rows below |
| `escalate_exception` | the `ops.task` row: the redacted summary, our next step by code, the leg and its child, INFO → GREEN. Works while paused | **Done (slice 3)** — severity *routing* beyond the row (Teams card, voice task) is B-12 |
| `close_task` | coded completion predicates checked by reading the evidence row back (`exec/predicate.ts`); evidence stamped before the state so the DB check holds; "else stays open" for unsatisfied evidence, a prose predicate, or a task staff have not resolved | **Done (slice 3)** — see the §6.3 row below |
| `propose_manifest_reallocation` | RED exception + `ops.approval_request` holding the options, written in the transaction that commits the PROPOSED call, carrying `approval_key`. No mutation, asserted against a before/after snapshot | **Done (slice 3)** — the Teams card is B-12 |
| `propose_contact_or_profile_change` | `ops.change_request` (NEEDS_HUMAN, the family's children as subjects, the message as basis) + AMBER exception, same transaction, same `approval_key` | **Done (slice 3)** — the approval *surface* that applies it is B-12 |
| `notify_affected_therapist` | overlapping-session lookup, minimized SMS, `THERAPIST_NOTIFIED`, the 10-minute ack timer | Deferred — no executor |
| `request_provider_capability` | capability UNKNOWN at T−90 / on substitution, signed dispatcher link, state REQUESTED, no reply → escalate | Deferred — no executor |
| `record_capability_report` | provider-contact-point check, observation row, low confidence → staff review | Deferred — no executor |
| `report_boarding` | guardian-reply / stationary-tap evidence, the `BOARDED_REPORTED` transition | Deferred — no executor |
| `summarize_thread_for_staff` | the staff note row (there is no table for one yet; the thread panel is B-12) | Deferred — no executor |

Three things the live executors deliberately do **not** do, each a decision rather than an omission:

| Not built | Why, and what it would take |
|---|---|
| `send_followup` fan-out to every authorized contact | §10.1 allows "1:1 broadcast" and a family often has two authorized guardians. Today a reply goes to whoever asked (read from the thread this run resolved), one authorized contact is unambiguous, and **several with nobody having asked is §10.3's two-guardian conflict**: an AMBER exception, not a guess. Fan-out is one message per contact, each keyed on the call's key plus the contact token |
| `send_followup` to `STAFF` or `PROVIDER_DISPATCHER` | both refused `UNSUPPORTED_AUDIENCE`. Staff are reached on Teams (B-12); a dispatcher needs an egress authorization path for `identity.external_person_identity`, which `dbRecipientAuthorizer` does not have — such a message would queue and then be blocked at send time, so it is refused up front. Dispatchers land with `request_provider_capability` |
| `close_task` on a task that is still OPEN | §6.3's task machine has no edge from OPEN to CLOSED_VERIFIED for any actor but a staff-resolved path, so the agent cannot close **its own** await tasks — including the 15-minute clarification one, which a person closes. Changing that is a change to the frozen §6.3 machine and a PRD question, not an executor's |

One honest exception to a rule, named because it is one: `resolve_sender` is a `read`-effect tool
(allowed while the agent is paused) and it writes **one** row — the `unknown_sender` task that is
§11.2's own failure column for it. It carries no copy of the message, no number and no model prose;
it is the same kind of write `escalate_exception` is allowed to make while paused, and it is how an
unrecognized number reaches a human instead of a reply.

Other §11.2 clauses:

| Clause | Where it stands | Status | Lands with |
|---|---|---|---|
| "free-text to parents **without human approval**" | the §11.2 tiers, exactly (founder decision above): a send whose copy is an allow-listed template id or a body rendered downstream from structured fields is `auto` and is ALLOWed; a send carrying the model's own words is held behind `ctx.approvedCalls` keyed on `approvalKey(tool, args)`. Which one a tool is comes from its `sendCopy` declaration, and a sending tool that declares nothing is read as free text. No catalog tool declares free text, and a templated one that *carries* any — an undeclared argument, a body-shaped argument name, a value that reads as a sentence, an interpolated or overlong value, an unrenderable template id, a var the template does not permit — is blocked `free_text_to_parents`, with or without an approval | — | — |
| Human approval itself | the rows a human would decide from now exist: `propose_contact_or_profile_change` writes `ops.change_request` (NEEDS_HUMAN) and `propose_manifest_reallocation` writes `ops.approval_request`, both in the transaction that commits the PROPOSED call and both carrying `approval_key` = the call row's `args_hash`. No surface produces an approval *decision* yet, and with the catalog as it stands nothing needs one: `ctx.approvedCalls` is empty everywhere but in tests. The proposed-row plumbing is built either way — a `PROPOSED` row carries `args_hash` = `approvalKey(tool, args)`, repeated in `result.approval_key`, so a human's signature and the exact call it releases match on one column. It is what the `human`-tier `propose_*` rows already use, and what a free-text sender would use on the day one is added | Partial | the approval UI + B-12 Teams card |
| "messaging non-consented numbers" | two checks now, as designed: the policy engine's early one against `ctx.sendableSubjects` (a set the caller passes), and the **real** one at send time — every message the agent queues goes through `outbox.drain`, which re-checks suppression (`ops.suppression`), consent (`identity.consent_event`), the recipient's authorization for that child and the template's vars before the provider is called. Tested end to end: a family that has opted out gets a QUEUED row and then BLOCKED_EGRESS, with zero sends | **Done (slice 3)** | `ctx.sendableSubjects` is still built by the caller (the session → scope builder, B-04/B-12) |
| Injection defenses: delimiters; schema-only tools; family-scope post-validator; identity_change_request | all four built and tested (VERI-1, VERI-3, VERI-4) | — | — |
| "red-team fixtures in CI (**≥100 adversarial cases by P2**)" | 45 fixtures + the VERI suites | Partial | P2; the gap is case count, not harness |
| Pause / kill switch ("sending while paused") | `ctx.paused` is a flag the caller sets; slice 3 adds the half that makes it useful — `escalate_exception` really does write its task while paused, so a stopped agent can still say why it stopped | Partial | the ops surface that sets the flag, in a later slice |
| LLM gateway: `redact()`, `validatePromptTokensOnly()`, JSON-schema-only, endpoint allow-list, per-call audit | all built and tested | — | — |
| …`validatePromptTokensOnly` name list | the synthetic fixture roster, not a name index | Partial | identity vault (B-07) swaps the list behind the same function |
| …per-call audit "of hashes only" | in memory, plus an optional sink. Slice 2 persists the run's hashes in the operational tables — `ops.agent_run.prompt_hash` per turn, `ops.agent_tool_call.args_hash` per call, with results holding codes rather than text — but nothing writes `ops.audit_event` yet | Partial | the audit-event writer (B-12/B-16) |
| `vendorAttestation` required in PHI mode | enforced; **no deployment may select PHI** (no BAA — ARCHITECTURE risk 3, ADR-000 #4) | Partial | AWS/Bedrock step |
| Rate limits | per gateway instance, in memory. Slice 2 adds the loop's step budget, counted from the **persisted** calls (`maxCallsPerRun`), so a resumed run does not get a fresh allowance the way the in-memory counter would | Partial | per-site/day budget + ADR-000 #11 spend alert |
| Live vendor call | `providers/remote.ts` is a typed placeholder that fails closed with no key (VERI-5); no HTTP body, no retries, no timeouts, no token/cost accounting. `ops.agent_run.tokens_in/out` stay NULL for the same reason | Deferred | a later slice (ADR-000 #4/#12: Claude Sonnet via OpenRouter, `zdr:true`) |

## §18.3 acceptance tests

| Test | Where it stands | Status |
|---|---|---|
| **AT-09** wrong-recipient / injection (zero sends) | evidenced **at the seam**: 45 fixtures + VERI-2/VERI-4 through the real gateway and the real policy engine, with a send sink that stays empty for every one of them, for every way of getting free text onto a templated send, and for every clean send once the agent is paused, a directive is in the thread, consent is withdrawn or the subject belongs to another family. The same sink receives exactly one send for each of the four clean, templated calls — so "zero" is a property of the defense and not of a harness that cannot send | Partial — no live traffic, no outbox behind it |
| **TEST-SEC-01** token-only prompts | `validatePromptTokensOnly` fails closed before the provider is called; audit holds hashes only | Partial — proved against the fixture roster, not the identity vault |
| AT-01 message→state→notify | **built and tested end to end inside the agent** (`exec/followup.test.ts`): one run resolves the sender from the message's contact point, reads the leg with its version, cancels it guarded on that version, and queues the confirmation — which the real outbox then drains to the provider after re-checking consent and the plan version. What reaches the provider is a template id and two codes: no name, no number, no prose. The one end still missing is the **trigger**: nothing calls `startAndDriveRun` from the inbound webhook yet (B-04), so the run is started by the test rather than by an arriving SMS | Partial (slice 3) — only the inbound caller is left |
| AT-02 autonomous timer follow-up + escalation | the follow-up half is real: a clarification goes out through the outbox, becomes a task + a B-03 timer, and the timer firing resumes the run, which then escalates to a staff task (`exec/clarify.test.ts`). What is still missing is the *deterministic* escalation — a second deadline **on the task** that escalates without a model turn — and the therapist side of it (`notify_affected_therapist` has no executor) | Partial (slice 3) |
| AT-06 sibling ambiguity | **built and tested** (`exec/reads.test.ts`, `exec/clarify.test.ts`, `exec/cancel.test.ts`): a shared number with two authorized children resolves to two candidates at half confidence and names no leg at all; the agent queues one fixed-copy question and parks on the 15-minute timer; and the "no mutation" half is asserted twice over — every leg and attendance day unchanged after the clarification, and a cancel attempted anyway refused `AMBIGUOUS_SENDER` by the executor's own guard rather than by the model's good manners | **Done (slice 3)** |
| AT-07 leg vs full-day absence | **built and tested** (`exec/cancel.test.ts`): AM/PM cancels transport and leaves attendance (plus `AM_SELF_DROP` when a drop-off was named), FULL_DAY cancels attendance and cascades both legs, each on its own machine with its own actor and its own version check. A leg past boarding is refused by the machine | **Done (slice 3)** |
| AT-08 version check / `canceled_stale` | **built and tested** (`exec/cancel.test.ts`): a version that moved under the agent writes nothing and answers `VERSION_CONFLICT` / 412 / `canceled_stale`, with the staff edit standing; and because a cancel bumps the leg's `plan_version`, a message already queued about that ride goes CANCELED_STALE at send time while a recomputed one goes out | **Done (slice 3)** |
| AT-04/05/12 approval-gated infeasibility and substitution | the proposal rows are now real — a RED exception plus an `ops.approval_request` holding the options, carrying the approval key, with a before/after snapshot asserting no mutation. The Teams card and the approval decision surface are B-12, and the solver side (what makes a manifest INFEASIBLE in the first place) is B-06 | Partial (slice 3) |
| AT-14 therapist notified ≤10 min, ack tracked | no executor; the 10-minute await is expressible (`awaitExternal`) but nothing sends | Deferred |
| AT-09 wrong-recipient / injection, with an outbox behind it | the slice-1 evidence is at the seam (above); slice 3 adds the half that was missing — a real `ops.outbound_message` behind every send, so "zero sends" is now also measured at the provider: an opted-out family, an unknown sender and a stale plan each produce zero provider calls with the message visibly BLOCKED_EGRESS or CANCELED_STALE | Partial — still no live inbound traffic (slice 4) |
| TEST-SEC-02 egress (zero `*.googleapis.com`, zero tokens in routing payloads) | VERI-5 proves the agent module makes no network call at all; the egress allow-list itself is B-16's | Partial |
| TEST-INF-01 restart (50 timers, exactly-once) | `JobScheduler`, not the agent — though the agent's own await timer is an ordinary `ops.job` row and rides the same guarded claim | Out of scope for B-08 |
| §18.4 source-mode matrix, LLM row: "Live vendor API, synthetic — proves tool-calling, policy, **recovery**" | policy is proved against scripted and recorded providers, and **recovery is now proved** against them too (crash-and-resume at every step, exactly one effect per call). **Live** tool-calling and live recovery remain unproven | Partial |

---

## What slices 1–3 claim

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

Slice 3 adds only this, for the eight tools that have one: a live executor reads and writes real
rows, through the machines and the outbox rather than around them. A cancel moves exactly the
machine's own edges, as the actor §6.3 names, guarded on the version the model was given, and it
will not move anything at all unless this run resolved its sender to one authorized child. A
sibling ambiguity therefore cannot become a mutation; it becomes one fixed-copy question, rate
limited to two an hour per thread, and a staff task on a timer. Every message the agent sends is an
`ops.outbound_message` the outbox drains, so consent, suppression, authorization and the plan
version are re-checked per contact at send time and a stale or suppressed message is visibly
refused instead of sent. Every row an executor writes has an id derived from the call's idempotency
key, so a re-driven step writes nothing twice. A `human`-tier call writes a change request or an
approval request and mutates nothing — asserted against a before-and-after snapshot of the tables,
not against a sink. And a tool with no executor fails its step shut: there is no stub in this slice
that reports an effect it did not have.

Everything else on this page is later work, and none of it is implied by the tests in these three
slices.
