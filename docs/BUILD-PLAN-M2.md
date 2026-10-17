# PPEC transport dashboard — build plan P-01…P-12 (to AT-01…18 PASS (mock))

**Status: Proposed (Rudy), for founder review.** This replaces the M2–M9 plan written 2026-10-14
in full: that plan was cut to a same-day finish ("the build finishes TODAY", founder 14:46 ET), its
milestone names M2…M9 never matched how the work was actually built, and every ETA in it is spent.
Nothing from it is carried forward silently — the founder answers it recorded are in
DECISION-LEDGER rows 44–52 and stand on their own, and §6 below names everything these steps do
*not* cover. The file keeps its name so existing links resolve. Re-cut 2026-10-16 against `main`
at **80e2ea5**.

```
READER: founder, Firia, Veri, Vera, Rudy. DECISION IT SERVES: the order of the remaining build
steps, what each one closes, and where every acceptance test stands today.
SOURCES: the code on main at 80e2ea5 and its tests; docs/BUILD-PLAN.md (B-01…B-16, the AT map);
docs/agent/B08-SLICE1-DEFERRED.md (B-08's own per-item and per-AT status); docs/ui/B12-SLICE1-DEFERRED.md
(B-12's slices); docs/ARCHITECTURE.md §7 (the TEST-INF-01 drill) and §6; docs/MOCKS-AND-DEMO.md §4–§6;
docs/LINEAR.md (PASS rules, §18.2 evidence, Linear ids); DECISION-LEDGER rows 44–52, 60, 63, 64, 66,
67, 68, 69; PRD v1.0 §14, §18, §20 (repo copy docs/PRD-v1.0.txt).
```

## 0. How the steps are named

- Steps are **P-01…P-12**. A step is the unit of work that opens a PR (or a run, for the restart
  drill) and the unit Veri gates.
- The word **slice** is reserved for a **B-item's own parts** — "B-12 slice 2", "B-08 slice 7" —
  because that is what the founder approved and what DECISION-LEDGER rows 63/64/67 rule on. A step
  in this plan is a *step*; it is never called a slice, even when it carries exactly one.
- **No ETAs.** The old plan's dates are gone rather than rolled forward; new dates are the
  founder's to set. Order below is a dependency order, not a calendar.
- **P-01…P-04 are B-12's four slices, in order.** The instruction that set this plan named the
  inbox/Exceptions step **P-04**, which fixes B-12 slice 2 (Plan routes) at P-02 and slice 3 (the
  live map) at P-03, and so slice 1 — already merged — at P-01. P-01 is in the table for the
  baseline, not because anything is left in it.
- Status words, used the same way in §2 and §4: **PASS (mock)** = the behaviour is built and held
  by landed tests on mocks (ADR-016, ledger row 12) and needs only Veri's §18.2 evidence package;
  **Partial** = some halves landed, the missing ones named; **Not started** = nothing on `main`;
  **PASS** = a non-mock pass, which nothing in this POC reaches. **Only Veri marks an AT PASS**, on
  evidence (docs/LINEAR.md §PASS rules) — §4's statuses are the code-and-tests state, not a verdict.

## 1. Where we are (`main` at 80e2ea5, 2026-10-16)

- **Merged:** B-01 repo/CI/Vercel+Neon; B-02 schema + machines (migration 0000, and 0008 via #45);
  B-03 timers + outbox + sweep (whole-second delays and the inline lease re-check, ledger row 60);
  B-04 SIM messaging, persona-phone API, consent ledger; B-07 *phone tokenization only*
  (`src/modules/identity/phone.ts`); **B-08 slices 1–5** incl. the queue slice, the live OpenRouter
  adapter on a free model behind the demo-data guard (rows 67–68, #42/#48) and the row-65 staff-task
  fix (#44); B-09 the capacity solver (`src/domain/solver/`); B-10/B-11 GPS simulator, LocationIngest,
  ADR-007 routes, ETA with hysteresis, the map pane at `/live-map`; B-13's ramp iPad at
  `/ramp-ipad`; B-12 **slice 1** — the Today board and the child drawer (#46); B-15's seed and
  `demo reset` (`src/modules/demo/`, `/api/demo/reset`); B-16's minimal Auth.js login + the access table.
- **In flight:** **B-12 slice 2 — Plan routes** on `team/ppe-plan-routes` (dd5f825): the lanes
  screen at `/plan-routes`, the planner (`src/domain/solver/plan.ts`), 25 planner cases, 22 screen
  contracts, six browser checks incl. AT-04, AT-05, AT-12 and TEST-SEC-02. **Not merged**, so §4
  does not count it. B-08 **slice 6** (the dispatcher link page and its signer, ledger row 64) is
  named and not built.
- **Placeholders, not surfaces:** `/exceptions`, `/health`, `/setup` each render `Placeholder` and
  say so (B-12 slice 4, B-14, B-13's setup screens).
- **Nothing at all yet:** B-05 (no group-MMS fixture), B-06 (`ops.teams_activity` is a table with no
  surface), B-07's importer (no CSV path anywhere in `src/`), B-14 (EOD exists only as a timer-kind
  comment), B-15's demo panel, and **no SSE anywhere** (`EventSource` / `text/event-stream` appear in
  no route).
- **No AT is PASS.** Veri has signed none; §4 is the state of the code.
- **Linear:** ids are in docs/LINEAR.md. Their statuses are **unverified** from here (no Linear read
  in this pass); the 2026-10-14 read found all 45 PPE issues in Backlog, including merged work.

## 2. The steps

| Step | What it is | Closes (ATs) | Depends on | State |
|---|---|---|---|---|
| **P-01** | **B-12 slice 1** — the Today board (SURF-01) and the child drawer (SURF-02), read-only over the seeded day | AT-07 and AT-10 **UI halves** | B-03, the seed | **landed** (#46) |
| **P-02** | **B-12 slice 2** — **Plan routes** (`/plan-routes`): one lane per van, places needed against places free, children as stops in driving order, the children no van fits named with one reason each, and the §9 options *listed* rather than decided. Plus the items the B-12 page already owed slice 2: the AT-13 `HELD_NO_RECEIVER` ride in the scenario, the mutation-proven AT-10 e2e, the ADR-007 routes regenerated against the scenario (AM **and** PM), "Time not set yet" for a genuinely unknown window, a named approver and verifier in the seed, the disabled Override that looks disabled with its own one-line reason from `copy.ts`, and the drawer's timeline rows and date switcher | AT-04, AT-05, AT-12; finishes AT-10's and AT-13's screen halves | B-09, P-01 | **in flight** (dd5f825) |
| **P-03** | **B-12 slice 3** — **live updates and the live map**: SSE (ADR-002), the reconnect delta, the amber "paused" bar past 15 s, header adapter pills showing real ages, and the map pane beside the board rows with row-hover ↔ marker highlight and fly-to. The pane and the deterministic replays exist at `/live-map` with a client clock; this step puts them on the real surface over real data | AT-03, AT-11 | P-02, B-10/B-11 | sequenced |
| **P-04** | **B-12 slice 4** — **Inbox (SURF-03), Exceptions & Approvals (SURF-05) and the board's writes**: confirm handoff, Override with reason end to end, snooze, approve; the 412 conflict toast and merge view; the approval *decision* screen over `ops.change_request` / `ops.approval_request` (B-08's F9, ledger row 63); **provider/vehicle/AM-PM filter chips with counts**; and **real drawer history** with the pending-approval and agent-change rows the Exceptions work produces. The chips and the drawer history move here from the B-12 page's slice-2 list, because the rows they display come from this step's surfaces — the B-12 page is re-cut with slice 4 when this step opens | AT-08 | P-02, B-08 slices 3–4 | sequenced |
| **P-05** | **B-08 slice 7** — the agent-side sweeper over `agent_run_resume_idx`, the **timer → queue hand-off** (ledger row 67), **token and cost accounting** (a **gate**: it lands before any paid model id goes into config), **retries past the single backup attempt**, and the **real-endpoint smoke test**. It also has to carry the two things B-08's own page still leaves to "their own milestone" and no other step can own: the **inbound-webhook publisher** (nothing calls `startAndDriveRun`, so an arriving SMS starts no run) and the **production context assembler** (`run/deps.ts`, so `/api/queues/agent` acks instead of driving). Naming them here is a team placement under row 63's rule, not a new founder decision | AT-01, AT-09 | B-08 slices 5–6, P-04 for the approval surface | sequenced |
| **P-06** | **B-05 group-MMS fixture + the parent phone screen** — the mock group-thread fixture (B-05 is mock-only, ledger row 51; EXP-GRP-01 stays open for post-POC) and the persona-phone surface the demo types into: F1–F8 phone panels over the existing `/api/sim/phones/[number]/messages` route, outbound QUEUED→SENT→DELIVERED, inbound posting to `/api/webhooks/sms`, and the §4 faults (delivery failure, delayed delivery, duplicate and out-of-order inbound) | — (carries demo steps 2, 9, 10) | B-04, P-05 for a reply with an agent behind it | sequenced |
| **P-07** | **B-06 Teams mock** — the per-role Teams side panel, adaptive-card-like approval cards over `ops.teams_activity`, the proactive therapist card, and the **two-approver race**: two browser sessions both click Approve, one wins, the loser gets 409 | AT-14, AT-18 | B-03, P-04's approval surface | sequenced |
| **P-08** | **B-07 CSV import** — the importer and the identity rules behind it: an import with no name and no DOB does not merge two children, and the ID-swap matrix (BUILD-PLAN §4) holds for every route it adds | AT-17 | B-07, B-02 | sequenced |
| **P-09** | **B-14 ROI, health and the end-of-day close** — metrics with drill-down and the SYNTHETIC watermark (SURF-07), the adapter health panel (SURF-06), and the EOD close that is **blocked while custody states are open** (OPS-01). `/health` stops being a placeholder | AT-15, AT-16 | P-04 | sequenced |
| **P-10** | **TEST-SEC-01 / TEST-SEC-02** — the prompt-payload proof against the real identity vault rather than the fixture roster (TEST-SEC-01), and the egress proof with the allow-list itself in place: zero `*.googleapis.com`, zero tokens in routing payloads, one configured vendor host (TEST-SEC-02) | TEST-SEC-01, TEST-SEC-02 | P-05, P-08 | sequenced |
| **P-11** | **B-15** — the **demo panel** (Reset, Clock, Replay, Faults, Evidence export; MOCKS-AND-DEMO §6, DIRECTOR + `DEMO_MODE=1`, ADR-014), the **full AT suite** run by Veri over AT-01…18 on one release SHA, the **evidence export** (test log, DB diffs, message-status table, timer log from `job_fire_log`, agent transcripts, Teams activity ids), and the **runbook** (reset, replay, faults, restart drill, recovery), dry-run by Veri | every AT's formal PASS (mock) | P-02…P-10 | sequenced |
| **P-12** | **Package the signed evidence only** — assemble the POC exit package from what P-11 produced and get it signed (Veri as operator, then the founder). No new behaviour in this step: if something has to be built here, it belongs to an earlier step and that step is not done | — | P-11 | sequenced |

Veri gates every step and Vera gates every step with a surface in it. The §18.2 evidence rules and
"only Veri marks PASS" are docs/LINEAR.md's and are unchanged.

**P-11 inherits the Plan routes demo scenario toggle.** `/plan-routes` carries its own two-button
toggle — "Normal day" / "A child can’t be placed" — because the §9 walk needs both halves of the
AT-12 story and the demo panel it belongs in does not exist yet (B-15 is "nothing at all yet", §1).
It is a demo control, not a coordinator's: it is rendered in the DEMO bar's own violet so it reads as
one (Vera's review, 2026-10-17), the screen still replays the one demo day either way, and nothing
in the product reads it. **When P-11 builds the demo panel, the toggle moves into it** — one place
where a demo is steered, beside Reset, Clock, Replay and Faults — and the screen is left with its
own controls only. P-11 is not blocked by it and does not need to keep it where it is.

## 3. TEST-INF-01 — three restart runs on production, on separate days

The drill itself is ARCHITECTURE §7: 50 jobs, 5 cancelled, crashes A–D (consumer mid-claim,
redeploy, Neon compute restart, lost wake-up), then `ops.job` + `job_fire_log` collected —
45 DONE, 5 CANCELED, zero duplicates, p100 lateness ≤5 s for steps 1–4. Three runs, **on separate
days**, on the production deployment against the one database.

- **Run 1 goes as soon as the live map lands — i.e. straight after P-03 — and Firia gets a
  heads-up first.** It is a production drill: it crashes consumers, promotes a deployment and
  restarts the Neon compute, so nobody else should be mid-demo on it.
- **Runs 2 and 3 go alongside the later steps** (P-05…P-09 as they land), one per day, on separate
  days by the test's own design. This is the test's schedule, not a deferral.
- **Log the commit SHA for every run**, with the deployment id, the run id (`test-inf-01-<date>`),
  the Vercel and Neon regions and the Queues status page.
- **A run counts only for the code it ran on.** If a later step changes the **timers**, the
  **queue** or the **restart path**, every earlier run is **void** and the three runs start over on
  the new code. P-05 is the step most likely to do exactly that — the timer → queue hand-off and
  the agent sweeper are a change to how a fired deadline gets delivered — so expect run 1 to be
  re-run after it rather than treating it as banked.
- **What run 1 needs built first:** `scripts/test-inf-01/` holds only `delay-accuracy.ts` today, so
  the §7 step 1–7 drill script and its fault flag are part of run 1's own preparation. `job_fire_log`
  already exists. The §7 evidence package also names a screen recording of the demo panel's
  "Restart drill" button — that panel is P-11's, so runs before it are evidenced from the script and
  the SQL, and the recording is taken on the final counted run.
- The ≤5 s bar has **never been measured**: the 4.95 s worst case in ledger row 60 is SIMULATED
  (fake clock, in-memory transport, PGlite) and assumes ≤1 s delivery jitter. Whether a Neon compute
  restart is triggerable on our plan tier is **unverified** (ARCHITECTURE §7). A FAIL restarts the
  count and, per the old plan's risk 1, points at ledger row 22 (QStash), which needs founder sign-off.

## 4. AT-01…AT-18 and TEST-INF-01: closing step and current status

Derived from the code, the tests and the docs/ledger on `main` at **80e2ea5**. "Closing step" is the
step that lands the last missing piece; the formal PASS (mock) for every row is Veri's at **P-11**,
signed at **P-12**. Work on `team/ppe-plan-routes` (dd5f825) is **not** counted — it is not merged.

| AT | Closing step | Status | What holds it up today, on main |
|---|---|---|---|
| AT-01 message→state→notify | **P-05** | Partial | Built and tested end to end *inside* the agent (`exec/followup.test.ts`), with the real outbox behind it. The trigger is the gap: nothing calls `startAndDriveRun` from the inbound webhook (`/api/webhooks/sms` passes no hook) and production has no context assembler, so an arriving SMS starts no run |
| AT-02 timer follow-up + escalation | closed on main (B-08 slice 4); **P-05** for the live path | PASS (mock) | `exec/clarify.test.ts`, `exec/escalate.test.ts`: the follow-up goes through the outbox, becomes a task + a B-03 timer, and a second deadline escalates deterministically, exactly once, with no model in the path. In a deployment the *resume* still waits on P-05's timer → queue hand-off (ledger row 67) |
| AT-03 traffic delay, hysteresis, replay | **P-03** | Partial | Domain is built and held: `domain/eta/replay.test.ts` (stall moves one window for downstream families only, injected traffic band, jitter moves the marker not the text, deterministic replay), the notify gate's hysteresis, `fixtures/replays.ts`. What is missing is the surface: the map and the replays live on `/live-map` with a client-side clock and no SSE, and B-12 names AT-03 as slice 3's |
| AT-04 unknown equipment at arrival | **P-02** | Partial | Solver side proved (`solver.test.ts`: a chair measured bigger at the ramp does not fit); agent side has the RED exception + `ops.approval_request` with no mutation (B-08 slices 3–4, Partial); the ramp iPad exists at `/ramp-ipad`. The coordinator's screen that shows the run going infeasible **before** boarding is P-02, in flight and unmerged |
| AT-05 substitution | **P-02** | Partial | `solver.test.ts` substitution cases on main + the scenario's spare van (`seed.test.ts`); the substitution chain on screen (lane goes unknown, provider asked again, lane re-solves) is P-02, in flight and unmerged |
| AT-06 sibling ambiguity | closed on main (B-08 slice 3) | PASS (mock) | `exec/reads.test.ts`, `exec/clarify.test.ts`, `exec/cancel.test.ts`: two candidates at half confidence, no leg named, one fixed-copy question, nothing mutated, and a cancel attempted anyway refused `AMBIGUOUS_SENDER`. `seed.test.ts` holds F4's one phone for two children |
| AT-07 leg vs full-day absence | closed on main (B-08 slice 3 + P-01) | PASS (mock) | Agent half `exec/cancel.test.ts` (AM/PM leaves attendance, FULL_DAY cascades both legs, each on its own machine and version); **UI half PASS (mock) via #46** — one child's one ride is one row, `board.test.ts` and `today-board.test.ts`; machine edges in `machines.test.ts` |
| AT-08 manual correction invalidates queued msg | **P-04** | Partial | The version half is done (`exec/cancel.test.ts`: `VERSION_CONFLICT` / 412 / `canceled_stale`, and a queued message about a bumped `plan_version` goes CANCELED_STALE at send). The **manual** correction needs a console write, and the board is read-only until B-12 slice 4, which is also where the 412 conflict view lands |
| AT-09 wrong recipient / injection | **P-05** | Partial | **Partial after #44.** 45 red-team fixtures plus VERI-2/VERI-4 through the real gateway and the real policy engine with an empty send sink, a real `ops.outbound_message` behind every send (BLOCKED_EGRESS / CANCELED_STALE visible), and #44 added the audiences that are not families (opted-out dispatcher blocked at egress; one opted-out guardian of two refused while the other is sent). Still no **live inbound traffic** — the same missing caller as AT-01 |
| AT-10 geofence ≠ handoff | **P-02** | PASS (mock) | `geofence.test.ts` (ARRIVED_* only, never COMPLETED_HANDOFF), `board.test.ts`, `replay.test.ts`, and the board never prints "Handed off" for a van that merely arrived; **UI half PASS (mock) via #46**. One weakness, named on the B-12 page and owned by P-02: the e2e line is a negative that would also pass on a board rendering nothing, and its mutation-proven rewrite has not landed |
| AT-11 duplicate/out-of-order + loss | **P-03** | Partial | `location/ingest.test.ts` (dedupe on `(device_id, recorded_at)`, out-of-order points) and `replay.test.ts` (180 s stale, 600 s exception) hold the domain. The stale badge and the suppressed ETA text on the real surface are slice 3's; B-12 names AT-11 there |
| AT-12 no feasible vehicle | **P-02** | Partial | `solver.test.ts` gives the infeasible verdict on main (`domain/solver/` there is the solver and `feasible()`; the planner `plan.ts`, its 25 cases and the AT-12 copy test are on the branch, not main). The screen that names the child, the reason and "No family has been told anything. Staff choose first." is P-02, in flight and unmerged |
| AT-13 no receiving adult | **P-02** | Partial | `machines.test.ts` (HELD_NO_RECEIVER exits by staff only, no automatic return), `board.test.ts` + `today-board.test.ts` (the board asks for the receiving adult first), `seed.test.ts` (F2 has no authorized receiving adult). The gap is the fixture: no `HELD_NO_RECEIVER` **ride** is in the scenario, so the one state AT-13 exists for is never on screen — slice 2 seeds it |
| AT-14 therapist ≤10 min + ack | **P-07** | Partial | Agent/outbox half done (B-08 slice 4): `exec/therapist.test.ts`, `exec/escalate.test.ts`, and the outbox's AT-14 egress re-check (a session reassigned after enqueue goes BLOCKED_EGRESS). The session moves to THERAPIST_NOTIFIED, the ack is a PENDING row on a ten-minute deadline that escalates on expiry. What is missing is Teams: `ops.teams_activity` is a table with no surface, so there is no card and no activity id |
| AT-15 ROI drill-down | **P-09** | Not started | `/health` renders `Placeholder`; there is no metrics or ROI module on main |
| AT-16 EOD blocks close | **P-09** | Not started | "EOD" appears only as a timer-kind comment in `jobs/handlers.ts` and a reconciliation trigger id; there is no close path to block |
| AT-17 import without name/DOB merge | **P-08** | Not started | No importer anywhere in `src/` (no CSV path at all). B-07 on main is phone tokenization only (`modules/identity/phone.ts`) |
| AT-18 Teams proactive + card + race | **P-07** | Not started | No Teams panel, route or card renderer; the 409 race has no surface to race on. The only AT-18 reference in code is a copy rule (`ui/no-internals.test.ts`) |
| TEST-INF-01 restart drill | **run 1 after P-03**; runs 2 and 3 alongside P-05…P-09; counted on the final code (§3) | Not started | No run on a deployment. The §7 step 1–7 drill script is not written (`scripts/test-inf-01/` holds only `delay-accuracy.ts`), though `job_fire_log` and the guarded claim are in place. The ≤5 s worst case (4.95 s, ledger row 60) is SIMULATED, and the Neon-restart step is unverified on our plan tier |

AT-04, AT-05, AT-10, AT-12 and AT-13 move the moment P-02 merges; they are counted here as `main`
has them. TEST-SEC-01 and TEST-SEC-02 are not rows above (this table is AT-01…AT-18 plus
TEST-INF-01): both are **Partial** on main — TEST-SEC-01 proved against the fixture roster rather
than the identity vault, TEST-SEC-02 narrowed to "one file may `fetch`, one file may hold a URL"
with the egress allow-list itself still unbuilt — and both close at **P-10**.

## 5. Security hardening is paused until the build steps are done

DECISION-LEDGER **row 69** (founder, 2026-10-16 12:14 ET): until the build steps have landed,
**hardening findings are logged, not merge-blocking** — written down against that row and sequenced
after the steps. In this plan that means hardening starts after **P-12**, and no row 69 item is a
reason to hold P-01…P-12.

The row draws its line at hardening only: **S0/S1 functional defects still block**, and so does
anything that is a working-code defect wearing a security label — a guard that does not guard, a
refusal that does not refuse, a live leak. Deferred by name in the row, so none of it is lost: MFA;
account lockout; field-level encryption; the database role production connects as (`neondb_owner`
today, which must become a least-privilege role **before any real data**, a condition of that switch
and not a tidy-up); and Veri's #43 S3 test-hardening items.

Row 69 says "all **10** build steps". Which ten items the founder was counting is **unverified** —
no enumerated ten-step list exists in the repo — and renumbering the work as P-01…P-12 does not
change the row's bar, which is *every build step landed*. If the count itself matters, it is a
founder question, not a team one.

## 6. Not in P-01…P-12 (named, so nothing is silent)

- **B-08 slice 6** — the dispatcher link page and its `DispatcherLinkSigner` (ledger row 64). Named
  and not built; it lands before B-08 closes, which means before P-05 can be the last B-08 step.
  Until it does, `exec/capability.ts` records the ask as `link_state: INTENT_RECORDED` and the §18.3
  demo step 5 ("dispatcher replies via link") has no URL.
- **B-13's remaining screens** — the dispatcher form and the setup / vehicle-config screens
  (`/setup` is a placeholder). The ramp iPad half is on main, and no AT in §4 is held up by the rest;
  whether the 12-step demo can be walked without a setup screen is **unverified**.
- **B-16 hardening** — §5. Paused by row 69, not dropped.
- **The live vendor call on a HIPAA endpoint** — row 68: the free model on demo data only is what is
  built, the compliant endpoint is sequenced and the endpoint choice is open. Real data needs a
  signed BAA first (ADR-000 #4/#12, ADR-015).
- **EXP-GRP-01** (real group-MMS behaviour) — open for the post-POC phase, not deferred scope
  (ledger row 46). P-06 is the mock fixture only.
- **P2 items B-19/B-20/B-21** — outside P1 by the PRD and the founder locks.

## 7. Risks

1. **Two ends of the agent are still unwired** (AT-01, AT-09): the inbound publisher and the
   production context assembler sit in B-08's page under "their own milestone", and P-05 is this
   plan naming an owner for them. If that placement is wrong, the two ATs have no step at all —
   which is the shrug row 63 took off the B-08 page, and worth catching now rather than at P-11.
2. **TEST-INF-01 has never run**, the ≤5 s bar is simulated with ~0.05 s of margin in the
   at-expiry corner (row 60), and P-05 is likely to void whatever runs precede it (§3). A FAIL
   points at QStash (row 22) and needs founder sign-off.
3. **One shared database** (rows 43, 45, 66): previews read it read-only, Reset and replay act on
   production by design, and the restart drill crashes consumers and restarts the compute. Two
   people demoing and drilling at once collide; hence the heads-up to Firia before run 1.
4. **Four steps are green fields** (P-06…P-09: B-05, B-06, B-07's importer, B-14) and they carry
   five ATs that are Not started. They are the least-known part of the remaining work.
5. **Review throughput:** Veri and Vera are the single gate on every step, and the 3-PR cap the old
   plan set still applies.
6. **Map tiles and routing:** OpenFreeMap's public instance has no SLA and may be discontinued
   without notice (ADR-008, row 50); OSRM data stays pre-baked fixtures (ADR-007, TEST-SEC-02).
