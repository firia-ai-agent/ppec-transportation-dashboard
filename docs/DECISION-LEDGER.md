# Decision ledger

Source of truth for founder decisions. Times are ET (America/New_York). Labels: Decided by founder / Accepted by default / Proposed.

| # | Date / time ET | Decision | Label | Source |
|---|---|---|---|---|
| 1 | 2026-10-14 11:05 | "Fulfillment" = fulfilling each child's approved transport needs | Decided by founder | founder chat answers 1–9 (answer 1) |
| 2 | 2026-10-14 11:05 | Product name "PPEC transportation dashboard" | Decided by founder | answer 2 |
| 3 | 2026-10-14 11:05 | Hosting: Vercel team firia1 + Neon now; AWS later behind seams | Decided by founder | answer 3 + kickoff message |
| 4 | 2026-10-14 11:05 | Live agent via OpenRouter (founder supplies key); synthetic data only | Decided by founder | answer 4 |
| 5 | 2026-10-14 11:05 | Simulation centered on 2216 Jog Rd, Greenacres FL 33415 area; public landmarks only | Decided by founder | answer 5 |
| 6 | 2026-10-14 11:05 | Brand-new Notion and Linear; new private repo under firia-ai-agent | Decided by founder | answer 6 |
| 7 | 2026-10-14 11:05 | FQ-01–FQ-12 PRD defaults accepted | Accepted by default | answer 7 |
| 8 | 2026-10-14 11:05 | Auth.js for the POC | Decided by founder | answer 8 |
| 9 | 2026-10-14 11:05 | Team: Athena (research), Rudy (build), Veri (verify), Vera (UI/copy) | Decided by founder | answer 9 |
| 10 | 2026-10-14 (kickoff) | Mock SMS/Twilio, Teams, truck locations/navigation, vehicle configs; demo reset/replay buttons | Decided by founder | kickoff message |
| 11 | 2026-10-14 11:23 | Spec approved | Decided by founder | founder chat |
| 12 | 2026-10-14 11:23 | POC exit = AT-01–AT-18 + TEST-INF-01 all PASS (mock); mock must be excellent | Decided by founder | founder chat (ADR-016) |
| 13 | 2026-10-14 11:23 | $100/month spend alert across Vercel, Neon, OpenRouter (only OpenRouter expected to cost) | Decided by founder | founder chat (ADR-016) |
| 14 | 2026-10-14 11:23 | Model: Claude Sonnet (current) via OpenRouter, zdr:true | Decided by founder | founder chat (ADR-005) |
| 15 | 2026-10-14 11:23 | Version control + docs are the source of truth, stood up now | Decided by founder | founder chat |
| 16 | 2026-10-14 11:40 | TEST-SEC-01 (token-only prompts) and TEST-SEC-02 (egress) are required for the POC exit, in addition to the ADR-016 bar; awaiting founder confirmation | Accepted by default | PR #1 review (Veri) item 6; docs/LINEAR.md |

All other decisions in docs/adr are Proposed unless labeled otherwise.

## Repo governance record
- 2026-10-14 ~11:30 ET: branch protection on `main` **not available**. GitHub returned HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." for both branch protection and rulesets (free plan, private personal repo). Working rule until upgraded: no force-push to main, changes via PR reviewed by Veri.
