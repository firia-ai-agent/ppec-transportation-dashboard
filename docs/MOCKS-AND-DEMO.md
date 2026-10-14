# Mocks and demo

```
READER: Rudy (build), Vera (UI/copy), Veri (demo acceptance). DECISION IT SERVES: what is simulated and how the 12-step demo runs.
SOURCE: PRD §18.1 dataset, §18.2 script; founder locks ADR-000 #5, #6. Coordinates: research/geocode.txt (Census + Photon, fetched 2026-10-14).
```

## Summary
- **Mocked (Decided by founder):** SMS/Twilio, Microsoft Teams, truck GPS + navigation, vehicle configurations. Every mock sits behind the same seam the real adapter will use (ADR-006/007/013), so a mock never leaks into domain code.
- **Real:** the database, the timers (Vercel Queues + cron), the SSE stream, auth/RBAC, and the agent (live Claude via OpenRouter on synthetic data).
- **Demo panel** (DIRECTOR only, `DEMO_MODE=1`, ADR-014): Reset, Clock, Replay, Faults, Persona phone, Teams panel, Evidence export.

## 1. Geography (all public places, no homes)
Center: **2216 Jog Rd, Greenacres FL 33415** → (26.645352, -80.145541), US Census geocoder.
| Child (family) | Pickup stop (landmark) | lat, lon | Need |
|---|---|---|---|
| C1 (F1) | Greenacres Branch Library | 26.622639, -80.145953 | car seat; AM self-drop |
| C2 (F2) | Okeeheelee Park | 26.652165, -80.164767 | WC fixed, L-track + lift; no-adult case |
| C3 (F3) | Greenacres City Hall | 26.607061, -80.135511 | ambulatory; T1 09:30 |
| C4, C5 (F4 shared number) | John Prince Park | 26.602482, -80.080532 | booster; car seat |
| C6 (F5) | Palm Beach State College, Lake Worth | 26.613772, -80.085865 | WC tilt + nurse escort; T2 PM |
| C7 (F6) | Lantana Public Library | 26.584699, -80.052871 | vest |
| C8 (F7) | Boynton Beach Mall | 26.535418, -80.095675 | ambulatory; shares C6 route (AT-04) |
| C9 (F8) | Mall at Wellington Green | 26.646683, -80.208099 | center van baseline |
| spare | Palm Beach Zoo | 26.667739, -80.069543 | fault-scenario detour target |
Stop labels show the landmark name. A seed linter (`scripts/seed-lint.mjs`) rejects any coordinate not in this table — **one narrow exception:** a `: Coord[] = [...]` literal is committed *road* geometry (ADR-007 OSRM fixtures), whose interior vertices are points on public roads rather than places. Those are linted instead by two rules of their own: both endpoints must sit on a landmark above (within 50 m, which covers OSRM's 7.4 m snap of the center onto Jog Rd), and every vertex must fall inside the landmark bounding box plus ~5.5 km. A coordinate anywhere else — a `coord:` field, a seed row, a config — must still be in this table verbatim.

## 2. Vehicles (PRD §18.1)
| Vehicle | Owner | Layouts (WC / ambulatory) |
|---|---|---|
| V1 convertible van | Provider P1 | {0WC/6A}, {1WC/3A}, {2WC/1A} |
| V3 substitute | P1 | {1WC/1A} |
| V4 sedan | Provider P2 | {0WC/3A} |
| V2 center van | Center | {1WC/4A} |
Vehicle setup screen edits `vehicle_layout` / `layout_position` (securement type, max chair dims); "unknown until arrival" is the default state each day (capability UNKNOWN).

## 3. Messaging mock
- **Persona phones:** F1–F8 each get a phone-style panel. Numbers: +1-561-555-0101 … +1-561-555-0108 (555-01xx is reserved for fiction). F4 is one number for C4+C5.
- **Outbound:** outbox → `MessagingProvider.SIM` → message appears in the persona phone with status QUEUED→SENT→DELIVERED (simulated delay 1–3 s, deterministic from seed).
- **Inbound:** typing in a persona phone posts to `/api/webhooks/sms` with the same body shape as Twilio form posts and a sim HMAC header; the handler path is identical to live.
- **Keywords:** STOP/START/HELP and natural-language opt-out work against the consent ledger.
- **Faults:** delivery failure, delayed delivery, duplicate inbound webhook, out-of-order inbound.

## 4. Teams mock
A Teams-style side panel per staff role shows proactive messages and adaptive-card-like approval cards (`ops.teams_activity`). Two browser sessions (coordinator + director) can click Approve on the same card to show the "already decided" race (AT-18 / PRD 409).

## 5. Trucks, routes, GPS
- Route geometry: fixtures precomputed from public OSRM once and committed (`fixtures/routes/*.json`); example probe Okeeheelee Park → center: 2,740 m, 228 s (research/osrm-probe.txt).
- Simulator emits a point every 5 simulated seconds per bound device through `LocationIngest`.
- Map: MapLibre + OpenFreeMap vector tiles, style `positron` (ADR-008, DESIGN-DIRECTION §5.1), style URL in `NEXT_PUBLIC_MAP_TILE_URL`; truck icons colored by staleness (fresh / STALE at 180 s / exception at 600 s), always with a freshness label so colour is never the only cue.
- **Fault buttons:** Stall (vehicle stops N min at current point), Traffic band (×1.5 travel time), GPS gap (stop emitting), Jitter (±40 m noise; must not trigger ETA text), Duplicate/out-of-order points, Unbound device.
- **Replay:** pick a recorded `sim_run`, speed ×1/×5/×20; replay is deterministic (same seed ⇒ same ETA events, AT-03).

## 6. Demo panel buttons
| Button | Effect | Guard |
|---|---|---|
| Reset & seed | Truncate ops (not identity config), reseed §18.1, clock = 06:00 today, census pad to 28 | confirm dialog; DIRECTOR |
| Clock: play / pause / ×1 / ×10 / ×60 / jump to | Moves `scenario_clock`; jobs use scenario time in SIM | jobs re-armed on jump |
| Replay run | Load a `sim_run` | |
| Faults (list in §5, §3) | Inject one fault on a chosen vehicle/persona | logged as `source_mode=SIMULATED` |
| Restart drill | Calls TEST-INF-01 harness (ARCHITECTURE §7): schedules 50 timers, triggers a redeploy-style re-arm and stale-claim reclaim | shows the fire log |
| Export evidence | Zip: test log, DB diffs, message-status table, timer log (`job_fire_log`), agent transcripts, Teams activity ids | |

## 7. 12-step script on the mocks (PRD §18.2)
| Step | PRD | On this stack |
|---|---|---|
| 1 | Reset/seed; banner | Reset button; "DEMO" banner always on (ledger row 40, supersedes D-1 text) |
| 2 | F1 AM self-drop | Type in F1 phone; board updates via SSE (<2 s target, measured) |
| 3 | F4 sick, ambiguity | Agent asks which child; "both" → both absent |
| 4 | F3 absence → T1 ≤10 min | Teams mock to T1; ack timer job |
| 5 | T−90 capability request | Clock ×60; dispatcher link opened in second tab |
| 6 | Ramp {1WC,1AMB} infeasible | Ramp screen; RED exception; Teams card; two-approver race |
| 7 | Live drive (Traccar) + stall | **Adapted:** simulated drive + Stall fault (founder chose mocked trucks); Traccar step not run |
| 8 | GPS gap 180/600 s | GPS gap fault |
| 9 | Injection | Typed in F-phone; zero sends asserted from outbox |
| 10 | STOP while queued | STOP in F2 phone while an ETA row is QUEUED |
| 11 | kill -9 api + worker | **Adapted:** Restart drill (ARCHITECTURE §7 crash A–D); local Docker `kill -9` variant in CI |
| 12 | EOD close blocked; ROI; export | Clock to 17:30; Export evidence. Twilio SIDs / real Teams ids not available (mocks) |
