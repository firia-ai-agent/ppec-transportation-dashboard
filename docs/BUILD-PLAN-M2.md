# PPEC Transport Dashboard — build plan M2–M9 (PRD build to AT-01…18 PASS (mock))

**Status: Proposed (Rudy), for founder review.** Nothing here is decided until the founder (via Firia) approves it. Written 2026-10-14 ~14:40 ET at `main` after PR #12/#2.

```
READER: founder, Firia, Veri, Vera. DECISION IT SERVES: build order + ETAs for the rest of P1 (mock).
SOURCES: docs/PRD-v1.0.txt §14 (l.1054–1064), §18 (l.1325–1334), §20 backlog (l.1725–1846); docs/BUILD-PLAN.md; docs/LINEAR.md;
Linear team PPE (project "PPEC Transport Dashboard — POC (mock)", 45 issues read 2026-10-14 14:30 ET); /workspace M1-PLAN.md; DECISION-LEDGER rows 1–40.
```

## 0. Where we are (2026-10-14 14:30 ET)
- **Merged:** B-01 (PPE-9, #4), B-02 schema + 10 machines (PPE-10, #5), M1 Auth.js login (PPE-11 part, #6), B-03 scheduler/Queues/sweep + outbox + follow-ups (PPE-12, #7/#8/#12), docs #1/#3, design guide #2.
- **Open:** #9 infra docs (Veri FAIL, fix in progress), #10 Option A timer lease (Veri FAIL, fix in progress), #14 UI shell/tokens/DEMO banner (PPE-21 part), #15 Vera docs, #16 outbound free-text guard; #13 to be closed (founder 14:04 ET: one Neon DB, no preview branches).
- **Not yet PASS:** every AT/TEST issue (PPE-25…45). TEST-INF-01 (PPE-43) is unproven until #10 merges and a live run passes (Veri, #10 review).
- **Linear hygiene gap:** all 45 PPE issues still show **Backlog**, including the merged B-01/B-02/B-03. Linear has no blocking relations set; dependencies below come from docs/LINEAR.md "Deps" column (which mirrors PRD §20 l.1725–1809).

## 1. Assumptions behind the ETAs
1. All code via Claude Code CLI; Veri gates every PR (review ≈10–20 min, fix round ≈20–40 min); Vera gates every UI PR for taste.
2. One PR ≈ 60–120 min wall clock end to end (build + checks + Vercel preview + Veri review + one fix round). **Two parallel Claude Code tracks** (A: domain/agent, B: UI/fleet), ≈5–7 merged PRs per working day combined.
3. Working window 08:00–22:00 ET, every day including the weekend (Oct 17–18). If the team only works weekdays, add 2 days to every ETA from M5 on.
4. Previews share the single Neon DB `ep-divine-brook` (founder 14:04 ET), so no more "Resource provisioning failed" blocks.
5. OpenRouter key is in Vercel env (ledger row 20) before M3 starts.
6. ETAs are **estimates, Unverified**; PRD ED figures (l.1725–1809, 109 ED) assume human engineers + live integrations and are not used.
7. TEST-INF-01 needs 3 runs on separate days (ARCHITECTURE.md §7 / M1-PLAN §1), so the exit cannot be earlier than the 3rd day after #10 merges.

## 2. Milestones (critical-path order)
Order follows PRD l.1846 (B-04 → B-07/B-08/B-03 → B-12 → B-09/B-13 → B-10/B-11 → B-06 → B-14/B-15), with B-12 (screens) pulled forward because the founder asked for screens first and it runs in parallel from B-03 (BUILD-PLAN.md summary).

| M | Name | Tickets | ATs unlocked (to Veri) | Depends on | Track | ETA done (ET) |
|---|---|---|---|---|---|---|
| M2 | Live board + messaging simulation + seed slice | PPE-21 (B-12: shell #14, board SURF-01, drawer SURF-02, inbox SURF-03, exceptions SURF-05, SSE), PPE-17 (B-04 SIM + persona phones + consent), PPE-24 *seed slice only* (§18.1 dataset), PPE-14 (B-07), #10 → PPE-43 run 1 | AT-08 (PPE-32), AT-17 (PPE-40), AT-07 board half; TEST-INF-01 run 1 | B-03 merged; #10 PASS | A+B | **Thu Oct 15, 18:00** |
| M3 | Agent (live Claude Sonnet via OpenRouter, zdr:true) | PPE-19 (B-08: gateway, §11.2 tools, policy engine, injection evals), PPE-18 (B-05 mock fixture) | AT-01 (PPE-27), AT-02 (PPE-26), AT-06 (PPE-28), AT-07 (PPE-31), AT-09 (PPE-35), TEST-SEC-01 (PPE-45) | B-03, B-04, B-07, TEST-INF-01 (LINEAR.md:51) | A | **Fri Oct 16, 18:00** |
| M4 | Vehicles + ramp iPad | PPE-15 (B-09 solver V1–V4), PPE-22 (B-13 ramp iPad SURF-04, dispatcher form, setup/vehicle config) | AT-04 (PPE-25), AT-05 (PPE-30), AT-12 (PPE-34), AT-13 (PPE-36) | B-02, B-12 shell | B | **Fri Oct 16, 20:00** |
| M5 | Map, GPS simulator, routing/ETA | PPE-13 (B-10 simulator, LocationIngest, faults), PPE-20 (B-11 OSRM fixtures, traffic model, hysteresis), map pane in PPE-21 (ledger row 34; demo area 2216 Jog Rd, Greenacres FL, MOCKS-AND-DEMO §1) | AT-03 (PPE-29), AT-10 (PPE-33), AT-11 (PPE-38) | B-02; B-11 needs B-10 | A+B | **Sat Oct 17, 18:00** |
| M6 | Teams mock + therapist notify | PPE-16 (B-06 Teams panel, cards, 409 race) | AT-14 (PPE-37), AT-18 (PPE-42) | B-02, B-03, B-08 (agent drafts) | A | **Sat Oct 17, 21:00** |
| M7 | Ops + demo controls | PPE-23 (B-14 metrics, ROI SURF-07, health SURF-06, EOD), PPE-24 demo panel (reset & seed, replay, fault, restart drill; MOCKS-AND-DEMO §6), 12-step script §18.2 (l.1331) | AT-15 (PPE-39), AT-16 (PPE-41); demo script dry run | B-12; B-10 for replay/faults; B-03 for restart drill | B | **Sun Oct 18, 16:00** |
| M8 | B-16 hardening | PPE-11 rest: MFA for Credentials, login rate limit/lockout, server-side sign-out, absolute session cap, secret scanning, log scrubber, dep audit | TEST-SEC-02 (PPE-44, with B-08) | B-01 (M1 login merged) | A (slots between M3–M6 PRs) | **Sun Oct 18, 18:00** |
| M9 | Acceptance run | PPE-24 suite + evidence export; Veri runs AT-01…18 + TEST-INF-01 runs 2–3, TEST-SEC-01/02 | all 18 ATs at **PASS (mock)** + TEST-INF-01 | M2–M8 | Veri (+ fixes) | **Mon Oct 19, 18:00** (incl. one fix round) |

### Per-milestone exit evidence (what Veri checks)
- **M2:** preview URL + SHA; board shows the 28-row census (l.1327) from the §18.1 seed; drawer/inbox/exceptions per §14 (l.1058–1062) at iPad 768 px and desktop 1280 px against DESIGN-DIRECTION §10; WCAG AA contrast script green; SSE update visible without reload; persona phone sends/receives SIM SMS with STOP/HELP; Vera taste PASS; TEST-INF-01 run 1 log (50 timers, exactly-once, ≤5 s late).
- **M3:** agent run log per §18.3 AT list (l.1334): ≥1 autonomous state update + ≥1 autonomous follow-up (AGT-03); out-of-policy tool call rejected + logged (AGT-02); injection fixtures → zero sends (AT-09); prompt payload shows tokens only (TEST-SEC-01); OpenRouter request shows `zdr:true`; LLM-down degraded mode (l.1200) keyword parser works.
- **M4:** solver unit tests over V1–V4 layouts; AT-04 shows infeasible-before-boarding + approval request; AT-12 family not messaged until staff choose; AT-13 leg ends HELD_NO_RECEIVER with no auto-return.
- **M5:** map shows vans on Jog Rd route with four freshness bands (ledger row 30); duplicate/out-of-order positions ignored; 180 s stale badge + ETA texts suppressed, 600 s exception (LOC-03); replay of a delay is deterministic (AT-03); geofence → ARRIVED_*, never COMPLETED_HANDOFF (AT-10).
- **M6:** therapist card within 10 min of absence/delay overlap, ack tracked (NTF-03); card race returns 409 for the loser (AT-18).
- **M7:** ROI with drill-down and synthetic watermark (l.1064); EOD close blocked while custody states open (OPS-01); Reset → clean seed at 06:00 clock; Restart drill fire log.
- **M8:** checklist in PPE-11; lockout after N failures, MFA prompt, sign-out invalidates server session, session ends at cap.
- **M9:** Veri's evidence export per AT (PPE-24) with SHA + preview URL; Linear AT issues moved to Done **by Veri only** (LINEAR.md:11).

## 3. AT → milestone map
| AT | Linear | Builds in (PRD §20 / LINEAR.md) | Milestone |
|---|---|---|---|
| AT-01 message→state→notify | PPE-27 | B-04, B-08 | M3 |
| AT-02 timer follow-up + escalation | PPE-26 | B-03 (+B-08 agent) | M3 |
| AT-03 traffic delay, hysteresis, replay | PPE-29 | B-10, B-11 | M5 |
| AT-04 unknown equipment at arrival | PPE-25 | B-09, B-13 | M4 |
| AT-05 substitution | PPE-30 | B-09 | M4 |
| AT-06 sibling ambiguity | PPE-28 | B-08 | M3 |
| AT-07 leg vs full-day absence | PPE-31 | B-02, B-08 | M3 |
| AT-08 manual correction invalidates queued msg | PPE-32 | B-03, B-12 | M2 |
| AT-09 wrong recipient / injection | PPE-35 | B-04, B-07, B-08 | M3 |
| AT-10 geofence ≠ handoff | PPE-33 | B-10, B-13 | M5 |
| AT-11 duplicate/out-of-order + loss | PPE-38 | B-10 | M5 |
| AT-12 no feasible vehicle | PPE-34 | B-09 | M4 |
| AT-13 no receiving adult | PPE-36 | B-02, B-13 | M4 |
| AT-14 therapist ≤10 min + ack | PPE-37 | B-03, B-06 | M6 |
| AT-15 ROI drill-down | PPE-39 | B-14 | M7 |
| AT-16 EOD blocks close | PPE-41 | B-14 | M7 |
| AT-17 import, no name/DOB merge | PPE-40 | B-07 | M2 |
| AT-18 Teams proactive + card + race | PPE-42 | B-06 | M6 |
| TEST-INF-01 restart drill | PPE-43 | B-03 (#10) | run 1 M2, runs 2–3 M3/M5, final M9 |
| TEST-SEC-01 / 02 | PPE-45 / PPE-44 | B-07/B-08 / B-08/B-16 | M3 / M8 |

## 4. Risks
1. **TEST-INF-01 margin** (Veri, #10): worst case 5.00 s vs ≤5 s bar leaves zero margin; a fail triggers ledger row 22 (QStash), which needs founder sign-off. Blocks M3 per LINEAR.md:51.
2. **One shared DB** (founder 14:04 ET): previews and prod write the same data; a Reset on a preview wipes the prod demo; migrations on an unmerged PR hit prod's schema; concurrent Veri runs on two previews can collide.
3. **Agent scope** (B-08, PRD's biggest item, 14 ED l.1766; overrun risk l.2148): live LLM non-determinism can make AT-06/AT-09 flaky; OpenRouter cost under $100 cap (row 21).
4. **Review throughput:** ≈35–45 PRs remain; Veri/Vera are the single gate. FAIL rounds today ran ≈1 h each.
5. **Map tiles/routing free tier:** `NEXT_PUBLIC_MAP_TILE_URL` source not chosen; OSRM fixtures must be pre-baked (no live routing, no *.googleapis.com, TEST-SEC-02).
6. **Claude Code auth** expired once today and stopped all coding; recurs → plan slips.
7. **Linear statuses stale** (all Backlog) → founder dashboards misleading until updated.

## 5. Founder decisions needed (nothing deferred silently)
1. **Seed early:** OK to pull the §18.1 seed slice of B-15 (PPE-24) into M2 so the board isn't empty? (Full demo panel stays in M7.)
2. **Shared DB safety:** OK to make Reset/Replay/Restart drill **production-only** (or DIRECTOR-only with a confirm on previews), and to forbid destructive migrations in unmerged PRs?
3. **PASS (mock) bar:** confirm AT-03 "live" traffic delay, AT-18 Teams, and AT-01 SMS pass on mocks only (ADR-016), and that EXP-GRP-01 stays **open** (needs live Twilio, LINEAR.md:94).
4. **AT-13 procedure:** CA-04 (l.1953) still open; OK to use its default (hold, call all contacts, staff task, no auto-return)?
5. **Banner wording:** ledger row 40 records "DEMO" only (founder 13:18 ET) as an override of l.1332 "synthetic banner"; Vera's 2nd relay said it was still pending. Confirm row 40 is final.
6. **Working days:** may agents run Sat–Sun (Oct 17–18)? If not, exit moves to ≈Wed Oct 21.
7. **Map tiles:** which free tile source (OpenStreetMap-based) is acceptable for the demo?
8. **B-05 / EXP-GRP-01 effort:** keep B-05 as a mock fixture only (PPE-18) in M3?
9. **Linear:** may Rudy update PPE statuses (B-01/02/03 → Done-in-part) and add blocking relations matching §2?

## 6. Not in this plan (by PRD, not deferral)
P2 items B-19/B-20/B-21 (l.1819+, SEC-*, INT-* live connectors, BAA) are outside P1 per PRD §20 and founder locks; listed here so nothing is silent.
