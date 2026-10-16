# B-08 — every open item, and the slice it lands in

**Founder decision, 2026-10-15 — nothing in B-08 is "deferred".** This page used to use that word,
and it was the wrong one: it reads as "maybe, later, by somebody", and on a milestone that is going
to carry family messages that is not a status. Every open item below is **sequenced** — it has a
named slice, and it has to land **before B-08 closes**. The word "deferred" is gone from the status
key, and an item whose slice nobody can name does not get to stay on the page as a shrug.

| Open item | Sequenced to | Why there, and not here |
|---|---|---|
| **F2** — no per-run lease | **resolved — built in the queue slice** | the route exists (`/api/queues/agent`, topic `ppec-agent`) and it brought the claim with it, exactly as the sequencing said it would: `run/lease.ts` claims a run before `driveRun` is called and releases it after, so a second driver is refused up front instead of finding out at the commit. **No migration** — the lease is `state` + `version` + the `updated_by` holder slot, whose token carries the instant the claim was taken. What the queue slice did *not* bring is named in its own section below: the production **context assembler**, so the route acks rather than drives, and the trigger callers that would publish to the topic |
| **F4, F6** — two schema observations on migration 0007 | **resolved — `drizzle/0008_agent_status_backfill_type_owner.sql`** | 0007 is frozen (DATABASES.md: a frozen migration is fixed forward, never edited), so both corrections are a new file rather than an edit, and 0008 carries nothing else — F2's lease turned out not to be its co-tenant, having been built on the columns `ops.agent_run` already has. The snapshot swap it was sequenced behind is **gone, not done**: DECISION-LEDGER #66 drops the pre-migration snapshot step while the database holds demo data only, so "verified against real rows" is not what 0008 gets — it is verified against seeded PGlite rows, and has never run against any database |
| **F9** — no approval *decision* surface — and the approval screen itself | **B-12** | the rows a human decides from (`ops.change_request`, `ops.approval_request`, both carrying `approval_key`) are built here; the screen that signs one is the staff UI's, and so is the Teams card beside it |
| the **five missing executors** (`notify_affected_therapist`, `request_provider_capability`, `record_capability_report`, `report_boarding`, `summarize_thread_for_staff`), **two-guardian send** fan-out, **`STAFF` / `PROVIDER_DISPATCHER`** sends, and the **no-reply escalation timer** | **resolved — built in slice 4** | all five executors are live (`registry.liveExecutors`; `SEQUENCED_EXECUTORS` is now empty), the fan-out and both audiences are `exec/followup.ts`, and §11.2's "no reply → escalate" is a second B-03 deadline with no model turn in it (`exec/escalate.ts`). What slice 4 did *not* bring is named in its own section below: a dispatcher link **page** and the signer that mints its token |
| the **agent-side sweeper** and the **timer → queue hand-off** | **B-08 slice 7** | founder decision, 2026-10-16 (ledger row 67), on row 64's rule: the bar is the founder's, the slice name is ours. A fired await deadline makes a run QUEUED and publishes nothing, and nothing on a schedule delivers a QUEUED run — two halves of one gap, so one slice owns both. This **supersedes the sweeper's earlier placement in the live-provider slice**: the live call needs no sweep, and a run nobody delivers should not wait on the slice that spends money. Both rows are detailed in "What the queue slice did not bring" below |
| **token and cost accounting**, **retries beyond the single backup model**, and the **real-endpoint smoke test** — the three remainders of the live-provider slice | **B-08 slice 7** | founder decision, 2026-10-16 10:25 ET (ledger row 67), on the same rule: the bar is the founder's, the slice name is ours. Slice 5 (merged — PR #42) brings the live adapter and names what it does not bring — the vendor's usage numbers are never read (`ops.agent_run.tokens_in/out` stay NULL), there is one backup attempt and no backoff, and the live path is proved only with `fetch` mocked. They land in slice 7, beside the sweeper, because that is the slice that makes a run be re-driven on a schedule and retried past one attempt: counting what those drives spend belongs to that change rather than after it. One of the three is a **gate** and not just a sequence — **token accounting must be in before any paid model is configured** — and all three are detailed in "What the live-provider slice does not bring" below |
| `close_task` on a task that is still **OPEN** | **resolved — nothing left to sequence** | founder decision, 2026-10-15: **no new state transition.** §6.3 is unchanged; the tool *refuses*, with the named reason code `TASK_NOT_CLOSABLE_OPEN` and the staff-readable sentence `ui/copy.ts agentRefusals.closeTaskOpen`, and leaves the row exactly as it found it. Built and tested on this branch (`exec/staff.ts`, `exec/staff.test.ts`) |

Everything else on this page carries its slice in its own row, in the "Status" or "Lands with"
column. The **live vendor call** was the one item dated to B-08's own last slice, and slice 5 built
it (the provider choice is ADR-000 #4/#12) — so the only thing on this page that is genuinely
nobody's until later is the **≥100 red-team cases**, which the PRD itself dates to P2. What slice 5
left behind is small and named in its row: no token/cost accounting, no retry beyond the single
backup attempt, and no real-endpoint smoke test. The live-provider slice was B-08's *last* until
2026-10-16: slice 7 (the sweeper, the timer → queue hand-off, and those three remainders of slice 5)
is sequenced beside it, so "last" is no longer the thing that makes it late — spending money and
leaving the building is. And the one thing on this page that is a **precondition** rather than an
ordering says so where it is decided and here: **token and cost accounting (slice 7) must land
before any paid model id is configured** — while the model is the free one on demo data only, an
unpriced run is an observability gap; the moment it is a paid one it is a spend-control gap.

---

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
B-03's `JobScheduler`) — plus the `human`-tier proposal rows. Ten tools do something — eight an
effect, two a proposal row — and the remaining five did not: a tool with no live executor fails its
step shut (`NO_EXECUTOR`) rather than reporting an effect it did not have.

Slice 4 (commits "B-08 slice 4 — …") closes that gap and the two send gaps beside it: the **five
remaining executors** (`notify_affected_therapist`, `request_provider_capability`,
`record_capability_report`, `report_boarding`, `summarize_thread_for_staff`), the **two-guardian
fan-out**, the **`STAFF` and `PROVIDER_DISPATCHER`** audiences, and §11.2's **"no reply →
escalate"** as a second B-03 deadline with no model turn in it. `registry.SEQUENCED_EXECUTORS` is
now **empty** — every `auto` tool acts on real state and the two `human` ones write proposals — and
the constant stays only because the rule it stands for does: a tool absent from `liveExecutors`
still fails shut, and `unaccountedTools` still makes the sixteenth tool a deliberate placement.
Slice 4 adds **no migration**: nothing it builds needed a column that migration 0007 does not
already have.

The **queue slice** (commits "B-08 queue slice — …") makes the run a **job that something
delivers**, which is the §11.1 row "the run is not yet a *queue* job" and the home F2's lease was
sequenced to. Three files and a route:

* `run/queue.ts` — the topic (`ppec-agent`), the payload (`{ runId, siteId }`, so the tenant is the
  publisher's word and the claim is fenced on it), `enqueueRun` (= `startRun` + one publish keyed
  `agent:run:<runId>`) and `handleAgentWake` (parse → claim → drive → release). Every refusal is a
  no-op and an ack; only a drive that threw propagates, because that is the one case a redelivery
  helps. The delivery knobs are pinned against the lease: lease (150 s) > the route's `maxDuration`
  (120 s), and the visibility timeout (300 s) and the retry delay (the lease) > the lease.
* `run/lease.ts` — the claim. `SELECT … FOR UPDATE` → re-check → compare-and-set in one
  transaction, the same shape as B-03's `claimForWake`, with **no schema change**: `state` decides
  what is claimable, `version` fences the claim, and `updated_by` is the holder slot, holding a
  token that carries the instant the claim was taken so no later write can renew it by accident.
  There is no heartbeat, unlike B-03's 2 s lease, because this one outlives the invocation — the
  platform kills a wedged driver before its claim can expire.
* `run/deps.ts` — the honest part: what the route would drive a run *with*, and why it has none.
* `/api/queues/agent` — the consumer, its `queue-callback` auth row and its `vercel.json` trigger.

**Slice 5** (commits "B-08 slice 5 — …") switches the vendor on, which is why it was sequenced
last: it is the only part of B-08 that spends money and leaves the building. Two files carry it.

* `config.ts` — the model ids (`MODEL_PRIMARY`, `MODEL_BACKUP`), the `modelAllowList` that refuses
  anything else at config time, the base URL, the request timeout, and the **demo-data-only
  guard**. The founder's 2026-10-15 decision replaced ADR-000 #12's Sonnet + ZDR shape for now: a
  free OpenRouter model, demo data only, with the HIPAA-compliant endpoint sequenced behind a
  signed BAA. `AGENT_DEMO_DATA_ONLY` must be exactly `true` — it is deliberately **not**
  `AGENT_DATA_MODE`, which already means `SYNTHETIC|PHI` on this module, and the reasoning is in
  docs/research/QUEUES-AND-OPENROUTER-ZDR.md §2.5B.
* `providers/remote.ts` — the adapter. The guard refuses before the key is read, a body is built or
  a URL is constructed, and is re-checked on every `invoke()`; then primary model, backup on a 429
  or any other failure, and finally the PRD §18.1 keyword parser (`providers/keyword.ts`), which
  escalates to staff rather than guessing a cancellation from five characters of SMS.

Slice 5 adds **no migration** — nothing it builds needed a column — and no dependency. Two tests
are the load-bearing ones: `no-hardcoded-models.test.ts` scans every `.ts`/`.tsx` under `src/` and
fails on a model id outside the config module, so the later switch stays an env change; and
`live-approval-tiers.test.ts` drives the real adapter through the real gateway into the real policy
engine and proves the §11.2 tiers decide identically there and against the fake. The Sonnet + ZDR
production start-up guard is **documented and not built**, by instruction: it belongs to the later
endpoint, whose choice is still open.

The queue slice adds **no migration** either, and this was the file where one looked most likely:
`ops.agent_run` has no `claimed_by`/`claimed_until`, and the lease was built from the columns it
already has rather than opening a 0008 for them. The columns a `0008` would add are still the
tidier shape and are *not* sequenced to it — the lease does not need them.

This file is the honest other half of all three: every part of B-08's PRD scope — **§11.1
Invocation and context** (PRD l.924), **§11.2 Tool catalog** (l.926–993) and **§18.3 acceptance
tests** (l.1333) — that is still to come, so nothing in any of the diffs can be mistaken for a
claim about it. Rows marked **Done (slice 2)** or **Done (slice 3)** below were promises on an
earlier version of this page and are now built and tested; everything else is still outstanding —
and outstanding here means **sequenced**, per the table above.

Status key: **Sequenced (0008 / B-12 / slice 7 / live-provider slice)** = not built, owned by that
slice, and a condition of B-08 closing. **Partial** = the mechanism exists, the wiring does not;
the column beside it names who finishes it. **Done (slice 2)** = built and tested in `src/modules/agent/run/`.
**Done (slice 3 / slice 4)** = built and tested in `src/modules/agent/run/exec/`. **Done (queue
slice)** = built and tested in `src/modules/agent/run/{queue,lease}.ts` and
`src/app/api/queues/agent/`. Nothing is sequenced to **slice 4** or to the **queue slice** any
more: both have landed, and what each left behind is named rather than carried.

**Founder decision, 2026-10-15:** the approval policy is narrowed back to the **PRD §11.2 tiers**.
Slice 1 held *every* send behind a human approval, which was tighter than §11.2 and is no longer
what we ship: the templated follow-ups are `auto` and send on their own, and only free text to a
parent needs a human approval bound to the exact call. Since no tool in the catalog can carry free
text, the practical effect is that the agent now sends its allow-listed messages autonomously and
there is no call it can make that puts prose in front of a family. The two halves are
`policy.ts` steps 6 and 10, the declaration that decides which applies is `tools.ts` `sendCopy`, and
the bar is held by `attacks.test.ts` (VERI-2) and `free-text-approval.test.ts`. Nothing else about
the gate moved: pause, consent, scope, injection and the `human`-tier `propose_*` rows are
unchanged, and the staff approval surface is the B-12 row below (F9).

---

## §11.1 Invocation and context

| PRD text | Where it stands after slice 3 | Status | What is left, and with whom |
|---|---|---|---|
| Triggers: `msg.inbound`, operational event (rules first), timer/deadline, overdue sweeper (5 min), ETA threshold (deterministic → template), reconciliation (hourly/EOD) | the five trigger types that start a run are `run/triggers.ts`, with the rule that a trigger id is the id of the thing that happened; `startAndDriveRun(trigger)` is the entry point. ETA threshold is deliberately **not** a type: §11.1 marks it "deterministic → template", so it renders copy without a model turn | Partial | the five *callers*: the B-04 inbound webhook, the operational-rules handoff, the 5-minute overdue sweep and the hourly/EOD reconciliation cron each belong to their own milestone. Only the `timer.deadline` caller exists (an agent timer re-triggering its own run) |
| Each run = job with idempotency `(trigger_type, trigger_id)` | `startRun` inserts `ON CONFLICT (trigger_type, trigger_id) DO NOTHING` and returns the run that already exists; concurrent duplicate starts collapse onto one row (tested five-way). Every entry point into the loop is fenced on the site: a run of another tenant is refused rather than driven (F3). The run is now also a **queue** job: `enqueueRun` publishes one wake-up per run to topic `ppec-agent`, `/api/queues/agent` consumes it, and the **per-run lease** (`run/lease.ts`, F2) claims the run before `driveRun` is called — so two drivers on one run are refused up front rather than bounded after the fact, an expired claim is reclaimed by the next delivery, and the claim is released on park, success and failure | **Done (slices 2–3, queue slice)** | the two ends of the queue, both outside this slice: nothing **publishes** (the five §11.1 trigger callers are B-04 and the cron milestones, row below) and the consumer does not yet **drive**, because production has no context assembler (`run/deps.ts`) — so in production the topic is empty and a delivery would ack with that named reason |
| Tool calls persisted **before** execution | `persistCall` commits the row — args fingerprint, redaction-safe args, policy decision, `status='PENDING'`, idempotency key — in its own transaction before any executor runs; the executor's own probe asserts it sees that row PENDING and uncommitted. `status` and `idempotency_key` are migration 0007 | **Done (slice 2)** | — |
| Resumes from last committed result | `driveRun` settles any call interrupted between its persist and its commit, re-driving it with the original key and **the stricter of its original decision and the one the current context gives it** (`tightenOnResume`, Veri F1: a pause or a withdrawn consent that landed during the outage refuses the step; a persisted BLOCK is never loosened), then continues from the committed results. Tested at three crash points × three steps, asserting exactly one effect per key. The sink-side half is real for every live tool: an outbound goes out under the call's key (`ops.outbound_message.idempotency_key`), every row an executor writes has an id derived from that key (`exec/effects.effectId`, inserted `ON CONFLICT (id) DO NOTHING`), and every state change is a version-guarded `transition()`. A re-driven cancel finds its own `ops.attendance_exception` receipt and answers with the state it left rather than attempting a second write | **Done (slices 2–4)** | — every tool with an effect now keys it on the call's idempotency key: the therapist ack row, the dispatcher link, the staff note and the no-reply escalation task are all `effectId(key, …)` with `ON CONFLICT (id) DO NOTHING`, and every state change is a version-guarded `transition()` |
| Delayed external responses are tasks with timers, never waiting sessions | an executor returning `awaitExternal` commits the call, raises an `ops.task` row, schedules a B-03 `agent.run.resume` timer and parks the run `WAITING_TOOL` — one transaction. The timer's handler is DB-only and re-triggers the run; the resume takes the next turn from the committed result. Slice 4 adds the **second** deadline beside it: `agent.await.escalate` fires a minute past the first, reads the one row that would show an answer (the thread, the ack, the vehicle-day) and raises the exception with **no model turn** if there is none — because the resumed run is the thing that may not happen (a refusal, an exhausted budget, a paused agent). Three real users now: a clarification, a therapist ack and a capability request | **Done (slices 2–4)** | — |
| Tiers assembled fresh each run: **T1** approved facts + authorization (immutable) | `run/context.ts` rebuilds the whole prompt on every turn (nothing but the committed rows crosses a restart) and `tierPrompt` writes T1 first | Partial | the *sources*: T1 comes from B-02's approved profile and authorization scopes through B-07's tokenizer. `TierFacts` is supplied by the caller today |
| **T2** current state with versions, "fetched via tools before every write" | the readers are built (`get_leg_state` returns the leg, its version and the attendance day's version; `resolve_sender` returns the candidates and their legs) and the write guard is real: `cancel_attendance_or_leg` writes through `transition()` on the model's `expected_version`, and will not write at all unless this run's committed `resolve_sender` resolved the sender to exactly one authorized child (`machines.ts agentRequiresVerifiedGuardian`). `ExecutorCall.committed` is what makes "fetched before the write" enforceable rather than advisory — the authority comes from the committed results, never from an argument | **Done (slice 3)** | T2 is still *assembled* from `TierFacts` the caller supplies (the tier-source reader is the row above) |
| **T3** last N family-scoped messages wrapped as untrusted | every T3 body is wrapped in `<untrusted_user_message>` by the assembler, and the same list is handed to the policy engine as `untrustedMessages`, so the model and the injection check see one thread | Partial | selecting "last N" from `ops.message` is B-04 wiring |
| **T4** structured preferences (cannot override T1/T2) | T4 is written after T1/T2 and the prompt states the precedence; the enforceable part (a T3-cited write) is blocked by the policy engine | Partial | no preference store exists to read T4 from |
| Run scope (which site/family a run may touch) | the scope is part of the policy context the assembler returns, built by the caller from its session and never from a tool argument; the run row carries the site, and the loop now checks that the two agree before it takes a turn (Veri F3 — a scope built for another tenant passes its own check and would then execute against this run's rows) | Partial | the session → scope builder lands with the B-04/B-12 callers, per VERI-3 |

## §11.2 Tool catalog

All 15 tools exist as zod schemas with their tier and effect (`tools.ts`), and every one of them has
a policy row (`POLICY_ROWS`, VERI-1). Slice 2 gave every one of them an intent-recording entry.
Slice 3 gave **eight** of them a live executor in `run/exec/` (`registry.liveExecutors`) and the two
`human`-tier tools a proposal writer; **slice 4 gives the last five one**, so all thirteen `auto`
tools now act on real state and `registry.SEQUENCED_EXECUTORS` is empty. The loop still records
`NO_EXECUTOR` and stops the run for a tool that has none, rather than letting a stub answer "done",
and `registry.unaccountedTools` is still asserted empty against `TOOL_NAMES`, so the sixteenth tool
has to be placed in one of the three groups deliberately.

| Tool | Where it stands after slice 3 | Status |
|---|---|---|
| `resolve_sender` | `from_hmac` → `identity.guardian_contact` (the inbound handler's own lookup, at the message's received time), then the children that contact is **authorized** for (§6.4) and their legs on the service date. `confidence = 1/candidates`; one candidate names its legs, two name none. Unknown, unauthorized or own-echo → one `unknown_sender` AMBER task and the run ends — nothing is answered | **Done (slice 3)** |
| `get_leg_state` | leg + version + plan version, and the attendance day's state and version with it (a FULL_DAY cancel is guarded on that one) | **Done (slice 3)** |
| `cancel_attendance_or_leg` | AM/PM → that leg `CANCELED_TRANSPORT` as `A` (+ `AM_SELF_DROP` when a morning drop-off was named); FULL_DAY → the day `ABSENT_FULL_DAY` as `A`, both legs `CANCELED_ATTENDANCE` as `Y`. Guarded on the model's `expected_version` (leg's or day's), stale → `VERSION_CONFLICT` / 412 / `canceled_stale`; `expected_self_arrival` on the `ops.attendance_exception` row; the leg's `plan_version` bumped so queued messages about the old plan go CANCELED_STALE | **Done (slice 3)** |
| `request_clarification` | thread must be OPEN; **≤2/thread/hour** counted from `ops.agent_tool_call`; the question is an outbox message with fixed copy to the thread's counterparty; 15-minute await as a task + B-03 timer; send fail or no counterparty → exception task | **Done (slice 3)** |
| `record_acknowledgment` | matching PENDING ack → `ACKNOWLEDGED`/`DECLINED` as `T`, the deadline job canceled through B-03's scheduler, `DECLINED` → AMBER exception; already-in-state → idempotent | **Done (slice 3)** |
| `send_followup` | recipients computed from the audience and subject; template/audience agreement enforced; plan-version basis read from the leg this run touched; the outbox re-checks suppression, consent, authorization and the plan **per contact** at send time. Slice 4 completed it: the two-guardian fan-out, the `STAFF` task and the `PROVIDER_DISPATCHER` send | **Done (slices 3–4)** |
| `escalate_exception` | the `ops.task` row: the redacted summary, our next step by code, the leg and its child, INFO → GREEN. Works while paused | **Done (slice 3)** — severity *routing* beyond the row (Teams card, voice task) is B-12 |
| `close_task` | coded completion predicates checked by reading the evidence row back (`exec/predicate.ts`); evidence stamped before the state so the DB check holds; "else stays open" for unsatisfied evidence or a prose predicate; and an **OPEN** task refused by name — `TASK_NOT_CLOSABLE_OPEN` plus `agentRefusals.closeTaskOpen`, with the row left exactly as it was found | **Done (slice 3)**, including the §6.3 question, which the founder answered: refuse, do not widen the machine |
| `propose_manifest_reallocation` | RED exception + `ops.approval_request` holding the options, written in the transaction that commits the PROPOSED call, carrying `approval_key`. No mutation, asserted against a before/after snapshot | **Done (slice 3)** — the Teams card is B-12 |
| `propose_contact_or_profile_change` | `ops.change_request` (NEEDS_HUMAN, the family's children as subjects, the message as basis) + AMBER exception, same transaction, same `approval_key` | **Done (slice 3)** — the approval *surface* that applies it is B-12 |
| `notify_affected_therapist` | the session has to be on the service date *this run read*, in the site's zone, and about the child the call names; the impact code picks the body (the tool declares `fixed` copy) and the only value on it is the session's start time; status `SCHEDULED\|IMPACTED → THERAPIST_NOTIFIED` guarded on its version; a PENDING `ops.acknowledgment` and the 10-minute await, whose second deadline expires the ack and escalates | **Done (slice 4)** — `exec/therapist.ts` |
| `request_provider_capability` | T−90 measured from `min(window_start)` over the route's legs, or at once for a substitution (a row reset to UNKNOWN above version 1); `UNKNOWN → REQUESTED` as `A`; a single-use hashed `ops.dispatcher_link` **when a signer is configured** and an `INTENT_RECORDED` link when none is (P1 has none); the dispatcher's fixed-copy notice through the outbox; no dispatcher contact point → refused by name, staff task, row left UNKNOWN; no reply → the escalation timer | **Done (slice 4)** — `exec/capability.ts`, and it brought the dispatcher egress path (`outbox/policy.recipientKind` → "dispatcher") |
| `record_capability_report` | the evidence message's blind index must be the one identity holds for *that vehicle's provider's* dispatcher; `REQUESTED → REPORTED` as `P` with `observed_at` / `observed_by` / `evidence_message_id` in the same transaction; below 0.7 confidence the answer is kept and an AMBER review raised. The parsed layout and seat counts stay on the call row — `vehicle_capability_day` has no column for them | **Done (slice 4)** — `exec/capability.ts` |
| `report_boarding` | `ARRIVED_PICKUP → BOARDED_REPORTED` only, on the model's `expected_version`, as `G` for a guardian reply (same bar as a cancel: one authorized child, and this leg's) or `P` for a tap whose vehicle is *demonstrably* stationary — newest bound telemetry point, inside the GPS stale band, under the ASM-18 geofence speed | **Done (slice 4)** — `exec/boarding.ts` |
| `summarize_thread_for_staff` | one GREEN `ops.task` row: the model's redacted sentence, the locator that names the step, a prose predicate so the agent cannot close its own note, and nothing queued | **Done (slice 4)** — `exec/staff.ts`. **No migration was needed**: the note went on the staff queue that exists rather than into a table opened for it, and the thread panel that would hold it properly is B-12's |

Three things the slice-3 executors deliberately did **not** do. Each was a decision rather than an
omission, and all three are now finished — the first two in slice 4, the third by the founder's
answer:

| Not built here | Why, and where it lands |
|---|---|
| `send_followup` fan-out to every authorized contact — **done (slice 4)** | §10.1 allows "1:1 broadcast" and a family often has two authorized guardians, so which message goes to which of them is now a rule rather than a single recipient. A **decision** template (`leg.canceled`, `leg.changed`) confirms what one parent asked for and goes back to **them only** — telling the other that the request was made is a disclosure about the first. A **notice** (an ETA, the fixed notice) is news about a ride both are entitled to, so it fans out to every authorized contact with the asker first: one message per contact, the asker's keyed on the call's key and each other on that key plus the contact's token, all in one transaction. **Several authorized contacts with nobody having asked is still §10.3's two-guardian conflict** — an AMBER exception and zero sends, which is also how §6.6 settles it ("most-restrictive wins; staff resolves"). Consent is still re-checked per contact at send time, so a family where one parent has opted out sends to the other and visibly refuses that one |
| `send_followup` to `STAFF` or `PROVIDER_DISPATCHER` — **done (slice 4)**, differently for each | The dispatcher is now a real send: `recipientKind` recognizes a provider's `dispatcher_person_token` as its own kind and `dbRecipientAuthorizer` checks that person against `identity.external_person_identity` and then their consent, so a dispatcher who texts STOP is blocked at egress like anyone else. `STAFF` is deliberately **not** a message — Teams is §10.4's channel and its adapter is B-12 — so a staff follow-up writes the GREEN `ops.task` row their board already shows, carrying the child and, when the subject is a leg, the ride. Two refusals stay, by name: a child template to a dispatcher (`TEMPLATE_NOT_FOR_AUDIENCE`) and a provider with no contact point (`NO_DISPATCHER_CONTACT`). One edge is recorded in the module rather than fixed: `send_followup` is a `send`-effect tool, so the policy engine consent-checks its subject even for the STAFF audience — stricter than §11.2 asks, fail-shut, and `escalate_exception` is the tool for telling staff about a family that has opted out |
| `close_task` on a task that is still OPEN — **resolved, founder decision 2026-10-15** | §6.3's task machine has no edge from OPEN to CLOSED_VERIFIED for any actor but a staff-resolved path, so the agent cannot close **its own** await tasks — including the 15-minute clarification one, which a person closes. The founder's answer is **no new transition**: the tool refuses, explicitly and never silently, with the reason code `TASK_NOT_CLOSABLE_OPEN`, the staff-readable sentence in `ui/copy.ts` (`agentRefusals.closeTaskOpen`) and the task row untouched — asserted in `exec/staff.test.ts` ("refuses an OPEN task with an explicit reason, and leaves the row exactly as it was"). The three unresolved states are told apart on purpose: OPEN is the one the agent reaches on its own account, so it gets its own name, while IN_PROGRESS and SNOOZED keep `TASK_NOT_RESOLVED` |

One honest exception to a rule, named because it is one: `resolve_sender` is a `read`-effect tool
(allowed while the agent is paused) and it writes **one** row — the `unknown_sender` task that is
§11.2's own failure column for it. It carries no copy of the message, no number and no model prose;
it is the same kind of write `escalate_exception` is allowed to make while paused, and it is how an
unrecognized number reaches a human instead of a reply.

Other §11.2 clauses:

| Clause | Where it stands | Status | Lands with |
|---|---|---|---|
| "free-text to parents **without human approval**" | the §11.2 tiers, exactly (founder decision above): a send whose copy is an allow-listed template id or a body rendered downstream from structured fields is `auto` and is ALLOWed; a send carrying the model's own words is held behind `ctx.approvedCalls` keyed on `approvalKey(tool, args)`. Which one a tool is comes from its `sendCopy` declaration, and a sending tool that declares nothing is read as free text. No catalog tool declares free text, and a templated one that *carries* any — an undeclared argument, a body-shaped argument name, a value that reads as a sentence, an interpolated or overlong value, an unrenderable template id, a var the template does not permit — is blocked `free_text_to_parents`, with or without an approval | — | — |
| Human approval itself | the rows a human would decide from now exist: `propose_contact_or_profile_change` writes `ops.change_request` (NEEDS_HUMAN) and `propose_manifest_reallocation` writes `ops.approval_request`, both in the transaction that commits the PROPOSED call and both carrying `approval_key` = the call row's `args_hash`. No surface produces an approval *decision* yet, and with the catalog as it stands nothing needs one: `ctx.approvedCalls` is empty everywhere but in tests. The proposed-row plumbing is built either way — a `PROPOSED` row carries `args_hash` = `approvalKey(tool, args)`, repeated in `result.approval_key`, so a human's signature and the exact call it releases match on one column. It is what the `human`-tier `propose_*` rows already use, and what a free-text sender would use on the day one is added | Partial — **Veri F9** | the approval UI + B-12 Teams card |
| "messaging non-consented numbers" | two checks now, as designed: the policy engine's early one against `ctx.sendableSubjects` (a set the caller passes), and the **real** one at send time — every message the agent queues goes through `outbox.drain`, which re-checks suppression (`ops.suppression`), consent (`identity.consent_event`), the recipient's authorization for that child and the template's vars before the provider is called. Tested end to end: a family that has opted out gets a QUEUED row and then BLOCKED_EGRESS, with zero sends | **Done (slice 3)** | `ctx.sendableSubjects` is still built by the caller (the session → scope builder, B-04/B-12) |
| Injection defenses: delimiters; schema-only tools; family-scope post-validator; identity_change_request | all four built and tested (VERI-1, VERI-3, VERI-4) | — | — |
| "red-team fixtures in CI (**≥100 adversarial cases by P2**)" | 45 fixtures + the VERI suites | Partial | P2; the gap is case count, not harness |
| Pause / kill switch ("sending while paused") | `ctx.paused` is a flag the caller sets; slice 3 adds the two halves that make it useful — `escalate_exception` really does write its task while paused, so a stopped agent can still say why it stopped, and a pause that lands *during* a crash is not outrun by the resume (Veri F1: a resumed PENDING ALLOW re-decides tighten-only, so the send is refused and nothing is queued) | Partial | the ops surface that sets the flag: **B-12**, beside F9's approval screen — a kill switch is a thing a person reaches for, so it lands with the staff UI and not with a runtime slice |
| LLM gateway: `redact()`, `validatePromptTokensOnly()`, JSON-schema-only, endpoint allow-list, per-call audit | all built and tested | — | — |
| …`validatePromptTokensOnly` name list | the synthetic fixture roster, not a name index | Partial | identity vault (B-07) swaps the list behind the same function |
| …per-call audit "of hashes only" | in memory, plus an optional sink. Slice 2 persists the run's hashes in the operational tables — `ops.agent_run.prompt_hash` per turn, `ops.agent_tool_call.args_hash` per call, with results holding codes rather than text — but nothing writes `ops.audit_event` yet | Partial | the audit-event writer (B-12/B-16) |
| `vendorAttestation` required in PHI mode | enforced; **no deployment may select PHI** (no BAA — ARCHITECTURE risk 3, ADR-000 #4) | Partial | AWS/Bedrock step |
| Rate limits | per gateway instance, in memory. Slice 2 adds the loop's step budget, counted from the **persisted** calls (`maxCallsPerRun`), so a resumed run does not get a fresh allowance the way the in-memory counter would | Partial | per-site/day budget + ADR-000 #11 spend alert — both of which need something to count, and the counting (token and cost accounting) is **slice 7**'s, before any paid model is configured (ledger row 67) |
| Live vendor call | **resolved — built in slice 5.** `providers/remote.ts` has a real HTTP body: `fetch` to `config.baseUrl + endpoint`, the key read by env var name only and sent in the authorization header, `allow_fallbacks:false` and `require_parameters:true` on every request, a timeout (`AGENT_REQUEST_TIMEOUT_MS`), and a fallback chain of primary → backup model → the §18.1 keyword parser. The founder's 2026-10-15 decision changed the model under it: a **free** OpenRouter model on **demo data only** (`AGENT_DEMO_DATA_ONLY=true`, fail shut), with Sonnet + ZDR moved to the later HIPAA endpoint and documented but **not built** (docs/research/QUEUES-AND-OPENROUTER-ZDR.md §2.5/§2.5A/§2.5B). Model ids live in `config.ts` alone, enforced by `no-hardcoded-models.test.ts` scanning all of `src/`. **Still open:** no token/cost accounting — `ops.agent_run.tokens_in/out` stay NULL — no retry beyond the single backup attempt (a 429 degrades to the keyword parser rather than backing off), and no real-endpoint smoke test | **resolved — built in slice 5**, with its three remainders sequenced to **slice 7** | ADR-000 #4/#12, as amended by the founder 2026-10-15. It was sequenced last for a plain reason, and that reason held: a live call is the only item here that spends money and leaves the building, so it was the last thing switched on. What the slice was *not* expected to close is named rather than left to it: **token and cost accounting**, **retries beyond the single backup model** and the **real-endpoint smoke test** are sequenced to **B-08 slice 7** (founder decision 2026-10-16 10:25 ET, ledger row 67), with the accounting a **gate on configuring any paid model** — see "What the live-provider slice does not bring" below |

## §18.3 acceptance tests

| Test | Where it stands | Status |
|---|---|---|
| **AT-09** wrong-recipient / injection (zero sends) | evidenced **at the seam**: 45 fixtures + VERI-2/VERI-4 through the real gateway and the real policy engine, with a send sink that stays empty for every one of them, for every way of getting free text onto a templated send, and for every clean send once the agent is paused, a directive is in the thread, consent is withdrawn or the subject belongs to another family. The same sink receives exactly one send for each of the four clean, templated calls — so "zero" is a property of the defense and not of a harness that cannot send | Partial — no live traffic, no outbox behind it |
| **TEST-SEC-01** token-only prompts | `validatePromptTokensOnly` fails closed before the provider is called; audit holds hashes only | Partial — proved against the fixture roster, not the identity vault |
| AT-01 message→state→notify | **built and tested end to end inside the agent** (`exec/followup.test.ts`): one run resolves the sender from the message's contact point, reads the leg with its version, cancels it guarded on that version, and queues the confirmation — which the real outbox then drains to the provider after re-checking consent and the plan version. What reaches the provider is a template id and two codes: no name, no number, no prose. The one end still missing is the **trigger**: nothing calls `startAndDriveRun` from the inbound webhook yet (B-04), so the run is started by the test rather than by an arriving SMS | Partial (slice 3) — only the inbound caller is left |
| **AT-02** autonomous timer follow-up + escalation | **built and tested** (`exec/clarify.test.ts`, `exec/escalate.test.ts`): the follow-up goes out through the outbox, becomes a task + a B-03 timer, and the timer firing resumes the run — and past a second deadline the escalation happens *deterministically*, with no model in the path: one AMBER exception through the same writer `escalate_exception` uses, exactly once however often the wake-up is delivered, and nothing at all when the reply arrived in time. Proved on all three waits (clarification, therapist ack, capability) | **Done (slice 4)** |
| AT-06 sibling ambiguity | **built and tested** (`exec/reads.test.ts`, `exec/clarify.test.ts`, `exec/cancel.test.ts`): a shared number with two authorized children resolves to two candidates at half confidence and names no leg at all; the agent queues one fixed-copy question and parks on the 15-minute timer; and the "no mutation" half is asserted twice over — every leg and attendance day unchanged after the clarification, and a cancel attempted anyway refused `AMBIGUOUS_SENDER` by the executor's own guard rather than by the model's good manners | **Done (slice 3)** |
| AT-07 leg vs full-day absence | **built and tested** (`exec/cancel.test.ts`): AM/PM cancels transport and leaves attendance (plus `AM_SELF_DROP` when a drop-off was named), FULL_DAY cancels attendance and cascades both legs, each on its own machine with its own actor and its own version check. A leg past boarding is refused by the machine | **Done (slice 3)** |
| AT-08 version check / `canceled_stale` | **built and tested** (`exec/cancel.test.ts`): a version that moved under the agent writes nothing and answers `VERSION_CONFLICT` / 412 / `canceled_stale`, with the staff edit standing; and because a cancel bumps the leg's `plan_version`, a message already queued about that ride goes CANCELED_STALE at send time while a recomputed one goes out | **Done (slice 3)** |
| AT-04/05/12 approval-gated infeasibility and substitution | the proposal rows are real — a RED exception plus an `ops.approval_request` holding the options, carrying the approval key, with a before/after snapshot asserting no mutation — and slice 4 adds the capability half in front of them: a substitution is asked about at once rather than at T−90, the provider's answer is recorded `REPORTED` only, and a low-confidence parse is a staff review beside it. The Teams card and the approval decision surface are B-12, and the solver side (what makes a manifest INFEASIBLE) is B-06 | Partial (slices 3–4) |
| **AT-14** therapist notified ≤10 min, ack tracked | **built and tested** (`exec/therapist.test.ts`, `exec/escalate.test.ts`): the overlapping session is found on the date this run read, the minimized SMS goes out through the real outbox (a template id and a site-local clock time — no name, no number, no prose), the session moves to `THERAPIST_NOTIFIED` on its own version, and the ack is a PENDING row on a ten-minute deadline whose expiry closes it `EXPIRED_ESCALATED` and raises one AMBER exception. Recording the ack cancels that deadline and leaves the resume timer alone | **Done (slice 4)** |
| AT-09 wrong-recipient / injection, with an outbox behind it | the slice-1 evidence is at the seam (above); slice 3 added a real `ops.outbound_message` behind every send, so "zero sends" is also measured at the provider — an opted-out family, an unknown sender and a stale plan each produce zero provider calls with the message visibly BLOCKED_EGRESS or CANCELED_STALE — and slice 4 adds the two recipients that are not families: an opted-out **dispatcher** is blocked at egress too, and the one guardian of two who has opted out is refused while the other is sent | Partial — still no live inbound traffic (the B-04 caller) |
| TEST-SEC-02 egress (zero `*.googleapis.com`, zero tokens in routing payloads) | VERI-5 is **narrowed, not dropped**, now that slice 5 ships a live adapter: `providers/remote.ts` is the only file in the module that may call `fetch` and `config.ts` the only one that may hold a URL — per *pattern*, with every other pattern (node network modules, HTTP client packages, browser transports) still applying to both, and an exemption that stops being needed failing the suite. So the destination is still exactly one configured host and the prompt is still tokens only. The egress allow-list itself is B-16's | Partial |
| TEST-INF-01 restart (50 timers, exactly-once) | `JobScheduler`, not the agent — though the agent's own await timer is an ordinary `ops.job` row and rides the same guarded claim | Out of scope for B-08 |
| §18.4 source-mode matrix, LLM row: "Live vendor API, synthetic — proves tool-calling, policy, **recovery**" | policy is proved against scripted and recorded providers, and **recovery is now proved** against them too (crash-and-resume at every step, exactly one effect per call). Slice 5 adds the live adapter and proves **the live path's contract** with `fetch` mocked: the vendor envelope maps onto one schema-valid catalog call, the demo guard refuses before any request, a 429 moves to the backup and then to the keyword parser, and the approval tiers decide identically through the live adapter and the fake (`live-approval-tiers.test.ts`). What is still unproven is the part no test can stand in for — tool-calling against the **real** endpoint, with a real key, and recovery across a real vendor failure — and that gap now has a slice rather than a wish: the **real-endpoint smoke test** is **slice 7**'s, ledger row 67 | Partial |

---

## What the queue slice did **not** bring

The lease is done and so is the route; these four are the queue slice's own honest remainder, each
with the slice or milestone that owns it. None of them is a half-built mechanism — each is a
*caller*, a *source*, or a hand-off that another module's rule puts somewhere else. The last two —
the timer → queue hand-off and the agent-side sweeper — are **B-08 slice 7**'s, by the founder's
2026-10-16 decision (ledger row 67).

| Not built in the queue slice | Why, and where it lands |
|---|---|
| The production **context assembler** — so `/api/queues/agent` acks every delivery instead of driving a run (`run/deps.ts` `agentRunner()`, named reason in the log) | Four of `RunDeps`' five parts exist; `assemble` needs `TierFacts` from the tier sources (B-02's approved profile, B-07's tokenizer, B-04's threads) and a `PolicyContext` whose scope comes from the session the trigger arrived on — **VERI-3**, the §11.1 "Run scope" and tier rows above, all already Partial. A standin is worse than no runner: a scope this process invented for itself is the one cross-tenant write the family-scope post-validator cannot see, a guessed `sendableSubjects` is a consent decision nobody made, and a guessed `paused` is the kill switch answered by the runtime instead of by a person. Fail shut, by name, as everywhere else in this module. When the sources land, `agentRunner()` returns deps and the route does not change |
| The **publishers**: nothing calls `enqueueRun`, so topic `ppec-agent` is empty in production | The five §11.1 trigger callers, which is the first row of the §11.1 table and has not moved: the B-04 inbound webhook, the operational-rules handoff, the 5-minute overdue sweep and the hourly/EOD reconciliation each belong to their own milestone. `enqueueRun` is the seam each of them calls, and it is tested end to end against the consumer |
| The **timer → queue hand-off**: when an await deadline fires, `agentResumeHandler` moves the run WAITING_TOOL → QUEUED and publishes nothing, so nothing delivers it | **Sequenced to B-08 slice 7** (founder decision, 2026-10-16, ledger row 67), with the sweeper below. Not building it in the queue slice was ADR-001/ADR-003's rule rather than an omission: a B-03 handler is DB-only and runs inside the job's claim transaction with no after-commit hook to publish from (`Handler`, `jobs/runner.ts`) — the same reason every message goes through the outbox instead of being sent from a handler. The handler's job is to make the run *drivable*; delivering a QUEUED run is the sweeper's, in the row below. Which of the two ways slice 7 closes it is still open and is ours to pick: the sweeper delivers QUEUED runs, or B-03 handlers get an after-commit seam — and that second one is a change to B-03, not to B-08 |
| An **agent-side sweeper**: a run left QUEUED — by a fired deadline, by a publish that failed, or RUNNING by a driver whose redeliveries ran out at MAX_DELIVERIES — is not picked up by anything on a schedule | **Sequenced to B-08 slice 7** (founder decision, 2026-10-16, ledger row 67), together with the hand-off above, because the two are halves of one gap: one makes runs QUEUED, the other is what would deliver them. B-03's every-minute sweep covers `ops.job`, not `ops.agent_run`, and the recovery that *is* built is the queue's: a redelivery after the visibility timeout reclaims an expired claim — which only helps a run that was published at least once. A failed publish throws so the caller's own retry re-publishes onto the same (idempotent) run, which is the honest answer for the callers that exist — none. A periodic sweep over `agent_run_resume_idx` (which 0007 added for exactly this) is the shape. This **replaces its earlier placement in the live-provider slice**, which reasoned that a run able to spend money is the first worth re-driving on a schedule: that is the wrong coupling — the live call needs no sweep, and the recovery of a run nobody delivers should not wait on the slice that leaves the building. The earlier wording also read as slice 5, and slice 5 has landed without it, so that sequencing was wrong the moment it shipped. Slice 6 is the dispatcher link page and its signer (ledger row 64), which is why the number is **7** — and like row 64 it is a team placement under the founder's row-63 rule that every open item names its slice |

---

## What the live-provider slice does **not** bring

The live vendor call is the live-provider slice's (slice 5, merged — PR #42): a real HTTP body, the key read by env var name only, `allow_fallbacks:false` and
`require_parameters:true` on every request, a request timeout, and a primary → backup model → §18.1
keyword-parser chain. Three things it does **not** bring are **B-08 slice 7**'s, by the founder's
2026-10-16 10:25 ET ruling (ledger row 67) on the same rule as the sweeper above: the founder fixes
that an open item sits in a *named* slice landing before B-08 closes, and the naming is ours. They
sit beside the sweeper because slice 7 is the slice that makes a run be re-driven on a schedule and
retried past one attempt — counting what those drives spend belongs to that change, not after it.

| Not brought by the live-provider slice | Why, and where it lands |
|---|---|
| **Token and cost accounting** — the vendor's usage numbers are never read, so `ops.agent_run.tokens_in/out` stay NULL and no run can be priced | **Sequenced to B-08 slice 7** (ledger row 67), and it is the one item on this page that is a **gate rather than an ordering**: it must land **before any paid model id is configured**. While the configured model is the free OpenRouter tool-calling one (ledger row 56) on demo data only, an unpriced run costs nothing and this is an observability gap — the per-site/day budget and ADR-000 #11's spend alert have nothing to count. The moment a paid model is named in config (Sonnet via OpenRouter, `zdr:true` — ledger rows 14, 56; ADR-000 #4/#12) it is a spend-control gap instead, and an agent the sweeper can put back on the queue and the retries can drive again is exactly the thing that must not spend money uncounted. So inside slice 7 the accounting lands first — before the retries widen, and before any paid model id goes in. The gate holds wherever that switch is flipped; it is not a licence to flip it as soon as the accounting exists, and it re-decides nothing about the model choice, which rows 14 and 56 and ADR-000 #4/#12 still own |
| **Retries beyond the single backup model** — one backup attempt, no backoff, so a 429 or a 5xx on both models degrades straight to the §18.1 keyword parser | **Sequenced to B-08 slice 7** (ledger row 67). Degrading is a *safe* failure, not a recovered one: the run keeps going without the model rather than waiting for it, which is the right default and a poor substitute for a retry a transient rate limit would have survived. It lands with the sweeper for the same reason the sweeper lands at all — re-driving a run that nothing delivered and re-trying a call that one vendor hiccup lost are the same recovery story — and it lands **after** the accounting above, because a wider retry budget is more vendor calls |
| The **real-endpoint smoke test** — one call to the **real** endpoint with a real key, and recovery across a real vendor failure | **Sequenced to B-08 slice 7** (ledger row 67). Slice 5 proves the live path's *contract* with `fetch` mocked: the vendor envelope maps onto one schema-valid catalog call, the demo guard refuses before any request, a 429 moves to the backup and then to the keyword parser, and the approval tiers decide identically through the live adapter and the fake. What no mock stands in for is the endpoint itself — §18.4's LLM row ("Live vendor API, synthetic — proves tool-calling, policy, **recovery**") is satisfied by none of the above, and the §18.4 row in this page's table says so. It is a smoke test and nothing more: one real call on synthetic demo data, enough to prove the envelope, the key path and one real failure, not a soak |

Nothing in this section is built, and naming slice 7 changed no behaviour: the configured model, the
single backup attempt and the NULL token columns are exactly as the live-provider slice leaves them.

---

## The PR #35 review (Veri), and where each finding stands

Veri reviewed the slice-2 PR. Four findings were about slice 3's own surface and were fixed on that
branch; **F2 is now fixed too, by the queue slice it was sequenced to**; the remaining two rows
belong to work no slice of B-08 owns yet. They are listed with the slice that must land them rather
than closed, so "not in the diff" is not read as "not a problem" — and none of them is *deferred*:
each is a condition of B-08 closing.

| # | What it was about | Where it stands |
|---|---|---|
| F1 | a resumed PENDING ALLOW row could outrun a decision taken during the outage — pause the agent or withdraw consent while a send is persisted-but-not-executed, and the next driver would send it anyway | **Fixed** (`run/loop.ts` `tightenOnResume`, `exec/resume-tighten.test.ts`). A resume re-decides its step against the current context and takes the stricter verdict: ALLOW may become PROPOSAL or BLOCK, a BLOCK is never loosened. The other two effect-time halves were already true and are now pinned — the outbox's per-contact egress re-check at send time, and `transition()` guarded on the version the model was given |
| F3 | the site fence: a run id travels on a job payload or an HTTP route, and nothing downstream of it asked whose tenant it was | **Fixed** (`run/timers.ts` `AND site_id = $3`; `driveRun(runId, { siteId })`; `scope.siteToken` checked against the run's site before the model turn and before a resumed step settles) |
| F7 | the free-text phrase detector had no tests of its own — it was reached only through `evaluate`, on three examples | **Fixed** (`policy.freeTextShape` exported; `policy.test.ts`, both directions plus the bound it honestly has) |
| F10 | staff-visible task copy still written inline in two places | **Fixed** (`agentWaits`, `timerDeadTask` and the shared `agentTaskLocator` in `src/ui/copy.ts`) |
| F2 | **no per-run lease.** Two drivers on one run were bounded by the `(run_id, seq)` unique index and the per-call idempotency key, not by a claim, so the worst case was wasted model turns rather than duplicated effects — but it *was* a worst case, and `driveRun` said so in its own docstring rather than pretending | **Fixed in the queue slice** (`run/lease.ts`, `run/queue.ts`, `/api/queues/agent`; `lease.test.ts`). `driveRunLeased` claims the run, hands the claim token to the loop as `DriveOpts.actor` and releases it; a second driver is refused `leased` before it takes a turn, an expired claim is reclaimed, the claim is released on park / success / failure, and the loop re-checks the holder before every turn so a driver that was reclaimed mid-drive stops instead of spending another turn. Site-fenced at the claim, the release and the drive. **No schema change**: `state` + `version` + the `updated_by` holder slot, whose token carries the claim's instant. The residual is named in the module: a driver that is alive but wedged *past* the lease can be reclaimed, and in that window the pre-lease bounds are still what keep effects once — which is the same statement B-03 makes about its own 2 s lease |
| F4 | **the 0007 backfill stopped at `idempotency_key`.** `status` was added with `DEFAULT 'PENDING'`, so every row 0007 found was labelled PENDING — including rows that had already finished, which `committed_at IS NOT NULL` records. That is not a cosmetic wrong value: `pendingCall()` reads exactly that predicate to decide a run has an interrupted step, and `committedCalls()` filters PENDING rows *out* of the resume cursor, so a mislabelled row would be re-driven and would be missing from the facts the next model turn is given | **Fixed in `drizzle/0008_agent_status_backfill_type_owner.sql`.** The backfill reads the status back off the row's own result, which the loop writes self-describing: `error_code` present ⇒ FAILED (`exec/effects.ts` `failed()` always sets a code, as do the loop's NO_EXECUTOR and EXECUTOR_ERROR commits), otherwise EXECUTED — a successful result may legitimately be NULL. Rows carrying `blocked_rule` or `proposal_rule` are **excluded rather than guessed at**: those are BLOCKED and PROPOSED commits, and calling either EXECUTED would overwrite a policy outcome with a false one. Such a row cannot need the backfill — only the slice that added `status` writes those markers — and the exclusion keeps that true instead of assumed. Proven on a seeded fixture of all seven shapes, which starts PENDING across the board (the defect, as a test) and then has to land on each expected status (`src/db/migrations.test.ts`) |
| F6 | **the type 0007 created is not owned by `migrator`.** 0001 hands `migrator` the schemas, the tables and the enum types — but its enum loop runs over a *hard-coded* list of the 24 names 0000 created, so `agent_tool_call_status`, created three migrations later, kept whichever role ran 0007 as its owner (on PGlite, `postgres`). ADR-009 / B-02 is that `migrator` owns every object in the schema — the "Tokos lesson" 0001 names — and ownership is what decides who may later ALTER or DROP the type | **Fixed in the same file:** `ALTER TYPE public.agent_tool_call_status OWNER TO migrator`, in 0001's loop shape so an absent type is skipped and a re-run is a no-op. The test is two assertions, and the second is the durable one: no `public` enum is owned by anyone but `migrator`, which fails on the *next* migration that adds a type and forgets its own ALTER TYPE, since 0001's list will not cover that one either |
| F4/F6 — the sequencing | what both rows used to say: "**migration 0008, once the founder has swapped the Neon snapshot** — that is when it can be verified against real rows instead of against PGlite alone" | **Retired, not satisfied.** DECISION-LEDGER #66 (founder, 2026-10-16 10:24 ET) drops the pre-migration snapshot step while the one database holds demo data only; Neon's 6-hour restore window is the fallback. So there is no snapshot to swap, and 0008 does not get verification against real rows: it is verified against seeded PGlite rows in `src/db/migrations.test.ts` and **has never been applied to any database**. Worth saying because it is the weaker claim — the F4 fixture is rows a test wrote, not rows the loop left behind. It is also the honest one for this migration: nothing wrote `ops.agent_tool_call` before slice 2, so on the one database the backfill is expected to touch zero rows, and the fixture is the only place its logic is exercised at all |
| F9 | **no approval surface.** The rows a human would decide from exist (`ops.change_request`, `ops.approval_request`, both carrying `approval_key` = the call's `args_hash`), and nothing produces a *decision*: `ctx.approvedCalls` is empty everywhere but in tests | **Open — sequenced to B-12**, which owns both the approval screen and the Teams card beside it. Nothing in the catalog as it stands needs one — no tool declares free-text copy, so no send is held behind an approval — which is why this is a missing surface rather than a broken path. It is the §11.2 "Human approval itself" row above |

---

## What slices 1–4 and the queue slice claim

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

One refusal is claimed as narrowly as the effects: `close_task` on a task that is still OPEN says
so — `TASK_NOT_CLOSABLE_OPEN`, a sentence for staff, and a row that is bit-for-bit the one it read
— rather than returning a quiet "not closed" that looks the same as an evidence miss. That is a
refusal and not a capability: §6.3 gained no edge.

Two more things, from the PR #35 review and claimed as narrowly as the rest: a step that was allowed
when it was written down and whose process then died is re-decided before it runs, so a pause, a
consent withdrawal or a staff edit that landed in between refuses it — and never the other way
round, because a refusal is not re-litigated by a more agreeable context. And a run id is not an
authorization: the timer handler, the driver and the assembled scope each have to be about the same
site, or nothing happens.

Slice 4 adds only this. A therapist whose session really does overlap the day the agent changed is
told once, in a template id and a clock time, and the ten minutes are a row and two jobs rather
than a promise. A provider is asked about a vehicle only when the route is ninety minutes out or
the van was swapped, and asked through a hashed single-use link — or, with no signer configured,
told plainly in the record that the link is an intent and not a URL. Their answer is recorded only
if it came from *their own* contact point, only as REPORTED, and with a staff review beside it when
we are not sure we read it right. A boarding is reported on evidence that is checked: one
authorized child for a guardian's reply, a vehicle that is demonstrably standing still for a
driver's tap. A thread summary is a staff row and nothing else — no message, and not closable by
the agent that wrote it. A guardian send now reaches more than one parent where more than one
parent is entitled to it, one message each, and still refuses to pick between two of them when
nobody asked. A dispatcher can be messaged, and a dispatcher who has texted STOP cannot. And every
wait has a second deadline behind it that raises the exception with no model in the path, exactly
once, and nothing at all when the answer arrived — because the run that would have decided is the
part that may not happen.

The queue slice adds only this. A run is delivered rather than driven by whoever happened to
receive the trigger: one trigger makes one run and one wake-up, however many times either is
delivered, and the thing that drives it is a queue consumer with a **claim** in front of it. Two
drivers on one run no longer both drive it — the second is refused before it takes a model turn, by
name, and the loop stops the moment the row it is driving stops being stamped with its own claim.
A claim that has run out is reclaimable, and one that has not is not. A claim is released when the
drive ends — on a park, a success or a failure — so the next delivery waits for nothing it does not
have to. None of it crosses a tenant: the site is on the payload, the claim is fenced on it, and a
run belonging to anyone else is refused without being read into. And none of it needed a column:
the lease is the run row's own `state`, `version` and `updated_by`, so migration 0007 is still
frozen and 0008 is still empty.

What the queue slice does **not** claim is that any of this runs in production: nothing publishes to
the topic, and the consumer acks rather than drives, because the §11.1 context assembler is not
built. Both are named in "What the queue slice did not bring" above, and the route's own refusal
says so in the log rather than in a comment.

Everything else on this page is later work in a **named** slice — migration `0008`, B-12, **slice 7**
(the agent-side sweeper, the timer → queue hand-off, and the live-provider slice's three remainders —
token and cost accounting, retries beyond the single backup model, and the real-endpoint smoke test;
founder decision 2026-10-16 10:25 ET, ledger row 67) or the live-provider slice — and none of it is
implied by the tests in these five slices.
