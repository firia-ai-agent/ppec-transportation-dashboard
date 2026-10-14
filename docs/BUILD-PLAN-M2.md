# PPEC Transport Dashboard — build plan M2–M9 (PRD build to AT-01…18 PASS (mock))

**Status: Proposed (Rudy), for founder review.** Only the §5 founder answers are accepted (Firia relay 2026-10-14 14:08 ET; ledger rows 44–52); everything else, including milestones and ETAs, stays Proposed. ETAs are estimates (Unverified). First written 2026-10-14 14:07 ET (commit 65fcff0); revised 14:17 ET for Veri's FAIL on #17 and Firia's decision at 14:15 ET.

```
READER: founder, Firia, Veri, Vera. DECISION IT SERVES: build order + ETAs for the rest of P1 (mock).
SOURCES: PRD v1.0 (Notion mirror https://app.notion.com/p/3f9ac450cdc181869b84e78d6868b6a7; repo copy docs/PRD-v1.0.txt, same § numbers; l.NNN = line in the repo copy) §14 (l.1054–1064), §18 (l.1325–1334), §20 backlog (l.1725–1846); docs/BUILD-PLAN.md; docs/LINEAR.md;
Linear team PPE (project "PPEC Transport Dashboard — POC (mock)", 45 issues read 2026-10-14 ~14:00 ET); /workspace M1-PLAN.md; DECISION-LEDGER rows 1–40.
```

## 0. Where we are (2026-10-14 14:05 ET)
- **Merged:** B-01 (PPE-9, #4), B-02 schema + 10 machines (PPE-10, #5), M1 Auth.js login (PPE-11 part, #6), B-03 scheduler/Queues/sweep + outbox + follow-ups (PPE-12, #7/#8/#12), docs #1/#3, design guide #2.
- **Open:** #9 infra docs (Veri FAIL, fix in progress), #10 Option A timer lease (Veri FAIL, fix in progress), #14 UI shell/tokens/DEMO banner (PPE-21 part), #15 Vera docs, #16 outbound free-text guard; #13 to be closed (founder 14:04 ET: one Neon DB, no preview branches).
- **Not yet PASS:** every AT/TEST issue (PPE-25…45). TEST-INF-01 (PPE-43) is unproven until #10 merges and a live run passes (Veri, #10 review).
- **Linear hygiene gap:** all 45 PPE issues still show **Backlog**, including the merged B-01/B-02/B-03. Linear has no blocking relations set; dependencies below come from docs/LINEAR.md "Deps" column (which mirrors PRD §20 l.1725–1809).

## 1. Assumptions behind the ETAs
1. All code via Claude Code CLI; Veri gates every PR (review ≈10–20 min, fix round ≈20–40 min); Vera gates every UI PR for taste.
2. One PR ≈ 60–120 min wall clock end to end (build + checks + Vercel preview + Veri review + one fix round). **Three parallel Claude Code tracks** (≈7–9 merged PRs per working day combined), each in its own clone, no shared files without a hand-off:
   - **Track A — screens:** PPE-21 shell/board/drawer/inbox/exceptions/SSE (#14 onward), then PPE-22 ramp iPad/setup screens (M4 UI), M7 demo-panel UI.
   - **Track B — domain:** M2 seed slice (PPE-24 part), PPE-17 SIM messaging, PPE-14 identity; then M3 agent (PPE-19, PPE-18), M6 Teams (PPE-16), M8 B-16 (PPE-11), M7 ops backend (PPE-23, PPE-24).
   - **Track C — fleet + map:** M4 solver (PPE-15) and M5 GPS simulator/routing/map pane (PPE-13, PPE-20, map in PPE-21), starting now in parallel with M2 (deps are B-02 only, LINEAR.md:52–54).
   - Infra (#9/#10/#18) is a separate owner; Veri gates every PR, Vera gates every UI PR.
3. Working window 08:00–22:00 ET, every day including the weekend (Oct 17–18) — weekends included (row 49).
4. Founder directive 14:04 ET: one Neon DB (`ep-divine-brook`), no per-preview branch. Infra PR #18 (previews never migrate or seed; preview DB sessions read-only; cron/queue routes no-op on previews; ledger row 43) **merged to main at bdbba05**; per Firia's decision at 14:15 ET the one-DB switch counts only once Veri verifies #18 on screen (pending). INFRA-BASELINE.md, DATABASES.md and README.md:26 are corrected by the infra track against #18 (pending Veri verification).
5. OpenRouter key is in Vercel env (ledger row 20) before M3 starts.
6. ETAs are **estimates, Unverified**; PRD ED figures (l.1725–1809, 109 ED) assume human engineers + live integrations and are not used.
7. TEST-INF-01 needs 3 runs on separate days (ARCHITECTURE.md §7 / M1-PLAN §1). Schedule: #10 merges Thu Oct 15 AM → run 1 Thu Oct 15, run 2 Fri Oct 16, run 3 Sat Oct 17; Veri re-runs once in M9 (Mon Oct 19) on the release SHA. A FAIL on any run restarts the count and moves the exit.
8. **Nothing is deferred** (Firia decision 2026-10-14 14:15 ET): B-16 encryption (PRD l.1806) is in M8 and the B-15 runbook (l.1801) is in M9, both inside the Mon Oct 19 date.

## 2. Milestones (critical-path order)
Order follows PRD l.1846 (B-04 → B-07/B-08/B-03 → B-12 → B-09/B-13 → B-10/B-11 → B-06 → B-14/B-15), with B-12 (screens) pulled forward because the founder asked for screens first and it runs in parallel from B-03 (BUILD-PLAN.md summary).

| M | Name | Tickets | ATs unlocked (to Veri) | Depends on | Track | ETA done (ET) |
|---|---|---|---|---|---|---|
| M2 | Live board + messaging simulation + seed slice (seed slice moved into M2, row 44) | PPE-21 (B-12: shell #14, board SURF-01, drawer SURF-02, inbox SURF-03, exceptions SURF-05, SSE), PPE-17 (B-04 SIM + persona phones + consent), PPE-24 *seed slice only* (§18.1 dataset), PPE-14 (B-07), PPE-43 run 1 | AT-08 (PPE-32), AT-17 (PPE-40), AT-07 board half; TEST-INF-01 run 1 | **Entry gate: infra #18 merged + Veri-verified** (single DB; no seed on previews); B-03 merged. Only TEST-INF-01 run 1 is gated on #10 | A+B | **Thu Oct 15, 18:00** |
| M3 | Agent (live Claude Sonnet via OpenRouter, zdr:true) | PPE-19 (B-08: gateway, §11.2 tools, policy engine, injection evals), PPE-18 (B-05 mock fixture) | AT-01 (PPE-27), AT-02 (PPE-26), AT-06 (PPE-28), AT-07 (PPE-31), AT-09 (PPE-35), TEST-SEC-01 (PPE-45) | B-03, B-04, B-07, TEST-INF-01 (LINEAR.md:51) | B | **Fri Oct 16, 18:00** |
| M4 | Vehicles + ramp iPad | PPE-15 (B-09 solver V1–V4), PPE-22 (B-13 ramp iPad SURF-04, dispatcher form, setup/vehicle config) | AT-04 (PPE-25), AT-05 (PPE-30), AT-12 (PPE-34), AT-13 (PPE-36) | B-02, B-12 shell | C (solver) + A (ramp/setup screens) | **Fri Oct 16, 20:00** |
| M5 | Map, GPS simulator, routing/ETA | PPE-13 (B-10 simulator, LocationIngest, faults), PPE-20 (B-11 OSRM fixtures, traffic model, hysteresis), map pane in PPE-21 with MapLibre GL + OpenFreeMap vector tiles (row 50; ledger row 34; demo area 2216 Jog Rd, Greenacres FL, MOCKS-AND-DEMO §1) | AT-03 (PPE-29), AT-10 (PPE-33), AT-11 (PPE-38) | B-02; B-11 needs B-10 | C | **Sat Oct 17, 18:00** |
| M6 | Teams mock + therapist notify | PPE-16 (B-06 Teams panel, cards, 409 race) | AT-14 (PPE-37), AT-18 (PPE-42) | B-02, B-03 (AT-14 does **not** need the agent: NTF-03 overlap detection + ack timer is deterministic, LINEAR.md:86 deps B-03/B-06) | B | **Sat Oct 17, 21:00** |
| M7 | Ops + demo controls | PPE-23 (B-14 metrics, ROI SURF-07, health SURF-06, EOD), PPE-24 demo panel (reset & seed, replay, fault, restart drill; MOCKS-AND-DEMO §6), 12-step script §18.2 (l.1331) | AT-15 (PPE-39), AT-16 (PPE-41); demo script dry run | B-12; B-10 for replay/faults; B-03 for restart drill | B (backend) + A (panel UI) | **Sun Oct 18, 16:00** |
| M8 | B-16 hardening | PPE-11 rest: MFA for Credentials, login rate limit/lockout, server-side sign-out, absolute session cap, **encryption** (PRD l.1806 B-16 "MFA, encryption, log scrubber, scanners": AES-GCM field encryption at rest for identity columns, TLS-only, Neon at-rest encryption recorded), secret scanning, log scrubber, dep audit | TEST-SEC-02 (PPE-44, with B-08) | B-01 (M1 login merged) | B (slots between M3–M6 PRs) | **Sun Oct 18, 18:00** |
| M9 | Acceptance run | PPE-24 suite + evidence export + **runbook** (PRD l.1801 B-15 "acceptance suite, demo reset/replay, evidence export, runbook"); Veri runs AT-01…18 + TEST-INF-01 final run on release SHA, TEST-SEC-01/02 | all 18 ATs at **PASS (mock)** + TEST-INF-01 | M2–M8 | Veri (+ fixes) | **Mon Oct 19, 18:00** (incl. one fix round) |

### Per-milestone exit evidence (what Veri checks)
- **M2:** preview URL + SHA; board shows the 28-row census (l.1327) from the §18.1 seed; drawer/inbox/exceptions per §14 (l.1058–1062) at iPad 768 px and desktop 1280 px against DESIGN-DIRECTION §10; WCAG AA contrast script green; SSE update visible without reload; persona phone sends/receives SIM SMS with STOP/HELP; Vera taste PASS; **role + ID-swap checks** (BUILD-PLAN.md §4 matrix: same-site role 403, other site 404, SSE scoped to session site, F1 asking about C2 → zero sends) green for every new route; #18 verification note from Veri; TEST-INF-01 run 1 log (50 timers, exactly-once, ≤5 s late).
- **M3:** agent run log per §18.3 AT list (l.1334): ≥1 autonomous state update + ≥1 autonomous follow-up (AGT-03); out-of-policy tool call rejected + logged (AGT-02); injection fixtures → zero sends (AT-09); prompt payload shows tokens only (TEST-SEC-01); OpenRouter request shows `zdr:true`; LLM-down degraded mode (l.1200) keyword parser works.
- **M4:** solver unit tests over V1–V4 layouts; AT-04 shows infeasible-before-boarding + approval request; AT-12 family not messaged until staff choose; AT-13 leg ends HELD_NO_RECEIVER with no auto-return.
- **M5:** map shows vans on Jog Rd route with four freshness bands (ledger row 30); duplicate/out-of-order positions ignored; 180 s stale badge + ETA texts suppressed, 600 s exception (LOC-03); replay of a delay is deterministic (AT-03); geofence → ARRIVED_*, never COMPLETED_HANDOFF (AT-10).
- **M6:** therapist card within 10 min of absence/delay overlap, ack tracked (NTF-03); card race returns 409 for the loser (AT-18).
- **M7:** ROI with drill-down and synthetic watermark (l.1064); EOD close blocked while custody states open (OPS-01); Reset → clean seed at 06:00 clock; Restart drill fire log.
- **M8:** checklist in PPE-11; encryption evidence (ciphertext in DB for identity columns, key only in env); lockout after N failures, MFA prompt, sign-out invalidates server session, session ends at cap.
- **M9:** runbook in docs/ (reset, replay, faults, restart drill, recovery) dry-run by Veri; Veri's evidence export per AT (PPE-24) with SHA + preview URL; Linear AT issues moved to Done **by Veri only** (LINEAR.md:11).

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
| TEST-INF-01 restart drill | PPE-43 | B-03 (#10) | run 1 Thu Oct 15 (M2), run 2 Fri Oct 16 (M3), run 3 Sat Oct 17 (M5/M6), final re-run Mon Oct 19 (M9) |
| TEST-SEC-01 / 02 | PPE-45 / PPE-44 | B-07/B-08 / B-08/B-16 | M3 / M8 |

## 4. Risks
1. **TEST-INF-01 margin** (Veri, #10): worst case 5.00 s vs ≤5 s bar leaves zero margin; a fail triggers ledger row 22 (QStash), which needs founder sign-off. Blocks M3 per LINEAR.md:51.
2. **One shared DB** (founder 14:04 ET, held until #18 per Firia 14:15 ET): after #18, previews and prod write the same data; Reset/replay act on the one prod DB by design (row 45), so a Reset during a Veri run wipes it; #18 (merged bdbba05) stops preview migrate/seed, pending Veri verification; migrations on an unmerged PR hit prod's schema; concurrent Veri runs on two previews can collide.
3. **Agent scope** (B-08, PRD's biggest item, 14 ED l.1766; overrun risk l.2148): live LLM non-determinism can make AT-06/AT-09 flaky; OpenRouter cost under $100 cap (row 21).
4. **Review throughput:** ≈35–45 PRs remain; Veri/Vera are the single gate. FAIL rounds today ran ≈1 h each.
5. **Map tiles/routing:** OpenFreeMap public instance has no SLA and may be discontinued without notice (ToS); OSRM fixtures must be pre-baked (no live routing, no *.googleapis.com, TEST-SEC-02).
6. **Claude Code auth** expired once today and stopped all coding; recurs → plan slips.
7. **Linear statuses stale** (all Backlog) → founder dashboards misleading until updated.

## 5. Founder answers (Firia relay 2026-10-14 14:08 ET)
| # | Question | Answer | Ledger |
|---|---|---|---|
| 1 | Seed early | B-15 §18.1 seed slice moves into M2 (full demo panel stays M7) | 44, Accepted by default (Firia, within founder locks) |
| 2 | Shared DB safety | Reset and replay act on the one prod DB (synthetic data; founder already decided reset buttons on prod). Target rule: scenario seed runs only via the Reset/seed path, never in preview builds; enforced by #18 (merged bdbba05; Veri verification pending) | 45, Decided by founder |
| 3 | PASS (mock) bar | ATs pass on mocks per the founder mock override (ADR-016); EXP-GRP-01 is **OPEN for the post-POC phase**, not deferred scope | 46, Decided by founder |
| 4 | AT-13 procedure | CA-04 default (l.1953): hold, call all contacts, staff task, no auto-return (founder accepted the FQ defaults) | 47, Decided by founder |
| 5 | Banner | Final: exactly "DEMO" everywhere, screen-reader label included (founder 13:18 and 13:30 ET; row 40) | 48, Decided by founder |
| 6 | Weekends | Included | 49, Accepted by default (Firia, within founder locks) |
| 7 | Map tiles | MapLibre GL + OpenFreeMap public vector tiles, style `positron` (DESIGN-DIRECTION §5.1, PR #15), style URL in one env var `NEXT_PUBLIC_MAP_TILE_URL` = `https://tiles.openfreemap.org/styles/positron` (OSM data, no key). Attribution required: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (MapLibre adds it automatically; keep the attribution control visible). Commercial use allowed; no keys/cookies; offline downloads capped at 3,000 tiles/50 MB, ≤4 parallel requests, unique User-Agent; as-is, no SLA, may be discontinued without notice; Cloudflare CDN; Hungarian law. Sources: https://openfreemap.org/ and https://openfreemap.org/tos/ (ToS "Last Updated: October 14, 2026", read 2026-10-14 ~14:10 ET); OSM data licence ODbL: https://www.openstreetmap.org/copyright | 50, Accepted by default (Firia, within founder locks) |
| 8 | B-05 | Mock-only (PPE-18) | 51, Accepted by default (Firia, within founder locks) |
| 9 | Linear | Kept in sync with PRs (statuses + blocking relations per LINEAR.md Deps) | 52, Accepted by default (Firia, within founder locks) |

## 6. Not in this plan (by PRD, not deferral)
P2 items B-19/B-20/B-21 (l.1819+, SEC-*, INT-* live connectors, BAA) are outside P1 per PRD §20 and founder locks; listed here so nothing is silent.
