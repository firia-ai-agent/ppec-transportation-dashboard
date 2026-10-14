# PPEC transportation dashboard

Transport fulfillment, attendance, family communication and scheduling for a pediatric prescribed extended care (PPEC) center serving children with disabilities. "Fulfillment" = fulfilling each child's approved transport needs.

**Status (2026-10-14):** spec approved by founder; no application code yet. Synthetic data only — no real child, family or staff data may enter this repo or its environments.

## Founder locks (full list: [docs/DECISION-LEDGER.md](docs/DECISION-LEDGER.md))
- Vercel (team firia1) + Neon now; AWS later behind seams
- Live agent: Claude Sonnet (current) via OpenRouter, `zdr:true`, token-only gateway
- Mocked SMS/Twilio, Teams, truck GPS/navigation, vehicle configs; demo reset/replay/fault controls
- Simulation centered on 2216 Jog Rd, Greenacres FL 33415 (public landmarks only)
- Auth.js with real RBAC and site scoping
- POC exit: AT-01–AT-18 + TEST-INF-01 all PASS (mock)
- $100/month spend alert
- Team: Athena (research), Rudy (build), Veri (verify), Vera (UI/copy)

## Environments & links

No secrets here. Values live only in Vercel env vars.

| What | Where |
|---|---|
| GitHub repo | https://github.com/firia-ai-agent/ppec-transportation-dashboard |
| Vercel project | https://vercel.com/firia1/ppec-transportation-dashboard |
| Prod URL | https://ppec-transportation-dashboard.vercel.app (TBC: confirm after first prod deploy) |
| Database | Neon store `ppec-transportation-dashboard` (iad1, Free plan, via the Vercel integration): prod on the `main` branch, one Neon branch per preview |
| Linear | https://linear.app/tokos/project/ppec-transport-dashboard-poc-mock-c71244c967e7 |
| Notion | https://app.notion.com/p/3f9ac450cdc181cda2becad4340b6833 |

## Docs
- [PRD v1.0](docs/PRD-v1.0.txt)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA-MODEL.md) · [schema draft](docs/schema-draft.ts)
- [ADRs](docs/adr/)
- [Mocks & demo](docs/MOCKS-AND-DEMO.md)
- [Build plan](docs/BUILD-PLAN.md)
- [Risks & questions](docs/RISKS-AND-QUESTIONS.md)
- [Tokos reuse](docs/TOKOS-REUSE.md)
- [Research evidence](docs/research/)

## Development (B-01 scaffold)
```
pnpm install
APP_DATA_CLASS=SYNTHETIC pnpm dev     # boot refuses any other data class (ADR-015)
pnpm typecheck && pnpm lint && pnpm test && pnpm seed:lint
```
Health: `GET /api/health` returns the deployed commit, environment and data class. Infra state: `INFRA-BASELINE.md`, `DATABASES.md`, `INFRA-TEMP.md`.
